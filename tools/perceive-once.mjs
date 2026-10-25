// 打一发真帧进感知 sidecar，打印它「测到什么」和「推了什么」。
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const url = process.argv[3] ?? 'http://127.0.0.1:9402/perceive';
const bytes = readFileSync(file);
const started = Date.now();
const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ image: bytes.toString('base64') }),
});
const text = await response.text();
console.log(`${file} (${bytes.length} B) -> HTTP ${response.status} in ${Date.now() - started} ms`);
try {
  const json = JSON.parse(text);
  console.log(JSON.stringify(json, null, 2).slice(0, 2600));
} catch {
  console.log(text.slice(0, 600));
}
