/**
 * AI 转译层：把「测到的东西」和「推出来的东西」分成两摞，再写成一句人话。
 *
 * 这一层是**纯函数**，不碰网络、不碰 DOM、不认识任何模型名。它只做三件事：
 *   1. 把 sidecar 的原始感知（框 / 关键点 / 脸）压成可读的事实；
 *   2. 把推断（朝向、手势、距离）打上「推断 + 假设」的标签，绝不与事实混写；
 *   3. 生成面板用的短标签（cues），与给模型读的散文（summary）。
 *
 * 纪律：没有检测就说没检测；没画面就说没画面；看不见的五种原因分开说。
 */

export type BBox = [number, number, number, number];

export interface PerceivedObject {
  label: string;
  score: number;
  bbox: BBox;
}

export interface PerceivedPose {
  facing: string;
  facing_confidence: number;
  facing_basis: string;
  hand: string;
  hand_confidence: number;
  inferred: boolean;
  assumption?: string;
}

export interface PerceivedPerson {
  bbox: BBox;
  pose: PerceivedPose;
  keypoints: Record<string, [number, number, number]>;
  height_px: number;
  distance_m: number;
  distance_est: boolean;
}

export interface Perception {
  ok: boolean;
  error?: string;
  image: { w: number; h: number };
  objects: PerceivedObject[];
  people: PerceivedPerson[];
  faces: BBox[];
  ms?: Record<string, number>;
}

export interface ProposalView {
  waypoint: [number, number] | null;
  v: number | null;
  w: number | null;
  dist: number | null;
  latencyMs: number | null;
  at: number;
}

export interface FrameMeta {
  ts: number;
  w: number;
  h: number;
  luma: number;
  motion: number;
}

export interface TranslateInput {
  now: number;
  frame: FrameMeta | null;
  perception: Perception | null;
  proposal: ProposalView | null;
  vlaError: string | null;
  stallAfterMs: number;
  motionThreshold: number;
}

export interface Reading {
  /** 给模型读的散文。 */
  summary: string;
  /** 面板用的短标签。 */
  cues: string[];
  facts: {
    hasFrame: boolean;
    stale: boolean;
    people: number;
    objects: string[];
    faces: number;
    nearestM: number | null;
    attention: '正面' | '侧身' | '背对' | '看不清' | '无人';
    hands: string[];
    vla: 'online' | 'offline' | 'unconfigured';
  };
}

function age(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} 毫秒前`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒前`;
  return `${Math.round(ms / 60_000)} 分钟前`;
}

function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function brightness(luma: number): string {
  if (luma < 30) return '很暗（几乎全黑）';
  if (luma < 70) return '偏暗';
  if (luma < 170) return '亮度正常';
  if (luma < 225) return '偏亮';
  return '过曝（一片白）';
}

/** 「正面 / 侧身 / 背对」统一到一个词，面板与散文用同一套。 */
export function attentionOf(facing: string): '正面' | '侧身' | '背对' | '看不清' {
  if (facing.includes('正')) return '正面';
  if (facing.includes('背')) return '背对';
  if (facing.includes('侧')) return '侧身';
  return '看不清';
}

function horizontal(bbox: BBox): '左' | '中' | '右' {
  const cx = (bbox[0] + bbox[2]) / 2;
  if (cx < 1 / 3) return '左';
  if (cx > 2 / 3) return '右';
  return '中';
}

export function translate(input: TranslateInput): Reading {
  const { now, frame, perception, proposal, vlaError } = input;
  const cues: string[] = [];
  const lines: string[] = [];

  if (!frame) {
    return {
      summary: '【眼睛】还没有画面。控制台的「眼睛」页没打开摄像头，或者浏览器没给权限。',
      cues: ['无画面'],
      facts: { hasFrame: false, stale: true, people: 0, objects: [], faces: 0, nearestM: null, attention: '无人', hands: [], vla: 'unconfigured' },
    };
  }

  const frameAge = now - frame.ts;
  const stale = frameAge > Math.max(2000, input.stallAfterMs / 2);
  lines.push(`【眼睛】${clock(frame.ts)} 的画面（${age(frameAge)}${stale ? '，已陈旧，别当现在用' : ''}）`);

  const moving = frame.motion > input.motionThreshold;
  lines.push(`画面 ${frame.w}×${frame.h}，${brightness(frame.luma)}；${moving ? '画面在动' : '画面基本静止'}（运动能量 ${frame.motion.toFixed(2)}）。`);

  const people = perception?.people ?? [];
  const objects = perception?.objects ?? [];
  const faces = perception?.faces ?? [];

  // ── 测到的：框 ──
  const counts = new Map<string, number>();
  for (const obj of objects) counts.set(obj.label, (counts.get(obj.label) ?? 0) + 1);
  if (!perception) {
    lines.push('没有接感知服务：这一帧只有像素，没有框、没有骨架。');
  } else if (!perception.ok) {
    lines.push(`感知服务报错（${perception.error ?? '原因不明'}），以下只有画面本身。`);
  } else if (counts.size === 0) {
    lines.push('这一帧里检测器没报任何目标（这不等于画面里没人）。');
  } else {
    const list = [...counts.entries()].map(([k, n]) => `${k}×${n}`).join('、');
    const where = objects
      .slice(0, 3)
      .map((o) => `${o.label}（画面${horizontal(o.bbox)}）`)
      .join('；');
    lines.push(`测到：${list}。${where}。`);
  }

  // ── 推出来的：朝向、手势、距离（全部标注推断 + 假设）──
  let nearestM: number | null = null;
  let attention: Reading['facts']['attention'] = '无人';
  const hands: string[] = [];
  if (people.length) {
    const sorted = [...people].sort((a, b) => (a.distance_m ?? 9e9) - (b.distance_m ?? 9e9));
    const closest = sorted[0];
    nearestM = Number.isFinite(closest.distance_m) ? closest.distance_m : null;
    const facings = people.map((p) => attentionOf(p.pose.facing));
    attention = facings.includes('正面') ? '正面' : facings.includes('侧身') ? '侧身' : facings.includes('背对') ? '背对' : '看不清';
    for (const p of people) {
      const hand = String(p.pose.hand ?? '');
      if (hand.includes('抬起')) hands.push(hand.replace('抬起', '举起'));
    }
    const basis = people.map((p) => p.pose.facing_basis).filter(Boolean);
    const assumption = people.find((p) => p.pose.assumption)?.pose.assumption;
    lines.push(
      `人 ${people.length} 个${nearestM !== null ? `，最近的约 ${nearestM.toFixed(1)} 米（估）` : ''}；` +
        `朝向以「${attention}」为主（推断：${[...new Set(basis)].join('；')}）。` +
        (hands.length ? `${[...new Set(hands)].join('、')}（推断）。` : ''),
    );
    if (assumption) lines.push(`推断的假设：${assumption}。`);
  } else if (perception?.ok) {
    lines.push('这一帧没有骨架可读：要么没人，要么人只露了背影/被画面裁掉。');
  }

  if (faces.length) lines.push(`画面里有 ${faces.length} 张脸能被认出来（正脸检测）。`);

  // ── 提案（影子）──
  if (vlaError) {
    lines.push(`提案服务没回话（${vlaError}），所以没有提案。`);
  } else if (proposal) {
    const wp = proposal.waypoint;
    const where = wp ? `前方 ${wp[0].toFixed(2)} 米、左 ${wp[1].toFixed(2)} 米` : '方向它没给';
    const speed = proposal.v !== null || proposal.w !== null
      ? `${proposal.v === null ? '?' : proposal.v.toFixed(2)} 米/秒、${proposal.w === null ? '?' : `${proposal.w > 0 ? '左' : '右'}转 ${Math.abs(proposal.w).toFixed(2)}`} 弧度/秒`
      : '速度没给';
    lines.push(`提案（影子，不驱动）：${where}；${speed}；${age(now - proposal.at)}算的。`);
  }

  lines.push('看不到：身后 180°、身体两侧、以及被挡住的东西——相机只有一只眼睛。');

  cues.push(`人 ${people.length}`);
  if (attention !== '无人') cues.push(attention);
  if (nearestM !== null) cues.push(`约 ${nearestM.toFixed(1)} m（估）`);
  if (hands.length) cues.push([...new Set(hands)].join('/'));
  if (faces.length) cues.push(`脸 ${faces.length}`);

  const vla: Reading['facts']['vla'] = vlaError ? 'offline' : proposal ? 'online' : 'unconfigured';

  return {
    summary: lines.join('\n'),
    cues,
    facts: {
      hasFrame: true,
      stale,
      people: people.length,
      objects: [...counts.keys()],
      faces: faces.length,
      nearestM,
      attention,
      hands: [...new Set(hands)],
      vla,
    },
  };
}
