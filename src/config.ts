/**
 * 配置段 `worlds.camera.*`。
 *
 * 纪律：行为声明式——所有能调的东西都在这里，代码里不散落常量；
 * 每个字段都要在 `defaults()` 里有对应项，否则控制台照样渲染旋钮、写回的值却没人读。
 */

export interface CameraVisionConfig {
  /** NoMaD 这类提案服务。空串 = 不接。 */
  vlaUrl: string;
  /** 感知旁证（YOLO + 姿态 + 人脸，见 tools/perception_sidecar.py）。空串 = 不接。 */
  perceptionUrl: string;
  /** 老契约：只出框的检测器。perceptionUrl 为空时才用它。 */
  detectorUrl: string;
  /** 每秒送分析的帧数上限。画面本身不受它限制。 */
  analysisFps: number;
  /** 单次分析的超时。 */
  timeoutMs: number;
  /** 单帧上限；超出直接丢弃，不送给任何远端。 */
  maxFrameBytes: number;
}

export interface CameraPrivacyConfig {
  /** 内存里保留几帧（只用于「看一次」）。0 = 不留。 */
  keepFrames: number;
  /** 是否把每帧的字节数写进日志。正文永不写。 */
  logFrames: boolean;
}

export interface CameraEventConfig {
  /** 运动能量超过它才算「画面有明显的动静」（0–1）。 */
  motionThreshold: number;
  /** 两次同类事件的最小间隔。 */
  cooldownMs: number;
  /** 多久没收到帧就报「眼睛闭了」。 */
  stallAfterMs: number;
}

export interface CameraConfig {
  enabled: boolean;
  /** 画面左右翻转（前置摄像头照镜子）。只影响面板，不影响送分析的像素。 */
  mirror: boolean;
  /** 面板默认选中的摄像头 deviceId；空串 = 让浏览器挑。 */
  deviceId: string;
  vision: CameraVisionConfig;
  privacy: CameraPrivacyConfig;
  events: CameraEventConfig;
  debug: boolean;
}

export const CAMERA_DEFAULTS: CameraConfig = {
  enabled: false,
  mirror: true,
  deviceId: '',
  vision: {
    // 作者实验室里的 NoMaD 服务；不可达时面板显示「离线」，不编造提案。
    vlaUrl: 'http://192.168.1.166:18300',
    // 本地感知旁证：YOLO 检测 + YOLO-pose 骨架 + Haar 正脸，默认端口 9402。
    perceptionUrl: 'http://127.0.0.1:9402/perceive',
    detectorUrl: '',
    analysisFps: 2,
    timeoutMs: 4000,
    maxFrameBytes: 262144,
  },
  privacy: {
    keepFrames: 3,
    logFrames: false,
  },
  events: {
    motionThreshold: 0.08,
    cooldownMs: 20000,
    stallAfterMs: 6000,
  },
  debug: false,
};

/** 控制台配置组：面板上能改的东西。owner 必须是 `world:camera`。 */
export const CAMERA_CONFIG_GROUP = {
  id: 'world:camera',
  owner: 'world:camera',
  schema: {
    type: 'object' as const,
    title: '眼睛',
    description: '摄像头、提案服务与分析节奏。',
    properties: {
      'worlds.camera.mirror': {
        type: 'boolean' as const,
        title: '画面左右翻转',
        description: '前置摄像头照镜子用；只影响面板显示。',
      },
      'worlds.camera.deviceId': {
        type: 'string' as const,
        title: '默认摄像头',
        description: '留空由浏览器挑；填 deviceId 则每次打开都优先用它。',
      },
      'worlds.camera.vision.vlaUrl': {
        type: 'string' as const,
        title: '提案服务地址',
        description: 'NoMaD 一类服务，例如 http://127.0.0.1:18300。留空表示不接。',
      },
      'worlds.camera.vision.perceptionUrl': {
        type: 'string' as const,
        title: '感知服务地址',
        description: 'YOLO + 姿态 + 人脸（tools/perception_sidecar.py）。留空表示不接。',
      },
      'worlds.camera.vision.detectorUrl': {
        type: 'string' as const,
        title: '检测器地址',
        description: '可选。契约见包内 tools/yolo_sidecar.py；留空表示不接。',
      },
      'worlds.camera.vision.analysisFps': {
        type: 'number' as const,
        title: '分析帧率',
        description: '每秒送多少帧去分析。画面预览不受影响。',
        minimum: 0.2,
      },
      'worlds.camera.events.motionThreshold': {
        type: 'number' as const,
        title: '动静阈值',
        description: '画面变化超过它才报「有动静」。0–1。',
        minimum: 0,
      },
      'worlds.camera.privacy.keepFrames': {
        type: 'number' as const,
        title: '内存里留几帧',
        description: '只为「看一次」服务；不落盘。0 表示不留。',
        minimum: 0,
      },
      'worlds.camera.events.stallAfterMs': {
        type: 'number' as const,
        title: '多久没帧算闭眼',
        description: '超过这个时间没收到画面就报一次「眼睛闭了」。',
        minimum: 1000,
      },
    },
  },
};
