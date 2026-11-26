// 只读：极简 MIDI 解析 + 与两种播放顺序的音符密度对照
// 用法：... tools/midi-probe.mjs .tmp/cancan.mid "<score.mscz>"
import fs from 'node:fs';
import { readMscxFromMscz } from '../src/zip.js';
import { parseMscx } from '../src/mscx.js';

const midPath = process.argv[2];
const scorePath = process.argv[3];
const buf = fs.readFileSync(midPath);
let p = 0;
const rd = (n) => { const v = buf.subarray(p, p + n); p += n; return v; };
const u32 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };
const u16 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
const vlq = () => { let v = 0, b; do { b = buf[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };

if (buf.toString('ascii', 0, 4) !== 'MThd') throw new Error('不是 MIDI');
p = 4;
const hlen = u32();
const format = u16();
const ntrk = u16();
const division = u16();
p = 8 + hlen;

const tempos = [];
const notes = []; // {tick, midi}
let abs = 0;
for (let tr = 0; tr < ntrk && p < buf.length; tr++) {
  const id = buf.toString('ascii', p, p + 4); p += 4;
  const len = u32();
  const end = p + len;
  let tick = 0;
  let running = 0;
  while (p < end) {
    const delta = vlq();
    tick += delta;
    let status = buf[p];
    if (status & 0x80) p++; else status = running;
    running = status;
    const type = status & 0xf0;
    if (status === 0xff) {
      const meta = buf[p++];
      const mlen = vlq();
      if (meta === 0x51) {
        const us = (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2];
        tempos.push({ tick, bpm: 60000000 / us });
      }
      p += mlen;
    } else if (status === 0xf0 || status === 0xf7) {
      const mlen = vlq(); p += mlen;
    } else if (type === 0x90 || type === 0x80) {
      const note = buf[p++];
      const vel = buf[p++];
      if (type === 0x90 && vel > 0) notes.push({ tick, midi: note });
    } else if (type === 0xc0 || type === 0xd0) {
      p += 1;
    } else {
      p += 2;
    }
  }
  p = end;
}

// tick → 秒
const pts = [{ tick: 0, bpm: 120, seconds: 0 }];
for (const t of tempos.sort((a, b) => a.tick - b.tick)) {
  const last = pts[pts.length - 1];
  if (t.tick === last.tick) { last.bpm = t.bpm; continue; }
  if (t.tick < last.tick) continue;
  pts.push({ tick: t.tick, bpm: t.bpm, seconds: last.seconds + ((t.tick - last.tick) / division) * (60 / last.bpm) });
}
const sec = (tick) => {
  let q = pts[0];
  for (const x of pts) if (x.tick <= tick) q = x;
  return q.seconds + ((tick - q.tick) / division) * (60 / q.bpm);
};

const lastNote = notes.reduce((m, n) => Math.max(m, sec(n.tick)), 0);
console.log(`MIDI: 格式 ${format}, ${ntrk} 轨, division ${division}, 音符 ${notes.length}, 最后一声 ${lastNote.toFixed(2)}s`);
console.log(` tempo: ${tempos.map((t) => `${t.bpm.toFixed(1)}@${sec(t.tick).toFixed(2)}s`).join(' ')}`);

// 按 0.7692307s（2/4 @156）切小节，统计每小节音符数
const MEAS = 960 / division * (60 / 156);
const buckets = new Map();
for (const n of notes) {
  const k = Math.floor(sec(n.tick) / MEAS + 1e-6);
  buckets.set(k, (buckets.get(k) || 0) + 1);
}
const maxM = Math.max(...buckets.keys());
const midiCounts = Array.from({ length: maxM + 1 }, (_, k) => buckets.get(k) || 0);
console.log(` 小节长 ${MEAS.toFixed(4)}s，共 ${midiCounts.length} 个播放小节`);
console.log(` 每小节音符数: ${midiCounts.join(',')}`);

// ---- 对照两种顺序 ----
const ab = fs.readFileSync(scorePath);
const text = await readMscxFromMscz(ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength));
const parsed = parseMscx(text);
const staffBlocks = [...text.matchAll(/<Staff id="(\d+)">([\s\S]*?)<\/Staff>/g)].map((m) => m[2]);
const perMeasure = (xml) => [...xml.matchAll(/<Measure\b[^>]*>[\s\S]*?<\/Measure>/g)].map((x) => x[0]);
const s1 = perMeasure(staffBlocks[0]);
const s2 = perMeasure(staffBlocks[1] ?? '');
const cnt = (x) => (x.match(/<Note\b/g) || []).length;
const notesBy = s1.map((x, i) => cnt(x) + (s2[i] ? cnt(s2[i]) : 0));
const N = s1.length;

const start = new Array(N).fill(false), end = new Array(N).fill(false), rc = new Array(N).fill(0), mrep = new Array(N).fill(false);
const vspan = new Array(N).fill(0), vend = new Array(N).fill(null);
for (let i = 0; i < N; i++) {
  const x = s1[i] || '';
  if (/<startRepeat\b/.test(x)) start[i] = true;
  if (/<endRepeat\b/.test(x)) end[i] = true;
  const m = /<repeatCount>(\d+)<\/repeatCount>/.exec(x); if (m) rc[i] = Number(m[1]);
  if (/<measureRepeatCount>/.test(x)) mrep[i] = true;
  for (const v of x.matchAll(/<Spanner type="Volta">([\s\S]*?)<\/Spanner>/g)) {
    const e = /<endings>([\d,]+)<\/endings>/.exec(v[1]);
    if (!e) continue;
    vspan[i] = Number(/<next>\s*<location>\s*<measures>(\d+)<\/measures>/.exec(v[1])?.[1] ?? 1);
    vend[i] = e[1].split(',').map(Number);
  }
}

function buildOrder(volta) {
  const order = [];
  let i = 0, sectionStart = -1, sectionOpen = false, curPass = 1, guard = 0, justJumped = false;
  const voltaSec = [], voltaOf = new Array(N).fill(-1);
  if (volta) {
    for (let k = 0; k < N; k++) {
      if (!vspan[k] || !vend[k]) continue;
      const sec = { start: k, end: Math.min(N, k + vspan[k]) - 1, endings: vend[k] };
      voltaSec.push(sec);
      for (let j = sec.start; j <= sec.end; j++) voltaOf[j] = voltaSec.length - 1;
    }
  }
  while (i < N && guard++ < N * 8 + 16) {
    if (start[i] && !justJumped) { sectionStart = i; sectionOpen = true; curPass = 1; }
    justJumped = false;
    if (volta && voltaOf[i] >= 0) {
      const sec = voltaSec[voltaOf[i]];
      let containsEnd = -1;
      for (let j = sec.start; j <= sec.end; j++) if (end[j]) containsEnd = j;
      if (!sec.endings.includes(curPass)) {
        if (containsEnd >= 0 && sectionOpen) {
          const times = rc[containsEnd] > 0 ? rc[containsEnd] : 2;
          curPass++;
          if (curPass <= times) { justJumped = true; i = sectionStart; }
          else { sectionOpen = false; curPass = times; i = sec.end + 1; }
        } else i = sec.end + 1;
        continue;
      }
    }
    order.push(i);
    if (end[i]) {
      const times = rc[i] > 0 ? rc[i] : 2;
      if (curPass < times) { curPass++; justJumped = true; i = sectionStart; continue; }
      sectionOpen = false;
    }
    i++;
  }
  return order;
}

const model = (order) => order.map((mi) => (mrep[mi] && mi > 0 ? notesBy[mi - 1] : notesBy[mi]));

for (const volta of [false, true]) {
  const order = buildOrder(volta);
  const counts = model(order);
  const mine = counts.join(',');
  const theirs = midiCounts.join(',');
  let diff = 0;
  const n = Math.min(counts.length, midiCounts.length);
  let firstBad = -1;
  for (let k = 0; k < n; k++) {
    if (counts[k] !== midiCounts[k]) { diff++; if (firstBad < 0) firstBad = k; }
  }
  console.log(`\n=== ${volta ? 'volta' : '朴素'} === 小节 ${order.length}，音符 ${counts.reduce((a, b) => a + b, 0)}`);
  console.log(` 与 MIDI 每小节音符数不一致的小节数: ${diff}/${n}，第一个不一致: 第 ${firstBad + 1} 个播放小节`);
  if (firstBad >= 0) {
    console.log(` 我: ${counts.slice(Math.max(0, firstBad - 2), firstBad + 8).join(',')}`);
    console.log(` 它: ${midiCounts.slice(Math.max(0, firstBad - 2), firstBad + 8).join(',')}`);
  }
  console.log(` 我全集尾部: ${counts.slice(-8).join(',')}  它尾部: ${midiCounts.slice(-8).join(',')}`);
}
