# models/

本目录是**开发/离线用**的权重，不属于 MIT 代码部分。

| 文件 | 字节 | SHA-256 | 来源 | 许可 |
|---|---|---|---|---|
| `yolo11n.pt` | 5,613,764 | `0EBBC80D4A7680D14987A577CD21342B65ECFD94632BD9A8DA63AE6417644EE1` | Ultralytics YOLO11（经 ModelScope 镜像 `Ultralytics/YOLO11`） | **AGPL-3.0** |
| `yolo11n-pose.pt` | 6,255,593 | `869E83FCDFFDC7371FA4E34CD8E51C838CC729571D1635E5141E3075E9319DC0` | 同上；下载时与 `Content-Length` **逐字节相等** | **AGPL-3.0** |

- 代码部分（`src/`、`dist/`、`tools/`）是 **MIT**（见仓库根 `LICENSE`）。
- 这两个权重来自 Ultralytics，按 **AGPL-3.0** 分发：<https://github.com/ultralytics/ultralytics/blob/main/LICENSE>。
  **整包再分发或以网络服务形式提供时，请自行评估 AGPL 的义务**；不想承担就把 `models/` 删掉，
  让 sidecar 自己去取（`ultralytics` 会下载到它的缓存目录）。
- 校验：`Get-FileHash models\yolo11n-pose.pt -Algorithm SHA256`（Windows）／`sha256sum`（*nix）。
