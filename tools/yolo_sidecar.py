#!/usr/bin/env python3
"""参考检测器：把 YOLO 包成一个 Cortico World 认得的 HTTP 旁证服务。

契约（与 package.json 里 worlds.camera.vision.detectorUrl 对应）：

    POST /            {"image": "<base64 jpeg>"}
    -> 200 {"detections": [{"label": "person", "score": 0.72, "bbox": [x1,y1,x2,y2]}]}

bbox 是归一化坐标，原点左上。这个服务只出框、不出距离——距离不是它能确认的事。

跑法：
    python tools/yolo_sidecar.py --model yolo11n.pt --port 9401
依赖：ultralytics、pillow（`pip install ultralytics`）。
"""

from __future__ import annotations

import argparse
import base64
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yaml  # noqa: F401  (占位：ultralytics 需要，显式写出便于早失败)

from PIL import Image
from ultralytics import YOLO


MODEL: YOLO | None = None
CONF = 0.35
NAMES: dict[int, str] = {}


class Handler(BaseHTTPRequestHandler):
    server_version = "xuegeros-yolo/1.0"

    def log_message(self, fmt: str, *args) -> None:  # 安静一点：只留错误
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
            self._json(200, {"ok": MODEL is not None, "model": str(getattr(MODEL, "ckpt_path", ""))})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if MODEL is None:
            self._json(503, {"error": "model not loaded"})
            return
        length = int(self.headers.get("content-length", "0"))
        if length <= 0 or length > 8 * 1024 * 1024:
            self._json(413, {"error": "bad body size"})
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            image_b64 = body.get("image") or ""
            raw = base64.b64decode(image_b64, validate=True)
        except Exception as error:  # noqa: BLE001 - 回执要说人话
            self._json(400, {"error": f"bad request: {error}"})
            return
        try:
            image = Image.open(io.BytesIO(raw)).convert("RGB")
        except Exception as error:  # noqa: BLE001
            self._json(400, {"error": f"not an image: {error}"})
            return

        width, height = image.size
        result = MODEL.predict(image, conf=CONF, verbose=False)[0]
        detections = []
        for box in result.boxes:
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0].tolist())
            detections.append(
                {
                    "label": NAMES.get(int(box.cls[0]), "object"),
                    "score": round(float(box.conf[0]), 3),
                    "bbox": [
                        round(max(0.0, x1 / width), 4),
                        round(max(0.0, y1 / height), 4),
                        round(min(1.0, x2 / width), 4),
                        round(min(1.0, y2 / height), 4),
                    ],
                }
            )
        detections.sort(key=lambda d: d["score"], reverse=True)
        self._json(200, {"detections": detections[:20], "width": width, "height": height})


def main() -> int:
    global MODEL, CONF, NAMES
    parser = argparse.ArgumentParser(description="YOLO sidecar for cortico-world-camera")
    parser.add_argument("--model", default="yolo11n.pt")
    parser.add_argument("--port", type=int, default=9401)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--conf", type=float, default=0.35)
    args = parser.parse_args()

    CONF = args.conf
    MODEL = YOLO(args.model)
    NAMES = MODEL.names if isinstance(MODEL.names, dict) else dict(enumerate(MODEL.names))

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"yolo sidecar on http://{args.host}:{args.port} (model={args.model}, conf={CONF})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
