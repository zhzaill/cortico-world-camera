# cortico-world-camera · 眼睛

给 Cortico 的一只眼睛。**画面不直接进模型**：先被转译成一句句人话，检测框、姿态骨架、人脸与提案都只是旁证。

这是 World 三槽位（观察 / 动作 / 节奏）里**观察**那一槽的落地：它不追求像素级精度，只追求一件事——
让 Persona 读完那段字，就知道「现在能不能信这段画面、谁在、朝哪、多远、哪里看不见」。

```
摄像头 ──▶ 感知旁证（YOLO 检测 + 姿态 + 人脸）──▶ AI 转译 ──▶ 一句中文 ──▶ Persona
                                                              └▶ 事件（只报跃迁）
```

## 它不做什么

- **不驱动任何东西**。工具表里没有一个 `act`：`cam_status` / `cam_look` / `cam_watch` 全是只读。
- **不把像素塞给模型**。模型读到的是句子；照片只在 `cam_look` 被调用时按需产生一张。
- **不编造**。检测器只给框，就不写距离；姿态推出来的朝向、手势、距离一律标「推断」并附假设；
  服务不可达就说不可达。

## 装

```bash
# 发布版（在 Cortico 仓库的 extensions/ 下）
corepack pnpm add --ignore-workspace cortico-world-camera
# 或开发态：控制台「手动安装」填本包绝对路径（link 方式，改源码重启即生效）

# 本仓库内开发
node ../../scripts/build-console.mjs cortico-world-camera      # 生成 dist/console.js + console.css
```

装完重启进程，控制台左栏出现「眼睛」页；bot 的 `declares` 里加 `camera` 即默认启用
（或直接在部署 `config.json` 里 `worlds.camera.enabled=true`）。

## 感知旁证（可选，但强烈建议）

一个本地 Python 进程，一条命令：

```bash
python tools/perception_sidecar.py --port 9402
# 依赖：pip install ultralytics opencv-python pillow
# 权重：优先用本包 models/ 下的 yolo11n.pt / yolo11n-pose.pt（离线推荐）；
#      没有则交给 ultralytics 自己下载到缓存
```

契约：

```jsonc
POST /perceive   {"image": "<base64 jpeg>"}
->   {
       "objects": [{"label","score","bbox":[x1,y1,x2,y2]}],
       "people":  [{"bbox","pose":{"facing","hand","facing_basis","inferred","assumption"},
                    "keypoints":{...17 个 COCO 点...},"height_px","distance_m","distance_est"}],
       "faces":   [[x1,y1,x2,y2]],
       "image":   {"w","h"},
       "ms":      {"yolo","pose","face","total"}
     }
GET /health      -> {"ok":true,"pose":true,"face":true}
```

实测（1280×720，本机 CPU）：`yolo 221 ms / pose 160 ms / face 177 ms / 合计约 0.6 s`。

**关于 MediaPipe**：本包预留 `--mediapipe-model pose_landmarker.task` 入口，但
MediaPipe ≥0.10.33 的 wheel 既不带 `solutions` 也不带 `.task` 模型，而 `storage.googleapis.com`
在部分网络不可达。因此默认姿态用 **YOLO11-pose**（同为 17 个 COCO 关键点，且与检测共用一套
ultralytics）。拿到 `.task` 后换过去即可，转译层不用改。

## AI 转译（本包的核心）

`src/translate.ts` 是纯函数：输入「帧 + 感知 + 提案」，输出一段中文、面板短标签与结构化 facts。

```
【眼睛】12:38:06 的画面（630 毫秒前）
画面 1280×720，亮度正常；画面基本静止（运动能量 0.03）。
测到：person×2、tie×1。person（画面右）；person（画面中）；tie（画面中）。
人 2 个，最近的约 3.9 米（估）；朝向以「正面」为主（推断：鼻偏离肩中线；鼻在肩中线上方）。
推断的假设：人高按 1.7 m、焦距按 1280 px 推算；距离是估值。
画面里有 2 张脸能被认出来（正脸检测）。
提案（影子，不驱动）：前方 0.94 米、左 -0.15 米；0.08 米/秒、右转 0.40 弧度/秒；240 毫秒前算的。
看不到：身后 180°、身体两侧、以及被挡住的东西——相机只有一只眼睛。
```

四类事实严格分开：**测到**（框/计数/像素高度）、**推断**（朝向/手势/距离，附假设）、
**影子提案**（永不驱动）、**看不见**（结构性盲区）。陈旧画面会被标「已陈旧」。

## 事件（只报跃迁，不逐帧刷屏）

| 事件 | 触发 |
|---|---|
| `camera.ready` | 隔了一段时间又有画面 |
| `camera.stalled` | 超过 `stallAfterMs` 没有新帧 |
| `camera.motion` | 运动能量超阈值（带冷却） |
| `camera.person.entered` / `.left` | 检测器报人 / 这一帧不再报人（文字明说「不等于人走了」） |
| `camera.observed` | 操作者在面板点「发给她」 |

投递走 `host.pushEvent`（`origin: 'external'`）。Cortico 默认把外部事件放进**合成工具回执**
（`eventDelivery: 'tool'`），所以它们不会冒充 user 消息；只有会话显式声明 `eventDelivery: 'user'`
时才会并入 user 消息。

## 工具

| 工具 | 说明 |
|---|---|
| `cam_status` | 有没有画面、多新、亮不亮、检测/提案在不在线 |
| `cam_look(why)` | 要一张现在的照片（作为附件）+ 一句它看见什么 |
| `cam_watch(seconds, why)` | 盯 1–15 秒，回报动静与人进出 |

## 配置（`worlds.camera.*`，控制台「配置」页可改，立即生效）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | bot 声明或部署配置打开 |
| `mirror` | `true` | 面板镜像显示（像素本身不翻） |
| `deviceId` | `''` | 默认摄像头；空 = 浏览器挑 |
| `vision.perceptionUrl` | `http://127.0.0.1:9402/perceive` | 感知旁证；空 = 不接 |
| `vision.vlaUrl` | `http://192.168.1.166:18300` | 提案服务（NoMaD 一类）；空 = 不接 |
| `vision.detectorUrl` | `''` | 老契约：只出框的检测器（perception 为空时用） |
| `vision.analysisFps` | `2` | 送分析的上限（预览不受影响） |
| `vision.timeoutMs` | `4000` | 单次分析超时 |
| `vision.maxFrameBytes` | `262144` | 超限的帧直接丢，不送远端 |
| `privacy.keepFrames` | `3` | 内存里留几帧（只为「看一次」），不落盘 |
| `privacy.logFrames` | `false` | 只记字节数，永不记正文 |
| `events.motionThreshold` | `0.08` | 动静阈值 |
| `events.cooldownMs` | `20000` | 同类事件最小间隔 |
| `events.stallAfterMs` | `6000` | 多久没帧算闭眼 |

## 面板

一张卡放完：镜像预览 + 检测框 + REC/时钟/帧率 + 右下角提案俯视图 + 底部 v/ω/目标距离，
下面六颗读数灯、**此刻的画面**（World 读到的就是这段，一字不差）、事件流水。
按钮：`开眼/闭眼`、`看一次`、`发给她`、`清画面`。

不装 Cortico 也能预览：

```bash
python -m http.server 8181        # 在本包目录
# 打开 http://127.0.0.1:8181/tools/panel-preview.html
```

## 画面从哪来

默认由**控制台面板**用 `getUserMedia` 采集，经面板推送通道上行到 World。扩展因此**零原生依赖**，
任何带摄像头的机器都能跑；帧只在内存里过一圈，默认不落盘。关掉面板或点「闭眼」，浏览器立刻释放摄像头。

代价：面板不开就没有画面（`cam_look` 会明说「还没有画面」）。改成服务端取流（MJPEG/UVC）预留了位置。

## 已实测 / 未实测

**已实测**

- 面板打包、全仓 `tsc --noEmit` 0 错误、契约测试 **21 项通过**；
- Cortico 官方 `scripts/extension-check.ts` 通过（manifest / 形状 / 默认值 / tools / envPromptVars / console）；
- 感知 sidecar 真图跑通：`zidane.jpg` → 2 人 + 领带 + 2 张脸，约 0.6 s，姿态与朝向可用；
- 转译输出人工核对：事实 / 推断 / 影子 / 盲区四段分离，cues 正确。

**未实测**

- 浏览器摄像头授权与出帧（作者机器上卡在权限/设备，原因尚未定性）；
- 面板推送通道在真 Cortico 里的往返（帧上行、状态下行）；
- 与 NoMaD 的联调（服务在线，但 `dist_pred` 车不动也会单调增，只能当「它自己的读数」）。

## 已知坑

- 控制台里的「重启」= 进程退出（没有 supervisor 拉起）；重启请重跑启动脚本。
- 面板 bundle URL 带扩展版本号：改完面板要 `build-console.mjs` 并让版本号变化，否则浏览器吃缓存。
- 摄像头打不开的六种原因（权限 / 无设备 / 被占用 / 设备消失 / 非安全上下文 / 上行断开）面板会分别给话，
  同时把 `面板自检` 写进宿主日志。

## 仓库里还有什么

- [`docs/VISION-NOTES.md`](docs/VISION-NOTES.md) —— **视觉探索记录**：为什么把 NoMaD 从「感知」降级为
  「转向先验」，实测到的三宗罪（速度恒饱和 / 距离不可信 / 转向易翻面），MediaPipe 与权重通道的坑，
  以及「测到 / 推断 / 影子 / 看不见」四分法的由来。
- [`models/`](models/README.md) —— 开发用的 YOLO11 与 YOLO11-pose 权重（**AGPL-3.0，不属于 MIT 代码**），
  含字节数与 SHA-256。

## 许可

MIT（见 `LICENSE`）。YOLO 权重按 AGPL-3.0 分发，**不在本包内**；详见 LICENSE 末尾。
