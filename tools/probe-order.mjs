// 只读探针：比较"朴素两遍"与"volta 正确展开"两种播放顺序的音符数与时长
import fs from 'node:fs';
import { readMscxFromMscz } from '../src/zip.js';
import { parseMscx } from '../src/mscx.js';
import { buildTempoMap } from '../src/score.js';

const file = process.argv[2];
const ab = fs.readFileSync(file);
const text = await readMscxFromMscz(ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength));
const parsed = parseMscx(text);

const staffBlocks = [...text.matchAll(/<Staff id="(\d+)">([\s\S]*?)<\/Staff>/g)].map((m) => m[2]);
const N = parsed.measures.length ? Math.max(...parsed.measures.map((m) => m.index)) + 1 : 0;

function perMeasure(xml) {
  return [...xml.matchAll(/<Measure\b[^>]*>[\s\S]*?<\/Measure>/g)].map((x) => x[0]);
}

const staff1 = perMeasure(staffBlocks[0]);
const staff2 = perMeasure(staffBlocks[1] ?? '');
const countNotes = (xml) => (xml.match(/<Note\b/g) || []).length;
const notesByMeasure = staff1.map((xml, i) => countNotes(xml) + (staff2[i] ? countNotes(staff2[i]) : 0));

// 结构
const start = new Array(N).fill(false);
const end = new Array(N).fill(false);
const repeatCount = new Array(N).fill(0);
const mRep = new Array(N).fill(false);
const voltaSpan = new Array(N).fill(0); // 0 = 无
const voltaEndings = new Array(N).fill(null);

for (let i = 0; i < N; i++) {
  const xml = staff1[i] || '';
  if (/<startRepeat\b/.test(xml)) start[i] = true;
  if (/<endRepeat\b/.test(xml)) end[i] = true;
  const rc = /<repeatCount>(\d+)<\/repeatCount>/.exec(xml);
  if (rc) repeatCount[i] = Number(rc[1]);
  if (/<measureRepeatCount>/.test(xml)) mRep[i] = true;
  for (const v of xml.matchAll(/<Spanner type="Volta">([\s\S]*?)<\/Spanner>/g)) {
    const e = /<endings>([\d,]+)<\/endings>/.exec(v[1]);
    if (!e) continue; // 无 endings 的是排版续接，忽略
    const span = Number(/<next>\s*<location>\s*<measures>(\d+)<\/measures>/.exec(v[1])?.[1] ?? 1);
    voltaSpan[i] = span;
    voltaEndings[i] = e[1].split(',').map(Number);
  }
}

/** 展开播放顺序；volta=true 时按 endings 跳过不适合本遍的结尾段 */
function buildOrder(volta) {
  const order = [];
  let i = 0;
  let sectionStart = -1;
  let sectionOpen = false;
  let curPass = 1;
  let guard = 0;
  let justJumped = false;
  const limit = N * 8 + 16;
  const voltaSec = [];
  const voltaOf = new Array(N).fill(-1);
  if (volta) {
    for (let k = 0; k < N; k++) {
      if (!voltaSpan[k] || !voltaEndings[k]) continue;
      const sec = { start: k, end: Math.min(N, k + voltaSpan[k]) - 1, endings: voltaEndings[k] };
      voltaSec.push(sec);
      for (let j = sec.start; j <= sec.end; j++) voltaOf[j] = voltaSec.length - 1;
    }
  }
  while (i < N && guard++ < limit) {
    if (start[i] && !justJumped) {
      sectionStart = i;
      sectionOpen = true;
      curPass = 1;
    }
    justJumped = false;
    if (volta && voltaOf[i] >= 0) {
      const sec = voltaSec[voltaOf[i]];
      const containsEnd = (() => {
        for (let j = sec.start; j <= sec.end; j++) if (end[j]) return j;
        return -1;
      })();
      if (!sec.endings.includes(curPass)) {
        if (containsEnd >= 0 && sectionOpen) {
          const times = repeatCount[containsEnd] > 0 ? repeatCount[containsEnd] : 2;
          curPass++;
          if (curPass <= times) {
            justJumped = true;
            i = sectionStart;
          } else {
            sectionOpen = false;
            curPass = times;
            i = sec.end + 1;
          }
        } else {
          i = sec.end + 1;
        }
        continue;
      }
    }
    order.push(i);
    if (end[i]) {
      const times = repeatCount[i] > 0 ? repeatCount[i] : 2;
      if (curPass < times) {
        curPass++;
        justJumped = true;
        i = sectionStart;
        continue;
      }
      sectionOpen = false; // pass 停在最后一值，供段后的第 2 结尾使用
    }
    i++;
  }
  return order;
}

function totalNotes(order, withMRep) {
  let n = 0;
  for (const mi of order) {
    if (withMRep && mRep[mi] && mi > 0) n += notesByMeasure[mi - 1];
    else n += notesByMeasure[mi];
  }
  return n;
}

const TICK_PER_MEASURE = 960;
const pts = buildTempoMap(parsed.tempos, parsed.division);
const secAt = (tick) => {
  let p = pts[0];
  for (const q of pts) if (q.tick <= tick) p = q;
  return p.seconds + ((tick - p.tick) / parsed.division) * (60 / p.bpm);
};

for (const volta of [false, true]) {
  const order = buildOrder(volta);
  const ticks = order.length * TICK_PER_MEASURE;
  console.log(
    `\n=== ${volta ? 'volta 正确展开' : '朴素两遍（当前代码）'} ===`,
    `\n  小节数 ${order.length}（谱面 ${N}）  时长 ${secAt(ticks).toFixed(2)}s` +
      `\n  音符 ${totalNotes(order, false)}  +mRep ${totalNotes(order, true)}` +
      `\n  前 40: ${order.slice(0, 40).map((x) => x + 1).join(',')}`,
  );
}
console.log(`\nMIDI 参考（上一轮实测）：音符 2026，最后一声 131.54s，音频 136.15s`);
