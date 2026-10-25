/**
 * CameraWorld：一台笔记本摄像头在 Cortico 里的那一面。
 *
 * 三个数据面（与 Minecraft World 同构）：
 *   事件   —— 只有跃迁：开眼/闭眼、有动静、人进人出。绝不逐帧刷屏。
 *   工具   —— 全部是只读：问状态、要一张照片、盯一小会儿。
 *   环境   —— envPromptVars() 每次前缀重建现取，写「现在」而不是「常量」。
 *
 * 画面从哪来：控制台面板（浏览器 getUserMedia）把帧顺着面板推送通道送上来。
 * 这样包本身零原生依赖，任何一台笔记本都能跑；帧只在内存里过一圈，默认不落盘。
 */

import { fileURLToPath } from 'node:url';
import type {
  BlobInput,
  ToolDef,
  ToolOutcome,
  World,
  WorldConsoleDecl,
  WorldHost,
  WorldStreamSocket,
} from 'cortico/core/types.ts';
import type { WorldContext, WorldSection } from 'cortico/world.ts';

import { CAMERA_CONFIG_GROUP, type CameraConfig } from './config.ts';
import { cameraTools, type CameraOps } from './tools.ts';
import { translate } from './translate.ts';
import {
  VisionRelay,
  describeLimits,
  emptyVisionState,
  type Detection,
  type FrameSignal,
  type VisionState,
} from './vision.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const TICK_MS = 1000;
const PANEL_PUSH_MS = 500;

interface StoredFrame {
  ts: number;
  w: number;
  h: number;
  jpeg: Uint8Array;
}

export class CameraWorld implements World, CameraOps {
  readonly id = 'camera';

  private readonly relay: VisionRelay;
  private host: WorldHost | null = null;
  private sockets = new Set<WorldStreamSocket>();
  private keep: StoredFrame[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastAnalysisAt = 0;
  private lastMotionEventAt = 0;
  private lastPersonEventAt = 0;
  private lastReadyEventAt = 0;
  private personPresent = false;
  private stalled = false;
  private stalledAt = 0;

  constructor(private readonly ctx: WorldContext<CameraConfig & WorldSection>) {
    this.relay = new VisionRelay(() => ({ vision: ctx.cfg.vision }));
  }

  // ── World 契约 ──────────────────────────────────────────────
  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    host.log.info('眼睛 World 已启动：等控制台面板把画面送上来');
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const socket of this.sockets) socket.close('World 已停用');
    this.sockets.clear();
    this.keep = [];
    this.host = null;
  }

  shutdownVerification() {
    const viewers = this.sockets.size;
    return [{
      key: 'camera.viewers',
      label: '摄像头是否已放开',
      status: (viewers === 0 ? 'verified-ended' : 'still-live') as 'verified-ended' | 'still-live',
      detail: viewers === 0 ? '没有面板连着，采集已停止' : `还有 ${viewers} 个面板连着摄像头`,
      manualAction: '关掉控制台的「眼睛」页，浏览器会释放摄像头（灯灭即可）',
    }];
  }

  envPromptVars(): Record<string, string> {
    const state = this.relay.snapshot();
    return {
      'camera.summary': this.sceneText(state),
      'camera.state': this.stateLine(state),
      'camera.limits': describeLimits(),
    };
  }

  tools(): ToolDef[] {
    return cameraTools(this);
  }

  console(): WorldConsoleDecl {
    const state = this.relay.snapshot();
    const { vision } = this.ctx.cfg;
    const vlaOn = Boolean(vision.vlaUrl.trim());
    const detOn = Boolean(vision.detectorUrl.trim());
    return {
      label: '眼睛',
      lamps: [
        {
          label: '画面',
          state: state.hasFrame ? (this.stalled ? 'error' : 'online') : 'offline',
          hint: state.hasFrame ? (this.stalled ? '很久没有新帧了' : '在出帧') : '还没有画面',
        },
        {
          label: '提案',
          state: !vlaOn ? 'offline' : state.vlaError ? 'error' : 'online',
          hint: !vlaOn ? '没接提案服务' : state.vlaError ?? '在线',
        },
        {
          label: '检测',
          state: !detOn ? 'offline' : state.detectorError ? 'error' : 'online',
          hint: !detOn ? '没接检测器' : state.detectorError ?? '在线',
        },
        { label: '观众', state: this.sockets.size > 0 ? 'online' : 'offline', hint: `${this.sockets.size} 个面板连着` },
      ],
      badges: state.hasFrame
        ? [
            { label: '分辨率', value: `${state.width}×${state.height}` },
            { label: '已收帧', value: state.frames },
          ]
        : [{ label: '画面', value: '没有' }],
      // 一个面板装全部：画面、读数、提案、快照、事件都在同一张卡里，操作者不用来回切。
      panels: [
        { id: 'eye', title: '眼睛', description: '实时画面、检测叠加、提案俯视图与世界快照。' },
        { id: 'tune', title: '调校', description: '帧率、阈值、隐私：这只眼睛怎么工作。' },
      ],
      promptDocs: [{
        key: 'worlds.camera.envPrompt',
        title: '眼睛 · 环境提示词',
        description: '告诉 bot 它有一双什么样的眼睛、能问什么、什么情况要说明看不见。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'camera.summary', description: '此刻的画面转写成的散文', multiline: true },
          { name: 'camera.state', description: '相机的机械状态（有没有帧、多久以前）' },
          { name: 'camera.limits', description: '这双眼睛的结构性盲区与不可靠之处', multiline: true },
        ],
      }],
      config: [CAMERA_CONFIG_GROUP as never],
      invoke: async (panel, method, args) => this.panelInvoke(panel, method, args),
      stream: (panel, socket) => this.panelStream(panel, socket),
    };
  }

  // ── 面板数据面 ──────────────────────────────────────────────
  private async panelInvoke(panel: string, method: string, args: unknown[] = []): Promise<unknown> {
    const state = this.relay.snapshot();
    if (panel === 'eye') {
      if (method === 'diag') {
        // 走 HTTP 而不是面板推送通道：WS 坏了也要能把「为什么打不开摄像头」送到日志里。
        const report = args[0] ?? {};
        this.host?.log.info('面板自检', report as Record<string, unknown>);
        return { ok: true };
      }
      if (method === 'state') return this.telemetry(state);
      if (method === 'snapshot') {
        const frame = this.keep.at(-1);
        if (!frame) throw new Error('还没有画面可给');
        return { $binary: { mime: 'image/jpeg', base64: Buffer.from(frame.jpeg).toString('base64') } };
      }
      if (method === 'publish') {
        // 操作者把「现在这一眼」交给 bot：这是唯一一条由人触发的外部事件。
        await this.push({
          type: 'camera.observed',
          text: `操作者让你看现在：\n${this.sceneText(state)}`,
          trigger: 'flush',
          meta: { frames: state.frames, width: state.width, height: state.height },
        });
        return { text: '已经把这一眼交给她了' };
      }
      if (method === 'forget') {
        this.keep = [];
        return { text: '内存里的画面已清空' };
      }
    }
    if (panel === 'tune' && method === 'state') {
      return { ...this.telemetry(state), config: this.ctx.cfg };
    }
    throw new Error(`未知面板方法：${panel}.${method}`);
  }

  private panelStream(panel: string, socket: WorldStreamSocket): void {
    if (panel !== 'eye') {
      socket.close('这个面板没有推送');
      return;
    }
    this.sockets.add(socket);
    this.host?.log.info(`面板连上推送：${panel}（现在 ${this.sockets.size} 个）`, { panel });
    socket.send(JSON.stringify({ t: 'state', ...this.telemetry(this.relay.snapshot()) }));
    socket.onMessage((text) => this.onPanelMessage(text));
    const timer = setInterval(() => {
      if (!socket.open) return;
      socket.send(JSON.stringify({ t: 'state', ...this.telemetry(this.relay.snapshot()) }));
    }, PANEL_PUSH_MS);
    socket.onClose(() => {
      clearInterval(timer);
      this.sockets.delete(socket);
    });
  }

  private onPanelMessage(text: string): void {
    let message: {
      t?: string;
      jpeg?: string;
      w?: number;
      h?: number;
      luma?: number;
      motion?: number;
      stage?: string;
      name?: string;
      message?: string;
      secure?: boolean;
      devices?: number;
    };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    // 面板在浏览器里，宿主看不见它。摄像头打不开时由面板把原因送上来，落进宿主日志。
    if (message.t === 'camera.error') {
      this.host?.log.warn('面板摄像头打不开', {
        stage: message.stage,
        name: message.name,
        message: message.message,
        secure: message.secure,
        devices: message.devices,
      });
      return;
    }
    if (message.t !== 'frame' || typeof message.jpeg !== 'string') return;
    if (this.ctx.cfg.privacy.logFrames || this.relay.snapshot().frames === 0) {
      this.host?.log.info('收到第一帧（或开了帧日志）', { bytes: message.jpeg.length, w: message.w, h: message.h });
    }
    const frame = this.acceptFrame(message);
    if (!frame) return;
    void this.relay.analyze(frame);
    this.afterFrame(frame);
  }

  private acceptFrame(message: { jpeg?: string; w?: number; h?: number; luma?: number; motion?: number }): FrameSignal | null {
    const bytes = Buffer.from(message.jpeg ?? '', 'base64');
    if (!bytes.byteLength) return null;
    if (bytes.byteLength > this.ctx.cfg.vision.maxFrameBytes) {
      this.host?.log.warn(`丢了一帧：${bytes.byteLength} 字节超过上限`);
      return null;
    }
    const frame: FrameSignal = {
      ts: Date.now(),
      w: Math.max(1, Math.round(Number(message.w) || 0)),
      h: Math.max(1, Math.round(Number(message.h) || 0)),
      luma: Math.min(255, Math.max(0, Number(message.luma) || 0)),
      motion: Math.min(1, Math.max(0, Number(message.motion) || 0)),
      jpeg: new Uint8Array(bytes),
    };
    this.relay.recordFrame(frame);
    if (this.ctx.cfg.privacy.keepFrames > 0) {
      this.keep.push({ ts: frame.ts, w: frame.w, h: frame.h, jpeg: frame.jpeg });
      while (this.keep.length > this.ctx.cfg.privacy.keepFrames) this.keep.shift();
    }
    if (this.ctx.cfg.privacy.logFrames) this.host?.log.debug(`收到一帧 ${bytes.byteLength} 字节`);
    return frame;
  }

  private afterFrame(frame: FrameSignal): void {
    const now = Date.now();
    const { events } = this.ctx.cfg;
    if (this.stalled || this.lastReadyEventAt === 0) {
      this.stalled = false;
      if (now - this.lastReadyEventAt > events.cooldownMs) {
        this.lastReadyEventAt = now;
        void this.push({ type: 'camera.ready', text: '眼睛睁开了，开始有画面', trigger: 'debounce' });
      }
    }
    if (frame.motion > events.motionThreshold && now - this.lastMotionEventAt > events.cooldownMs) {
      this.lastMotionEventAt = now;
      void this.push({
        type: 'camera.motion',
        text: `画面里有明显的动静（运动能量 ${frame.motion.toFixed(2)}）`,
        trigger: 'debounce',
        meta: { motion: Number(frame.motion.toFixed(3)) },
      });
    }
    const person = this.people(this.relay.snapshot().detections);
    if (person !== this.personPresent) {
      this.personPresent = person;
      if (now - this.lastPersonEventAt > events.cooldownMs) {
        this.lastPersonEventAt = now;
        void this.push(
          person
            ? { type: 'camera.person.entered', text: '检测器在画面里报到了人', trigger: 'debounce' }
            : { type: 'camera.person.left', text: '检测器这一帧里没再报到人（这不等于人走了）', trigger: 'debounce' },
        );
      }
    }
  }

  private people(detections: Detection[]): boolean {
    return detections.some((d) => /person|人/i.test(d.label));
  }

  private tick(): void {
    const state = this.relay.snapshot();
    const now = Date.now();
    const { events } = this.ctx.cfg;
    const silent = !state.hasFrame || now - state.frameAt > events.stallAfterMs;
    if (silent && !this.stalled && state.hasFrame) {
      this.stalled = true;
      this.stalledAt = now;
      void this.push({
        type: 'camera.stalled',
        text: `眼睛闭了一会儿：${Math.round((now - state.frameAt) / 1000)} 秒没有新画面（面板关掉或摄像头被别的程序占了）`,
        trigger: 'flush',
      });
    }
  }

  // ── CameraOps（工具实现）────────────────────────────────────
  statusText(): string {
    const state = this.relay.snapshot();
    const { vision } = this.ctx.cfg;
    const age = state.hasFrame ? Date.now() - state.frameAt : null;
    return [
      `画面：${state.hasFrame ? `${state.width}×${state.height}，${age === null ? '' : `${(age / 1000).toFixed(1)} 秒前`}` : '还没有（面板没开摄像头）'}`,
      `已收帧：${state.frames}`,
      `亮度 / 运动：${state.hasFrame ? `${Math.round(state.luma)} / ${state.motion.toFixed(2)}` : '—'}`,
      `检测器：${vision.detectorUrl.trim() ? (state.detectorError ? `异常（${state.detectorError}）` : `${state.detections.length} 个目标`) : '没接'}`,
      `提案服务：${vision.vlaUrl.trim() ? (state.vlaError ? `异常（${state.vlaError}）` : state.proposal ? '在线' : '在线，还没算过') : '没接'}`,
      `观众：${this.sockets.size} 个面板`,
    ].join('\n');
  }

  async look(why: string): Promise<ToolOutcome> {
    const frame = this.keep.at(-1);
    const state = this.relay.snapshot();
    if (!frame) {
      return { text: `看不到：还没有画面。让操作者打开控制台的「眼睛」页（${why}）`, failed: true };
    }
    const blob: BlobInput = {
      bytes: frame.jpeg,
      mime: 'image/jpeg',
      name: `camera-${new Date(frame.ts).toISOString().replace(/[:.]/g, '-')}.jpg`,
      fallbackText: '摄像头拍的一张照片',
    };
    return { text: `${this.sceneText(state)}\n（${why}）`, blobs: [blob] };
  }

  async watch(seconds: number, why: string): Promise<ToolOutcome> {
    const before = this.relay.snapshot();
    if (!before.hasFrame) return { text: '看不了：现在还没有画面。让操作者打开「眼睛」页。', failed: true };
    const clamped = Math.min(15, Math.max(1, Math.round(seconds)));
    const startedAt = Date.now();
    const frames0 = before.frames;
    const people0 = this.people(before.detections);
    await new Promise((resolve) => setTimeout(resolve, clamped * 1000));
    const after = this.relay.snapshot();
    const observed = after.frames - frames0;
    const people1 = this.people(after.detections);
    const peak = Math.max(before.motion, after.motion);
    const lines = [
      `盯了 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒，收到 ${observed} 帧。`,
      observed === 0
        ? '这期间一帧都没来——面板关了或摄像头被占用，这段时间什么都没看见。'
        : peak > this.ctx.cfg.events.motionThreshold
          ? `画面动过（运动能量最高 ${peak.toFixed(2)}）。`
          : '画面基本没动。',
      people0 === people1
        ? `人：前后一致（${people1 ? '检测器一直在报人' : '检测器一次都没报到人'}）。`
        : `人：${people0 ? '开始时检测器报到了人' : '开始时没有'}，结束时${people1 ? '有' : '没有'}。`,
      `（${why}）`,
    ];
    return { text: lines.join('\n') };
  }

  // ── 内部 ────────────────────────────────────────────────────
  /**
   * 转译：感知（测到的）+ 提案（影子）+ 帧（时间/亮度/动静）→ 一段人话 + 面板短标签。
   * 这一层是纯函数（src/translate.ts），World 只负责把「现在的事实」递进去。
   */
  private reading(state: VisionState) {
    return translate({
      now: Date.now(),
      frame: state.hasFrame
        ? { ts: state.frameAt, w: state.width, h: state.height, luma: state.luma, motion: state.motion }
        : null,
      perception: state.perception,
      proposal: state.proposal,
      vlaError: state.vlaError,
      stallAfterMs: this.ctx.cfg.events.stallAfterMs,
      motionThreshold: this.ctx.cfg.events.motionThreshold,
    });
  }

  private sceneText(state: VisionState): string {
    return this.reading(state).summary;
  }

  private stateLine(state: VisionState): string {
    if (!state.hasFrame) return '没有画面（面板没开摄像头）';
    const age = Date.now() - state.frameAt;
    return `${this.stalled ? '闭眼中' : '出帧中'}：${state.width}×${state.height}，最后一帧 ${(age / 1000).toFixed(1)} 秒前，已收 ${state.frames} 帧`;
  }

  private telemetry(state: VisionState) {
    const { vision } = this.ctx.cfg;
    const now = Date.now();
    return {
      at: now,
      frames: state.frames,
      frameAgeMs: state.hasFrame ? now - state.frameAt : null,
      // 面板按这两个值决定「发多快」和「怎么摆」；旋钮改了立刻生效，不用重开面板。
      analysisFps: this.ctx.cfg.vision.analysisFps,
      mirror: this.ctx.cfg.mirror,
      camera: {
        hasFrame: state.hasFrame,
        width: state.width,
        height: state.height,
        luma: Math.round(state.luma),
        motion: Number(state.motion.toFixed(3)),
        frameAt: state.frameAt,
        stalled: this.stalled,
      },
      detector: {
        configured: Boolean(vision.detectorUrl.trim() || (vision.perceptionUrl ?? '').trim()),
        online: Boolean(vision.detectorUrl.trim() || (vision.perceptionUrl ?? '').trim()) && !state.detectorError,
        error: state.detectorError,
        count: state.detections.length,
        detections: state.detections,
        at: state.detectionsAt,
      },
      vla: {
        configured: Boolean(vision.vlaUrl.trim()),
        online: Boolean(vision.vlaUrl.trim()) && !state.vlaError,
        error: state.vlaError,
        proposal: state.proposal,
        analyzedAt: state.analyzedAt,
        analyzedCount: state.analyzedCount,
        analyzing: state.analyzing,
      },
      perception: {
        configured: Boolean((vision.perceptionUrl ?? '').trim()),
        online: Boolean((vision.perceptionUrl ?? '').trim()) && !state.detectorError,
        people: state.perception?.people.length ?? 0,
        faces: state.perception?.faces.length ?? 0,
        ms: state.perception?.ms ?? null,
      },
      scene: this.sceneText(state),
      cues: this.reading(state).cues,
      facts: this.reading(state).facts,
      viewers: this.sockets.size,
    };
  }

  private async push(p: {
    type: string;
    text: string;
    trigger: 'preempt' | 'flush' | 'debounce';
    meta?: Record<string, unknown>;
  }): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent(
        { type: p.type, ts: new Date().toISOString(), source: this.id, text: p.text, meta: p.meta },
        { trigger: p.trigger },
      );
    } catch (error) {
      host.log.warn(`推事件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
