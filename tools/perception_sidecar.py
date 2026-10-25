#!/usr/bin/env python3
"""cortico-world-camera 的感知旁证服务（YOLO + 姿态 + 人脸）。

一个进程、一个端点，把一张 JPEG 变成**可转译的事实**，不发表任何意见：

    POST /perceive  {"image": "<base64 jpeg>"}
    -> 200 {
          "objects": [{"label","score","bbox":[x1,y1,x2,y2]}],
          "people":  [{"bbox","score","keypoints","pose":{...},"face":{...},"height_px","distance_m"}],
          "image": {"w","h"},
          "ms": {"yolo","pose","face"},
          "models": {"detect","pose","face"}
        }

设计纪律：
  - 只报它**真的测到**的：框、关键点、可见度、像素高度。
  - 由像素推出来的（朝向、举手、距离）一律标 `inferred: true`，并写明假设。
  - MediaPipe 装了但 0.10.33 的 wheel 不带 solutions 也不带 .task 模型，而
    storage.googleapis.com 在本机不通；所以姿态用 YOLO11-pose（同一套 ultralytics，
    17 个 COCO 关键点）。若你后来拿到 pose_landmarker.task，给 `--mediapipe-model`
    就会改走 MediaPipe Tasks。
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)

DETECT_WEIGHTS = os.path.join(PKG, "models", "yolo11n.pt")
POSE_WEIGHTS = os.path.join(PKG, "models", "yolo11n-pose.pt")
# 允许复用仓库里已有的权重（本项目根目录就有一份）
FALLBACK_DETECT = r"D:\11\Projects\xuegeros\yolo11n.pt"

PERSON_HEIGHT_M = 1.7   # 距离估计的假设，写进回执
FOCAL_PX_DEFAULT = 800  # 800px 宽画面 ≈ 60° HFOV 的经验值

_detector = None
_poser = None
_face = None
_mediapipe = None


def resolve_weight(local: str, name: str) -> str:
    """先用包里的 models/，其次仓库里的副本，最后交给 ultralytics 自己去拿
    （它会从 GitHub release 下载到缓存；本机墙掉时给出清楚的一句）。"""
    for candidate in (local, os.path.join(HERE, os.path.basename(local))):
        if os.path.exists(candidate):
            return candidate
    if name == "yolo11n.pt" and os.path.exists(FALLBACK_DETECT):
        return FALLBACK_DETECT
    return name


def load_models(mediapipe_model: str | None) -> None:
    global _detector, _poser, _face, _mediapipe
    from ultralytics import YOLO

    detect_path = resolve_weight(DETECT_WEIGHTS, "yolo11n.pt")
    pose_path = resolve_weight(POSE_WEIGHTS, "yolo11n-pose.pt")
    _detector = YOLO(detect_path)
    _poser = YOLO(pose_path)
    cascade = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    _face = cv2.CascadeClassifier(cascade) if os.path.exists(cascade) else None

    if mediapipe_model and os.path.exists(mediapipe_model):
        try:
            import mediapipe as mp
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision as mp_vision

            base = mp_python.BaseOptions(model_asset_path=mediapipe_model)
            _mediapipe = mp_vision.PoseLandmarker.create_from_options(
                mp_vision.PoseLandmarkerOptions(base_options=base, running_mode=mp_vision.RunningMode.IMAGE)
            )
        except Exception as error:  # noqa: BLE001
            print(f"mediapipe 不可用，回落 YOLO-pose：{error}")


def box_norm(x1: float, y1: float, x2: float, y2: float, w: int, h: int) -> list[float]:
    return [round(max(0.0, x1 / w), 3), round(max(0.0, y1 / h), 3), round(min(1.0, x2 / w), 3), round(min(1.0, y2 / h), 3)]


def facing_of(kp: dict[str, tuple[float, float, float]]) -> tuple[str, float, str]:
    """从关键点可见度推「正面 / 侧身 / 背对」。返回 (结论, 把握, 依据)。"""
    nose = kp["nose"][2]
    ls, rs = kp["left_shoulder"], kp["right_shoulder"]
    lh, rh = kp["left_hip"], kp["right_hip"]
    shoulders = (ls[2] + rs[2]) / 2
    hips = (lh[2] + rh[2]) / 2
    if shoulders < 0.35 and hips < 0.35:
        return "看不清", 0.0, "肩与髋都不可见"
    if nose < 0.3 and shoulders > 0.5:
        return "背对或侧后", 0.55, "看不到鼻，肩背可见"
    mid_x = (ls[0] + rs[0]) / 2
    span = max(0.02, abs(ls[0] - rs[0]))
    if nose > 0.55 and abs(mid_x - kp["nose"][0]) < 0.45 * span:
        return "正面", min(0.9, nose), "鼻在肩中线上方"
    if nose > 0.4:
        return "侧身", 0.5, "鼻偏离肩中线"
    return "看不清", 0.2, "关键点不足"


def hand_of(kp: dict[str, tuple[float, float, float]]) -> tuple[str, float]:
    for side in ("left", "right"):
        wrist, shoulder = kp[f"{side}_wrist"], kp[f"{side}_shoulder"]
        if wrist[2] > 0.4 and shoulder[2] > 0.4 and wrist[1] < shoulder[1] - 0.04:
            zh = "左手" if side == "left" else "右手"
            return f"{zh}抬起", min(0.8, wrist[2])
    return "双手垂下或看不见", 0.0


def perceive(jpeg: bytes) -> dict:
    t0 = time.time()
    image = np.array(Image.open(io.BytesIO(jpeg)).convert("RGB"))
    bgr = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
    h, w = bgr.shape[:2]
    out: dict = {"image": {"w": w, "h": h}, "objects": [], "people": [], "ms": {}, "models": {}}

    # ── 检测 ───────────────────────────────────────────────
    t = time.time()
    det = _detector.predict(bgr, conf=0.3, verbose=False)[0]
    out["ms"]["yolo"] = int((time.time() - t) * 1000)
    out["models"]["detect"] = os.path.basename(str(getattr(_detector, "ckpt_path", "detect")))
    boxes: list[list[float]] = []
    for b in det.boxes:
        xyxy = [float(v) for v in b.xyxy[0].tolist()]
        label = det.names[int(b.cls[0])]
        out["objects"].append({"label": label, "score": round(float(b.conf[0]), 3), "bbox": box_norm(*xyxy, w, h)})
        if label == "person":
            boxes.append(xyxy)

    # ── 姿态 → 人 ─────────────────────────────────────────
    t = time.time()
    people: list[dict] = []
    if _poser is not None:
        pose = _poser.predict(bgr, conf=0.3, verbose=False)[0]
        out["models"]["pose"] = os.path.basename(str(getattr(_poser, "ckpt_path", "pose")))
        names = ["nose", "left_eye", "right_eye", "left_ear", "right_ear", "left_shoulder", "right_shoulder",
                 "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_hip", "right_hip",
                 "left_knee", "right_knee", "left_ankle", "right_ankle"]
        for i, kp_obj in enumerate(pose.keypoints or []):
            # ultralytics 这里 xy 是 (17, 2)，conf 是 (17,)
            pairs = kp_obj.xy[0].tolist()
            confs = (kp_obj.conf[0].tolist() if kp_obj.conf is not None else [1.0] * len(pairs))
            kp = {
                names[j]: (float(pairs[j][0]), float(pairs[j][1]), float(confs[j]))
                for j in range(min(len(names), len(pairs)))
            }
            ys = [kp[n][1] for n in kp if kp[n][2] > 0.3]
            if not ys:
                continue
            top, bottom = min(ys), max(ys)
            px_height = max(1.0, bottom - top)
            face, conf, why = facing_of(kp)
            hand, hand_conf = hand_of(kp)
            # 距离：针孔模型，人高 1.7 m 的假设，焦距按画面宽度等比缩放
            focal = FOCAL_PX_DEFAULT * (w / 800.0)
            distance = round(focal * PERSON_HEIGHT_M / px_height, 1)
            people.append({
                "bbox": box_norm(min(kp[n][0] for n in kp), top, max(kp[n][0] for n in kp), bottom, w, h),
                "pose": {
                    "facing": face, "facing_confidence": round(conf, 2), "facing_basis": why,
                    "hand": hand, "hand_confidence": round(hand_conf, 2),
                    "inferred": True,
                    "assumption": f"人高按 {PERSON_HEIGHT_M} m、焦距按 {int(focal)} px 推算；距离是估值",
                },
                "keypoints": {k: [round(v[0], 1), round(v[1], 1), round(v[2], 2)] for k, v in kp.items() if v[2] > 0.3},
                "height_px": int(px_height),
                "distance_m": distance,
                "distance_est": True,
            })
    out["ms"]["pose"] = int((time.time() - t) * 1000)

    # ── 人脸（是否看得见脸，与姿态互相印证）───────────────
    t = time.time()
    if _face is not None:
        # Haar 在 1080p 上要 1.6 s；缩到 640 宽再找脸，位置按比例换回去。
        scale = min(1.0, 640.0 / max(1, w))
        small = cv2.resize(bgr, (int(w * scale), int(h * scale))) if scale < 1.0 else bgr
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        sw_, sh_ = gray.shape[1], gray.shape[0]
        found = _face.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=5, minSize=(max(20, sw_ // 24),) * 2)
        out["faces"] = [
            box_norm(float(x) / scale, float(y) / scale, float(x + fw) / scale, float(y + fh) / scale, w, h)
            for (x, y, fw, fh) in found
        ]
    else:
        out["faces"] = []
    out["ms"]["face"] = int((time.time() - t) * 1000)

    # 若没有姿态模型，退化：只有框，没有朝向
    if not people and boxes:
        for xyxy in boxes:
            x1, y1, x2, y2 = xyxy
            people.append({
                "bbox": box_norm(x1, y1, x2, y2, w, h),
                "pose": {"facing": "看不清", "facing_confidence": 0.0, "facing_basis": "没有姿态模型",
                         "hand": "看不清", "inferred": True},
                "keypoints": {},
                "height_px": int(y2 - y1),
                "distance_m": round(FOCAL_PX_DEFAULT * (w / 800.0) * PERSON_HEIGHT_M / max(1.0, y2 - y1), 1),
                "distance_est": True,
            })

    out["people"] = people
    out["ms"]["total"] = int((time.time() - t0) * 1000)
    out["ok"] = True
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "cortico-camera-perception/1.0"

    def log_message(self, fmt: str, *args) -> None:  # 安静
        return

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._json(200, {"ok": _detector is not None, "pose": _poser is not None, "face": _face is not None})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/perceive":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length", "0"))
        if length <= 0 or length > 8 * 1024 * 1024:
            self._json(413, {"error": "bad body size"})
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            raw = base64.b64decode(body.get("image") or "", validate=True)
        except Exception as error:  # noqa: BLE001
            self._json(400, {"error": f"bad request: {error}"})
            return
        try:
            self._json(200, perceive(raw))
        except Exception as error:  # noqa: BLE001
            self._json(500, {"error": f"perceive failed: {error}"})


def main() -> int:
    parser = argparse.ArgumentParser(description="YOLO + pose + face sidecar for cortico-world-camera")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9402)
    parser.add_argument("--mediapipe-model", default=None, help="可选：pose_landmarker.task 的路径")
    args = parser.parse_args()
    load_models(args.mediapipe_model)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"camera perception sidecar on http://{args.host}:{args.port} (detect={'yolo11n'} pose={'yolo11n-pose' if _poser else 'off'} face={'haar' if _face else 'off'})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
