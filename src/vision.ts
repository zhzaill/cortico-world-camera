/**
 * 视觉这一层的全部理智都在这两个函数里：把一帧画面变成一句人话，以及把两个
 * 「旁证服务」（检测器、提案服务）的失败说成人话。
 *
 * 纪律：
 *   - 不编造。检测器不给距离，就不写距离；提案服务不可达，就不写提案。
 *   - 时间必须锚定。任何一条观察都带「多少毫秒前」。
 *   - 看不见要说清楚。相机只有一只眼，身后与两侧是结构性的盲。
 *   - 这里不碰 DOM、不碰 Cortico，方便直接单测。
 */

import type { Perception } from './translate.ts';

export interface Detection {
  label: string;
  score: number;
  /** 归一化 [x1, y1, x2, y2]，原点左上。 */
  bbox: [number, number, number, number];
}

export interface Proposal {
  /** [前方米, 左侧米]；服务没给就是 null。 */
  waypoint: [number, number] | null;
  v: number | null;
  w: number | null;
  dist: number | null;
  /** 服务端自己算的耗时。 */
  latencyMs: number | null;
  /** 这一次结果是何时取回的（毫秒时间戳）。 */
  at: number;
}

export interface FrameSignal {
  ts: number;
  w: number;
  h: number;
  /** 0–255 的平均亮度，面板算好送过来。 */
  luma: number;
  /** 0–1 的画面变化量，面板算好送过来。 */
  motion: number;
  jpeg: Uint8Array;
}

export interface VisionState {
  hasFrame: boolean;
  frameAt: number;
  frameAgeMs: number;
  width: number;
  height: number;
  luma: number;
  motion: number;
  frames: number;
  detections: Detection[];
  detectionsAt: number;
  detectorError: string | null;
  /** 感知旁证的原始回执（YOLO + 姿态 + 人脸）；转译层吃它。 */
  perception: Perception | null;
  proposal: Proposal | null;
  vlaError: string | null;
  analyzedAt: number;
  analyzedCount: number;
  analyzing: boolean;
}

export function emptyVisionState(): VisionState {
  return {
    hasFrame: false,
    frameAt: 0,
    frameAgeMs: 0,
    width: 0,
    height: 0,
    luma: 0,
    motion: 0,
    frames: 0,
    detections: [],
    detectionsAt: 0,
    detectorError: null,
    perception: null,
    proposal: null,
    vlaError: null,
    analyzedAt: 0,
    analyzedCount: 0,
    analyzing: false,
  };
}

/** 画面左中右：检测器只给框，方位由框的中心换算，这是可确认的。 */
export function horizontalThirds(bbox: Detection['bbox']): '左' | '中' | '右' {
  const cx = (bbox[0] + bbox[2]) / 2;
  if (cx < 1 / 3) return '左';
  if (cx > 2 / 3) return '右';
  return '中';
}

/** 把 [前, 左] 米换成「前方偏左/右 X°、约 Y 米」，只用于人间读得懂的方位。 */
export function bearingText(waypoint: [number, number]): string {
  const [forward, left] = waypoint;
  const dist = Math.hypot(forward, left);
  if (!Number.isFinite(dist) || dist <= 0.01) return '几乎就在原地';
  const deg = (Math.atan2(left, forward) * 180) / Math.PI;
  const side = Math.abs(deg) < 3 ? '正前方' : deg > 0 ? `前方偏左 ${Math.abs(deg).toFixed(0)}°` : `前方偏右 ${Math.abs(deg).toFixed(0)}°`;
  return `${side}、约 ${dist.toFixed(1)} 米`;
}

function ageText(ms: number): string {
  if (ms < 0) return '未知时间';
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} 毫秒前`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒前`;
  return `${Math.round(ms / 60_000)} 分钟前`;
}

function clockText(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function brightnessText(luma: number): string {
  if (luma < 30) return '很暗（几乎全黑，可能是没开灯或镜头被挡）';
  if (luma < 70) return '偏暗';
  if (luma < 170) return '亮度正常';
  if (luma < 225) return '偏亮';
  return '过曝（一片白，细节没了）';
}

export interface SceneLimits {
  /** 面板层面的判断：多久没帧就当它闭眼了。 */
  stallAfterMs: number;
  motionThreshold: number;
}

/**
 * 一帧画面的散文。这是 bot 唯一能读到的「看见」，所以每一句都要能被下一帧复核。
 */
export function renderScene(state: VisionState, limits: SceneLimits, now = Date.now()): string {
  if (!state.hasFrame) {
    return '【眼睛】还没有画面。控制台的「眼睛」页没打开摄像头，或者浏览器没给权限。';
  }

  const age = now - state.frameAt;
  const lines: string[] = [];
  const stale = age > Math.max(2000, limits.stallAfterMs / 2);
  lines.push(
    `【眼睛】${clockText(state.frameAt)} 的画面（${ageText(age)}，${stale ? '已经陈旧，别当现在用' : '新鲜'}）`,
  );

  const move = state.motion > limits.motionThreshold ? '画面在动' : '画面基本静止';
  lines.push(`画面 ${state.width}×${state.height}，${brightnessText(state.luma)}；${move}（运动能量 ${state.motion.toFixed(2)}）。`);

  if (state.detectorError) {
    lines.push(`检测器没回话（${state.detectorError}），这一条不是它的判断。`);
  } else if (state.detections.length) {
    const grouped = new Map<string, number>();
    const places: string[] = [];
    for (const det of state.detections) {
      grouped.set(det.label, (grouped.get(det.label) ?? 0) + 1);
      places.push(`${det.label}（画面${horizontalThirds(det.bbox)}，置信 ${det.score.toFixed(2)}）`);
    }
    const summary = [...grouped.entries()].map(([label, n]) => `${label}×${n}`).join('、');
    lines.push(`检测器说：${summary}。${places.join('；')}。它只给框，远近看不出。`);
  } else if (state.detectionsAt > 0) {
    lines.push('检测器在这一帧里没报任何目标（这不等于画面里没人）。');
  }

  if (state.vlaError) {
    lines.push(`提案服务没回话（${state.vlaError}），所以没有提案。`);
  } else if (state.proposal) {
    const p = state.proposal;
    const where = p.waypoint ? bearingText(p.waypoint) : '方向它没给';
    const speed =
      p.v === null && p.w === null
        ? '速度没给'
        : `${p.v === null ? '?' : p.v.toFixed(2)} 米/秒、${p.w === null ? '?' : `${p.w > 0 ? '左' : '右'}转 ${Math.abs(p.w).toFixed(2)}`} 弧度/秒`;
    const dist = p.dist === null ? '' : `；离目标 ${p.dist.toFixed(1)} 米（它自己的读数）`;
    lines.push(
      `提案（影子，不驱动）：${where}；${speed}${dist}；${ageText(now - p.at)}算的${p.latencyMs === null ? '' : `，它自称耗时 ${Math.round(p.latencyMs)} 毫秒`}。`,
    );
  }

  lines.push('看不到：身后 180°、身体两侧、以及被挡住的东西——相机只有一只眼睛，这是结构性的盲。');
  return lines.join('\n');
}

/** 环境提示词里的那些变量，全部取自同一份事实。 */
export function describeLimits(): string {
  return '只看得到正前方大约 60°；身后与两侧看不到。检测器给的是画面里的位置，不是远近。提案服务的输出是「朝目标帧怎么走」的影子建议，永远不会直接驱动任何东西。';
}

interface RelayConfig {
  vision: { vlaUrl: string; perceptionUrl?: string; detectorUrl: string; timeoutMs: number; maxFrameBytes: number };
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function shortError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return '超时';
    return error.message.slice(0, 120);
  }
  return String(error).slice(0, 120);
}

/**
 * 两个旁证服务的接线板。串行、丢帧、永不抛错：分析慢不能拖住画面，分析坏不能拖住对话。
 */
export class VisionRelay {
  private state = emptyVisionState();
  private busy = false;

  constructor(private readonly cfg: () => RelayConfig) {}

  snapshot(): VisionState {
    return { ...this.state, detections: [...this.state.detections], proposal: this.state.proposal ? { ...this.state.proposal } : null };
  }

  recordFrame(frame: FrameSignal): void {
    this.state.hasFrame = true;
    this.state.frameAt = frame.ts;
    this.state.frameAgeMs = 0;
    this.state.width = frame.w;
    this.state.height = frame.h;
    this.state.luma = frame.luma;
    this.state.motion = frame.motion;
    this.state.frames += 1;
  }

  /** 分析是尽力而为：失败只改错误字段，不抛。 */
  async analyze(frame: FrameSignal): Promise<void> {
    const { vision } = this.cfg();
    const vlaUrl = vision.vlaUrl.trim().replace(/\/$/, '');
    const perceptionUrl = (vision.perceptionUrl ?? '').trim();
    const detectorUrl = vision.detectorUrl.trim();
    if (!vlaUrl && !detectorUrl && !perceptionUrl) return;
    if (this.busy) return;
    if (frame.jpeg.byteLength > vision.maxFrameBytes) return;
    this.busy = true;
    this.state.analyzing = true;
    const image = Buffer.from(frame.jpeg).toString('base64');
    try {
      const jobs: Promise<void>[] = [];
      if (vlaUrl) jobs.push(this.infer(vlaUrl, image, vision.timeoutMs));
      if (perceptionUrl) jobs.push(this.perceive(perceptionUrl, image, vision.timeoutMs));
      else if (detectorUrl) jobs.push(this.detect(detectorUrl, image, vision.timeoutMs));
      await Promise.all(jobs);
      this.state.analyzedAt = Date.now();
      this.state.analyzedCount += 1;
    } finally {
      this.busy = false;
      this.state.analyzing = false;
    }
  }

  /** 感知旁证：YOLO + 姿态 + 人脸，一次回执。失败只记错误。 */
  private async perceive(url: string, image: string, timeoutMs: number): Promise<void> {
    try {
      const out = (await postJson(url, { image }, timeoutMs)) as Perception;
      this.state.perception = {
        ok: Boolean(out.ok),
        error: out.error,
        image: out.image ?? { w: 0, h: 0 },
        objects: Array.isArray(out.objects) ? out.objects : [],
        people: Array.isArray(out.people) ? out.people : [],
        faces: Array.isArray(out.faces) ? out.faces : [],
        ms: out.ms,
      };
      this.state.detections = this.state.perception.objects.slice(0, 20).map((o) => ({
        label: o.label,
        score: o.score,
        bbox: o.bbox,
      }));
      this.state.detectionsAt = Date.now();
      this.state.detectorError = this.state.perception.ok ? null : this.state.perception.error ?? '感知服务报错';
    } catch (error) {
      this.state.detectorError = shortError(error);
      this.state.perception = null;
    }
  }

  private async infer(baseUrl: string, image: string, timeoutMs: number): Promise<void> {
    try {
      const out = (await postJson(`${baseUrl}/infer`, { image }, timeoutMs)) as {
        chosen_waypoint?: unknown;
        velocity_proposal?: { v?: unknown; w?: unknown };
        dist_pred?: unknown;
        latency_ms?: unknown;
      };
      const wp = Array.isArray(out.chosen_waypoint) && out.chosen_waypoint.length >= 2
        ? [Number(out.chosen_waypoint[0]), Number(out.chosen_waypoint[1])] as [number, number]
        : null;
      const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      this.state.proposal = {
        waypoint: wp && wp.every((n) => Number.isFinite(n)) ? wp : null,
        v: num(out.velocity_proposal?.v),
        w: num(out.velocity_proposal?.w),
        dist: num(out.dist_pred),
        latencyMs: num(out.latency_ms),
        at: Date.now(),
      };
      this.state.vlaError = null;
    } catch (error) {
      this.state.vlaError = shortError(error);
    }
  }

  private async detect(url: string, image: string, timeoutMs: number): Promise<void> {
    try {
      const out = (await postJson(url, { image }, timeoutMs)) as { detections?: unknown };
      const list = Array.isArray(out.detections) ? out.detections : [];
      const parsed: Detection[] = [];
      for (const raw of list) {
        const item = raw as { label?: unknown; score?: unknown; bbox?: unknown };
        const bbox = Array.isArray(item.bbox) && item.bbox.length === 4 ? item.bbox.map(Number) : null;
        if (!bbox || bbox.some((n) => !Number.isFinite(n))) continue;
        parsed.push({
          label: String(item.label ?? '目标').slice(0, 16),
          score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
          bbox: bbox as [number, number, number, number],
        });
      }
      this.state.detections = parsed.slice(0, 20);
      this.state.detectionsAt = Date.now();
      this.state.detectorError = null;
    } catch (error) {
      this.state.detectorError = shortError(error);
    }
  }
}
