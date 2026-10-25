/**
 * 端到端演示：一张图 → 感知 sidecar → AI 转译 → 人话。
 *
 *   node node_modules/tsx/dist/cli.mjs packages/cortico-world-camera/tools/demo-translate.ts <图片> [感知地址]
 *
 * 不碰 World、不碰面板：单独验证「测到 → 推出来 → 写成人话」这条链。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { translate, type Perception } from '../src/translate.ts';

const file = process.argv[2];
const url = process.argv[3] ?? 'http://127.0.0.1:9402/perceive';
if (!file) {
  console.error('用法: demo-translate.ts <图片> [感知地址]');
  process.exit(2);
}

const bytes = readFileSync(file);
const started = Date.now();
const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ image: bytes.toString('base64') }),
});
const perception = (await response.json()) as Perception;
const roundTrip = Date.now() - started;

const reading = translate({
  now: Date.now(),
  frame: { ts: Date.now() - roundTrip, w: perception.image?.w ?? 0, h: perception.image?.h ?? 0, luma: 128, motion: 0.03 },
  perception,
  proposal: { waypoint: [0.94, -0.15], v: 0.08, w: -0.4, dist: 12.4, latencyMs: 216, at: Date.now() - 240 },
  vlaError: null,
  stallAfterMs: 6000,
  motionThreshold: 0.08,
});

const stem = basename(file).replace(/\.[^.]+$/, '');
writeFileSync(`packages/cortico-world-camera/tools/perception-${stem}.json`, JSON.stringify(perception, null, 2), 'utf8');

console.log(`# ${basename(file)} · ${bytes.length} B · 感知 HTTP ${response.status} · ${roundTrip} ms · ${JSON.stringify(perception.ms ?? {})}`);
console.log('');
console.log(reading.summary);
console.log('');
console.log('cues :', reading.cues.join(' · '));
console.log('facts:', JSON.stringify(reading.facts, null, 0));
