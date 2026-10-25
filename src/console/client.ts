/**
 * 控制台面板：眼睛。
 *
 * 画面由浏览器自己的摄像头提供（getUserMedia），所以这个扩展没有原生依赖。
 * 面板做三件事：把画面画漂亮、把帧送给 World、把 World 的判断画回来。
 */

import type { ConsoleClientBundle, ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

interface DetectionView {
  label: string;
  score: number;
  bbox: [number, number, number, number];
}

interface ProposalView {
  waypoint: [number, number] | null;
  v: number | null;
  w: number | null;
  dist: number | null;
  latencyMs: number | null;
  at: number;
}

interface PanelState {
  t: 'state';
  at: number;
  frames: number;
  frameAgeMs: number | null;
  analysisFps: number;
  mirror: boolean;
  camera: { hasFrame: boolean; width: number; height: number; luma: number; motion: number; frameAt: number; stalled: boolean };
  detector: { configured: boolean; online: boolean; error: string | null; count: number; detections: DetectionView[]; at: number };
  vla: { configured: boolean; online: boolean; error: string | null; proposal: ProposalView | null; analyzedAt: number; analyzedCount: number; analyzing: boolean };
  scene: string;
  viewers: number;
}

const SEND_WIDTH = 640;
const SEND_HEIGHT = 360;
const SAMPLE_W = 48;
const SAMPLE_H = 27;

const q = <T extends Element>(root: ParentNode, sel: string): T | null => root.querySelector<T>(sel);

/** 把 ArrayBuffer 转 base64，分块做，避免大数组展开爆栈。 */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function chip(ctx: ConsolePanelContext, label: string): HTMLDivElement {
  const el = ctx.ui.h('div', 'cam-chip');
  el.dataset.cam = label;
  el.append(ctx.ui.h('span', 'cam-chip-k', label), ctx.ui.h('strong', 'cam-chip-v', '—'));
  return el;
}

function setChip(root: ParentNode, key: string, value: string, tone: Tone = 'idle'): void {
  const chipEl = q<HTMLElement>(root, `[data-cam="${key}"]`);
  const v = chipEl?.querySelector<HTMLElement>('.cam-chip-v');
  if (v) v.textContent = value;
  if (chipEl) chipEl.dataset.tone = tone;
}

const eye = (ctx: ConsolePanelContext): void => {
  const sheet = ctx.ui.sheet({ title: '眼睛', en: 'CAMERA / EYE', desc: '笔记本摄像头 + 检测叠加 + 提案俯视图。画面只在这里与 World 之间流动，不上传别处。' });
  ctx.root.appendChild(sheet.el);
  const body = sheet.body;

  // ── 舞台 ─────────────────────────────────────────────
  const stage = ctx.ui.h('div', 'cam-stage');
  const video = ctx.ui.h('video', 'cam-video') as HTMLVideoElement;
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  const boxes = ctx.ui.h('canvas', 'cam-boxes') as HTMLCanvasElement;
  const offline = ctx.ui.h('div', 'cam-offline', '摄像头没开');
  const chrome = ctx.ui.h('div', 'cam-chrome');
  const rec = ctx.ui.h('span', 'cam-rec', '● LIVE');
  const clock = ctx.ui.h('span', 'cam-clock', '--:--:--');
  const fps = ctx.ui.h('span', 'cam-fps', '— fps');
  chrome.append(rec, clock, fps);
  const inset = ctx.ui.h('div', 'cam-inset');
  const plot = ctx.ui.h('canvas', 'cam-plot') as HTMLCanvasElement;
  plot.width = 148;
  plot.height = 148;
  const insetLabel = ctx.ui.h('span', 'cam-inset-label', '没有提案');
  inset.append(plot, insetLabel);
  const strip = ctx.ui.h('div', 'cam-strip');
  const stripV = ctx.ui.h('span', null, 'v —');
  const stripW = ctx.ui.h('span', null, 'w —');
  const stripD = ctx.ui.h('span', null, '—');
  strip.append(ctx.ui.h('b', null, 'VLA 影子'), stripV, stripW, stripD);
  stage.append(video, boxes, chrome, inset, strip, offline);
  body.appendChild(stage);

  // ── 工具条 ───────────────────────────────────────────
  const bar = ctx.ui.h('div', 'cam-bar');
  const deviceSelect = ctx.ui.select({ cls: 'cam-device', options: [] });
  deviceSelect.setAttribute('aria-label', '摄像头设备');
  const toggleBtn = ctx.ui.button('开眼', { variant: 'primary', size: 'sm' });
  const lookBtn = ctx.ui.button('看一次', { size: 'sm' });
  const publishBtn = ctx.ui.button('发给她', { size: 'sm' });
  const forgetBtn = ctx.ui.button('清画面', { size: 'sm' });
  bar.append(ctx.ui.field('设备', deviceSelect), toggleBtn, lookBtn, publishBtn, forgetBtn);
  body.appendChild(bar);

  const status = ctx.ui.msgline('摄像头待命：点「开眼」把画面接上。');
  body.appendChild(status);

  // ── 读数 ─────────────────────────────────────────────
  const stats = ctx.ui.h('div', 'cam-stats');
  for (const label of ['帧率', '帧龄', '亮度', '动静', '检测', '提案']) stats.appendChild(chip(ctx, label));
  body.appendChild(stats);

  // ── 快照与事件 ───────────────────────────────────────
  const cols = ctx.ui.h('div', 'cam-cols');
  const snapshotCard = ctx.ui.h('div', 'cam-card');
  snapshotCard.append(
    ctx.ui.h('div', 'cam-card-k', '此刻的画面（World 读到的就是这段）'),
    ctx.ui.h('pre', 'cam-prose', '还没有画面。'),
  );
  const logCard = ctx.ui.h('div', 'cam-card');
  const log = ctx.ui.log({ max: 120, maxHeight: '188px', empty: '还没有事件：开眼之后，开眼/闭眼、有动静、人进出会记在这里。', variant: 'conversation' });
  logCard.append(ctx.ui.h('div', 'cam-card-k', '事件'), log.el);
  cols.append(snapshotCard, logCard);
  body.appendChild(cols);

  const prose = q<HTMLElement>(body, '.cam-prose')!;

  // ── 摄像头 ───────────────────────────────────────────
  const sendCanvas = document.createElement('canvas');
  sendCanvas.width = SEND_WIDTH;
  sendCanvas.height = SEND_HEIGHT;
  const sendCtx = sendCanvas.getContext('2d');
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = SAMPLE_W;
  sampleCanvas.height = SAMPLE_H;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  let previousSample: Float32Array | null = null;
  let stream: MediaStream | null = null;
  let socket: ReturnType<ConsolePanelContext['stream']> | null = null;
  let framesSent = 0;
  let sentStartedAt = 0;
  let lastState: PanelState | null = null;
  let sendFps = 2;
  let lastSentAt = 0;

  const setTone = (el: HTMLElement, tone: Tone) => {
    el.dataset.tone = tone;
  };

  const say = (text: string, bad = false) => {
    status.textContent = text;
    status.classList.toggle('bad', bad);
  };

  /** 摄像头打不开时，把原因同时送到服务端日志：面板在浏览器里，宿主看不到它。 */
  const reportCameraError = (error: unknown, stage: string) => {
    const name = error instanceof Error ? error.name : 'Unknown';
    const message = error instanceof Error ? error.message : String(error);
    try {
      socket?.send(JSON.stringify({ t: 'camera.error', stage, name, message }));
    } catch {
      /* 通道断了就只留在面板上 */
    }
    // 走 HTTP 再报一次：WS 若没连上，上面那条会静默丢掉。
    void diagnose(stage, { errorName: name, errorMessage: message.slice(0, 160) });
    return name;
  };

  /** 面板自检：宿主日志里能看到的全部事实，用来定位「为什么打不开摄像头」。 */
  const diagnose = async (stage: string, extra: Record<string, unknown> = {}) => {
    const payload: Record<string, unknown> = {
      stage,
      secure: window.isSecureContext,
      hasMediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
      socketOpen: Boolean(socket?.open),
      ua: navigator.userAgent.slice(0, 110),
      ...extra,
    };
    try {
      payload.permission = (await navigator.permissions.query({ name: 'camera' as PermissionName })).state;
    } catch {
      payload.permission = 'query-failed';
    }
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      payload.devices = list
        .filter((d) => d.kind === 'videoinput')
        .map((d) => ({ label: d.label || '(无标签：尚未授权)', id: d.deviceId.slice(0, 8) }));
    } catch (error) {
      payload.enumerateError = error instanceof Error ? error.message : String(error);
    }
    void ctx.invoke('diag', [payload]).catch(() => undefined);
  };

  const explain = (error: unknown): string => {
    const name = error instanceof Error ? error.name : 'Unknown';
    const raw = error instanceof Error ? error.message : String(error);
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '这个浏览器没被允许用摄像头。点地址栏左边的相机图标允许一次；系统层面：设置 → 隐私和安全性 → 相机 → 打开「让桌面应用访问你的相机」。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '系统里没找到摄像头设备（笔记本可能在 BIOS/设备管理器里把它关了）。';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return '摄像头被别的程序占着（会议软件、相机应用、或另一个标签页）。关掉它们再试。';
    }
    if (name === 'OverconstrainedError') {
      return '记着的那个摄像头已经不在了，我改用默认设备重试。';
    }
    if (!navigator.mediaDevices) {
      return '这个页面不是安全上下文：用 http://127.0.0.1:8848 或 https 打开，浏览器才给摄像头。';
    }
    return raw;
  };

  const stop = () => {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    video.srcObject = null;
    setTone(offline, 'idle');
    offline.hidden = false;
    rec.dataset.live = '0';
    toggleBtn.textContent = '开眼';
  };

  const drawPlot = (proposal: ProposalView | null) => {
    const g = plot.getContext('2d');
    if (!g) return;
    const size = plot.width;
    const cx = size / 2;
    const cy = size - 20;
    const range = 3;
    const scale = (size - 34) / range;
    g.clearRect(0, 0, size, size);
    g.strokeStyle = getComputedStyle(plot).getPropertyValue('--cam-line') || '#d0d2d0';
    g.lineWidth = 1;
    for (const m of [1, 2, 3]) {
      g.beginPath();
      g.setLineDash([2, 4]);
      g.arc(cx, cy, m * scale, Math.PI, 0, true);
      g.stroke();
    }
    g.setLineDash([]);
    g.fillStyle = getComputedStyle(plot).getPropertyValue('--cam-accent') || '#00a870';
    g.beginPath();
    g.arc(cx, cy, 4, 0, Math.PI * 2);
    g.fill();
    if (!proposal?.waypoint) {
      insetLabel.textContent = proposal ? '方向它没给' : '没有提案';
      return;
    }
    const [forward, left] = proposal.waypoint;
    const rawX = cx - left * scale;
    const rawY = cy - forward * scale;
    const pad = 8;
    const px = Math.min(size - pad, Math.max(pad, rawX));
    const py = Math.min(size - pad, Math.max(pad, rawY));
    g.strokeStyle = getComputedStyle(plot).getPropertyValue('--cam-warn') || '#96743b';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(px, py);
    g.stroke();
    g.fillStyle = getComputedStyle(plot).getPropertyValue('--cam-warn') || '#96743b';
    g.beginPath();
    g.arc(px, py, 5, 0, Math.PI * 2);
    g.fill();
    const clamped = px !== rawX || py !== rawY;
    insetLabel.textContent = `前 ${forward.toFixed(2)} m · 左 ${left.toFixed(2)} m${clamped ? ' · 超出视图' : ''}`;
  };

  const drawBoxes = (state: PanelState) => {
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (boxes.width !== Math.round(w * dpr) || boxes.height !== Math.round(h * dpr)) {
      boxes.width = Math.round(w * dpr);
      boxes.height = Math.round(h * dpr);
    }
    const g = boxes.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!state.detector.online || !state.camera.hasFrame) return;
    g.font = '600 11px ui-monospace, Consolas, monospace';
    g.textBaseline = 'bottom';
    for (const det of state.detector.detections) {
      const [x1, y1, x2, y2] = det.bbox;
      const x = x1 * w;
      const y = y1 * h;
      const bw = Math.max(1, (x2 - x1) * w);
      const bh = Math.max(1, (y2 - y1) * h);
      const hot = /person|人/i.test(det.label);
      g.strokeStyle = hot ? '#e0b34a' : '#5ad1a8';
      g.lineWidth = 1.5;
      g.strokeRect(x, y, bw, bh);
      const label = `${det.label} ${Math.round(det.score * 100)}%`;
      const tw = g.measureText(label).width + 8;
      g.fillStyle = 'rgba(8,16,12,.72)';
      g.fillRect(x, Math.max(0, y - 16), tw, 16);
      g.fillStyle = hot ? '#f2cf78' : '#a9f0d2';
      g.fillText(label, x + 4, Math.max(12, y - 3));
    }
  };

  const render = (state: PanelState) => {
    lastState = state;
    sendFps = Number.isFinite(state.analysisFps) && state.analysisFps > 0 ? state.analysisFps : 2;
    stage.dataset.mirror = state.mirror ? '1' : '0';
    const ageText = state.frameAgeMs === null ? '—' : state.frameAgeMs < 1000 ? `${Math.max(1, Math.round(state.frameAgeMs))} ms` : `${(state.frameAgeMs / 1000).toFixed(1)} s`;
    const sinceStart = sentStartedAt ? (Date.now() - sentStartedAt) / 1000 : 0;
    const rate = sinceStart > 0 ? framesSent / sinceStart : 0;
    setChip(body, '帧率', stream ? `${rate.toFixed(1)} fps` : '—', stream ? 'ok' : 'idle');
    setChip(body, '帧龄', ageText, state.camera.stalled ? 'bad' : state.camera.hasFrame ? 'ok' : 'idle');
    setChip(body, '亮度', state.camera.hasFrame ? String(state.camera.luma) : '—', state.camera.luma > 235 || state.camera.luma < 25 ? 'warn' : 'idle');
    setChip(body, '动静', state.camera.hasFrame ? state.camera.motion.toFixed(2) : '—', state.camera.motion > 0.08 ? 'warn' : 'idle');
    setChip(
      body,
      '检测',
      !state.detector.configured ? '没接' : state.detector.error ? '异常' : `${state.detector.count} 个`,
      !state.detector.configured ? 'idle' : state.detector.error ? 'bad' : 'ok',
    );
    setChip(
      body,
      '提案',
      !state.vla.configured ? '没接' : state.vla.error ? '离线' : state.vla.proposal ? '在线' : '待算',
      !state.vla.configured ? 'idle' : state.vla.error ? 'bad' : 'ok',
    );
    clock.textContent = new Date(state.at).toLocaleTimeString('zh-CN', { hour12: false });
    fps.textContent = `${rate.toFixed(1)} fps`;
    rec.dataset.live = stream ? '1' : '0';
    const proposal = state.vla.proposal;
    stripV.textContent = proposal && proposal.v !== null ? `v ${proposal.v.toFixed(2)} m/s` : 'v —';
    stripW.textContent = proposal && proposal.w !== null ? `w ${proposal.w > 0 ? '+' : ''}${proposal.w.toFixed(2)} rad/s` : 'w —';
    stripD.textContent = proposal && proposal.dist !== null ? `目标 ${proposal.dist.toFixed(1)} m` : '—';
    drawPlot(proposal);
    drawBoxes(state);
    prose.textContent = state.scene;
    if (state.vla.error) {
      // 提案服务离线时，俯视图要说出原因，而不是留一张空图。
      insetLabel.textContent = `离线：${state.vla.error}`;
    }
  };

  const sendFrame = () => {
    if (!socket || !socket.open || !video.videoWidth || !sendCtx || !sampleCtx) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    sendCtx.drawImage(video, 0, 0, SEND_WIDTH, SEND_HEIGHT);
    sampleCtx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
    const data = sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    const gray = new Float32Array(SAMPLE_W * SAMPLE_H);
    let sum = 0;
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      const v = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      gray[p] = v;
      sum += v;
    }
    let motion = 0;
    if (previousSample) {
      let diff = 0;
      for (let i = 0; i < gray.length; i += 1) diff += Math.abs(gray[i] - previousSample[i]);
      motion = diff / gray.length / 255;
    }
    previousSample = gray;
    const luma = sum / gray.length;
    sendCanvas.toBlob((blob) => {
      if (!blob || !socket?.open) return;
      void blob.arrayBuffer().then((buffer) => {
        if (!socket?.open) return;
        if (!sentStartedAt) sentStartedAt = Date.now();
        framesSent += 1;
        socket.send(JSON.stringify({ t: 'frame', jpeg: toBase64(buffer), w: vw, h: vh, luma, motion }));
      });
    }, 'image/jpeg', 0.62);
  };

  const start = async (deviceId?: string): Promise<void> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      const reason = '不是安全上下文或浏览器不支持 getUserMedia';
      say(`打不开摄像头：${reason}。用 http://127.0.0.1:8848 或 https 打开。`, true);
      reportCameraError({ name: 'NoMediaDevices', message: reason } as unknown as Error, 'start');
      throw new Error(reason);
    }
    try {
      const cfgText = (ctx.memo.get('device', '') as string) || '';
      const desired = deviceId ?? cfgText;
      stream = await navigator.mediaDevices.getUserMedia({
        video: desired ? { deviceId: { exact: desired }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      offline.hidden = true;
      setTone(offline, 'ok');
      toggleBtn.textContent = '闭眼';
      framesSent = 0;
      sentStartedAt = 0;
      say('画面接上了。帧只在这台机器上流动。');
      await refreshDevices();
    } catch (error) {
      stream = null;
      offline.hidden = false;
      const name = reportCameraError(error, 'start');
      // 记着的设备不在了：清掉记忆，改用默认设备再试一次，而不是让操作者猜。
      if (name === 'OverconstrainedError' && deviceId === undefined && ctx.memo.get('device', '') !== '') {
        ctx.memo.set('device', '');
        say('那个摄像头不在了，改用默认设备重试…', false);
        return start();
      }
      say(`打不开摄像头：${explain(error)}`, true);
      throw error;
    }
  };

  const refreshDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === 'videoinput');
      const current = stream?.getVideoTracks()[0]?.getSettings().deviceId ?? ctx.memo.get('device', '') as string;
      deviceSelect.replaceChildren(...cams.map((cam, index) => {
        const opt = document.createElement('option');
        opt.value = cam.deviceId;
        opt.textContent = cam.label || `摄像头 ${index + 1}`;
        if (cam.deviceId === current) opt.selected = true;
        return opt;
      }));
      if (!cams.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '没有找到摄像头';
        deviceSelect.replaceChildren(opt);
      }
    } catch {
      /* 列举失败不影响画面 */
    }
  };

  deviceSelect.addEventListener('change', () => {
    ctx.memo.set('device', deviceSelect.value);
    if (!stream) return;
    stop();
    void start(deviceSelect.value).catch(() => undefined);
  }, { signal: ctx.signal });

  toggleBtn.addEventListener('click', () => {
    if (stream) {
      stop();
      say('画面已关，摄像头放了。');
      return;
    }
    void start().catch(() => undefined);
  }, { signal: ctx.signal });

  lookBtn.addEventListener('click', () => {
    void ctx.invokeBinary('snapshot')
      .then((blob) => ctx.own(ctx.ui.lightbox(URL.createObjectURL(blob), '现在的画面')))
      .catch((error) => ctx.ui.toast(error instanceof Error ? error.message : String(error), 'bad'));
  }, { signal: ctx.signal });

  publishBtn.addEventListener('click', () => {
    void ctx.invoke<{ text?: string }>('publish')
      .then((res) => {
        log.append(`操作者发出一眼：${res.text ?? '已发送'}`, 'plain');
        ctx.ui.toast('已经交给她了', 'ok');
      })
      .catch((error) => ctx.ui.toast(error instanceof Error ? error.message : String(error), 'bad'));
  }, { signal: ctx.signal });

  forgetBtn.addEventListener('click', () => {
    void ctx.invoke<{ text?: string }>('forget').then(() => ctx.ui.toast('内存里的画面已清空', 'ok')).catch(() => undefined);
  }, { signal: ctx.signal });

  // ── 推送 ─────────────────────────────────────────────
  socket = ctx.stream({
    open() {
      void refreshDevices();
      void ctx.invoke<PanelState>('state').then(render).catch(() => undefined);
    },
    message(text) {
      let parsed: PanelState;
      try {
        parsed = JSON.parse(text) as PanelState;
      } catch {
        return;
      }
      if (parsed.t === 'state') render(parsed);
    },
    close() {
      setChip(body, '帧率', '断线', 'bad');
    },
  });

  ctx.interval(() => {
    const gap = 1000 / Math.max(0.2, sendFps);
    if (Date.now() - lastSentAt < gap) return;
    lastSentAt = Date.now();
    sendFrame();
  }, 100);
  void refreshDevices();
  // 面板一挂上就自检一次：设备、权限、安全上下文、推送通道，全部落进宿主日志。
  void diagnose('mount');

  // 首帧之后按配置的分析帧率发；这里用固定 2 Hz，与服务端默认一致，
  // 旋钮改了下次打开面板生效（面板不猜服务端改了什么）。
  ctx.timeout(() => {
    if (!stream) say('点「开眼」把摄像头接上；画面只留在本机与 World 之间。');
  }, 1200);

  // 视野尺寸变化时重画叠加层，别等下一次状态推送。
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      if (lastState) drawBoxes(lastState);
    });
    observer.observe(stage);
    ctx.own({ dispose: () => observer.disconnect() });
  }
};

const tune = (ctx: ConsolePanelContext): void => {
  const sheet = ctx.ui.sheet({ title: '调校', en: 'CAMERA / TUNING', desc: '这只眼睛怎么工作。改完立即写回 worlds.camera，不需要重启。' });
  ctx.root.appendChild(sheet.el);
  const body = sheet.body;
  const kv = ctx.ui.kv([
    { k: '内存里留几帧', v: '只为「看一次」；不落盘' },
    { k: '分析帧率', v: '送检测器/提案服务的频率，不影响预览' },
    { k: '动静阈值', v: '超过它才报「有动静」' },
    { k: '闭眼判定', v: '多久没收到帧算闭眼' },
  ]);
  body.appendChild(kv);
  const note = ctx.ui.msgline('改这些要在这页的配置组里改；面板只读，不替你写配置。');
  body.appendChild(note);
};

const bundle: ConsoleClientBundle = { panels: { eye: { mount: eye }, tune: { mount: tune } } };
export default bundle;
