// 只读：把"朴素/volta 两种播放顺序"各自算出的音符时间，与 MuseScore 导出的 MIDI 逐音对照
// 用法：... tools/probe-compare.mjs .tmp/cancan.mid "<score.mscz>"
import fs from 'node:fs';
import { readMscxFromMscz } from '../src/zip.js';
import { parseMscx } from '../src/mscx.js';

const midPath = process.argv[2];
const scorePath = process.argv[3];
const buf = fs.readFileSync(midPath);
let p = 0;
const u32 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };
const u16 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
const vlq = () => { let v = 0, b; do { b = buf[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
p = 4;
const hlen = u32(); u16(); const ntrk = u16(); const division = u16();
p = 8 + hlen;
const tempos = [];
const midiNotes = [];
for (let tr = 0; tr < ntrk && p < buf.length; tr++) {
  p += 4; const len = u32(); const end = p + len; let tick = 0, running = 0;
  while (p < end) {
    tick += vlq();
    let status = buf[p]; if (status & 0x80) p++; else status = running;
    running = status;
    const type = status & 0xf0;
    if (status === 0xff) { const meta = buf[p++]; const mlen = vlq(); if (meta === 0x51) tempos.push({ tick, bpm: 60000000 / ((buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2]) }); p += mlen; }
    else if (status === 0xf0 || status === 0xf7) { p += vlq(); }
    else if (type === 0x90 || type === 0x80) { const note = buf[p++]; const vel = buf[p++]; if (type === 0x90 && vel > 0) midiNotes.push({ tick, midi: note }); }
    else if (type === 0xc0 || type === 0xd0) p += 1;
    else p += 2;
  }
  p = end;
}
const pts = [{ tick: 0, bpm: 120, seconds: 0 }];
for (const t of tempos.sort((a, b) => a.tick - b.tick)) {
  const last = pts[pts.length - 1];
  if (t.tick === last.tick) { last.bpm = t.bpm; continue; }
  if (t.tick < last.tick) continue;
  pts.push({ tick: t.tick, bpm: t.bpm, seconds: last.seconds + ((t.tick - last.tick) / division) * (60 / last.bpm) });
}
const midiSec = (tick) => { let q = pts[0]; for (const x of pts) if (x.tick <= tick) q = x; return q.seconds + ((tick - q.tick) / division) * (60 / q.bpm); };
const midiRows = midiNotes.map((n) => ({ midi: n.midi, t: midiSec(n.tick) })).sort((a, b) => a.t - b.t);

const ab = fs.readFileSync(scorePath);
const text = await readMscxFromMscz(ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength));

// ---- 结构 → 顺序 ----
const staffBlocks = [...text.matchAll(/<Staff id="(\d+)">([\s\S]*?)<\/Staff>/g)].map((m) => m[2]);
const perMeasure = (xml) => [...xml.matchAll(/<Measure\b[^>]*>[\s\S]*?<\/Measure>/g)].map((x) => x[0]);
const s1 = perMeasure(staffBlocks[0]);
const s2 = perMeasure(staffBlocks[1] ?? '');
const N = s1.length;
const start = new Array(N).fill(false), end = new Array(N).fill(false), rc = new Array(N).fill(0), mrep = new Array(N).fill(false);
const vspan = new Array(N).fill(0), vend = new Array(N).fill(null);
const notesBy = s1.map((x, i) => (x.match(/<Note\b/g) || []).length + (s2[i] ? (s2[i].match(/<Note\b/g) || []).length : 0));
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
  if (volta) for (let k = 0; k < N; k++) {
    if (!vspan[k] || !vend[k]) continue;
    const sec = { start: k, end: Math.min(N, k + vspan[k]) - 1, endings: vend[k] };
    voltaSec.push(sec);
    for (let j = sec.start; j <= sec.end; j++) voltaOf[j] = voltaSec.length - 1;
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
    if (end[i]) { const times = rc[i] > 0 ? rc[i] : 2; if (curPass < times) { curPass++; justJumped = true; i = sectionStart; continue; } sectionOpen = false; }
    i++;
  }
  return order;
}

const parsed = parseMscx(text);

// ---- 我们的音符（tick → 秒，单速 156 BPM）----
const TICK = 960;
const secOfTick = (tick) => (tick / parsed.division) * (60 / 156);
const ourRows = parsed.notes.map((n) => ({ midi: n.midi, t: secOfTick(n.tick) })).sort((a, b) => a.t - b.t);
console.log(`解析: ${parsed.stats.measures} 小节, ${ourRows.length} 音, 最后一声 ${ourRows[ourRows.length - 1].t.toFixed(2)}s`);

function score2(our) {
  // 逐音最近邻（同音高）
  const byPitch = new Map();
  for (const r of our) {
    if (!byPitch.has(r.midi)) byPitch.set(r.midi, []);
    byPitch.get(r.midi).push(r.t);
  }
  const ds = [];
  for (const m of midiRows) {
    const arr = byPitch.get(m.midi);
    if (!arr) { ds.push(9.99); continue; }
    let best = 9.99;
    for (const t of arr) { const d = Math.abs(t - m.t); if (d < best) best = d; }
    ds.push(best);
  }
  ds.sort((a, b) => a - b);
  const q = (f) => ds[Math.min(ds.length - 1, Math.floor(f * ds.length))];
  return { med: q(0.5), p90: q(0.9), hit30: ds.filter((d) => d < 0.03).length, hit100: ds.filter((d) => d < 0.1).length, n: ds.length };
}

const r = score2(ourRows);
console.log(
  `对照 MIDI: 中位 ${r.med.toFixed(3)}s，p90 ${r.p90.toFixed(3)}s，<30ms ${r.hit30}/${r.n}，<100ms ${r.hit100}`,
);
console.log(`MIDI 音 ${midiRows.length}，最后一声 ${midiRows[midiRows.length - 1].t.toFixed(2)}s`);

// 列出没对上的 MIDI 音（看是不是集中在某几处）
{
  const byPitch = new Map();
  for (const r of ourRows) {
    if (!byPitch.has(r.midi)) byPitch.set(r.midi, []);
    byPitch.get(r.midi).push(r.t);
  }
  const bad = [];
  for (const m of midiRows) {
    const arr = byPitch.get(m.midi);
    let best = 9.99;
    if (arr) for (const t of arr) { const d = Math.abs(t - m.t); if (d < best) best = d; }
    if (best > 0.03) bad.push({ ...m, d: best });
  }
  console.log(`\n没对上 ${bad.length} 音；按 5 秒分段:`);
  const bins = new Map();
  for (const b of bad) { const k = Math.floor(b.t / 5) * 5; bins.set(k, (bins.get(k) || 0) + 1); }
  console.log([...bins.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}s:${v}`).join('  '));
  console.log('明细前 20:', bad.slice(0, 20).map((b) => `${b.t.toFixed(2)}s/${b.midi}(${(b.d).toFixed(2)})`).join(' '));
}

{
  const cnt = new Map();
  for (const r of ourRows) cnt.set(r.midi, (cnt.get(r.midi) || 0) + 1);
  const mcnt = new Map();
  for (const m of midiRows) mcnt.set(m.midi, (mcnt.get(m.midi) || 0) + 1);
  const onlyMidi = [...mcnt.keys()].filter((p) => !cnt.has(p)).sort((a, b) => a - b);
  const onlyUs = [...cnt.keys()].filter((p) => !mcnt.has(p)).sort((a, b) => a - b);
  console.log('\n只有 MIDI 有的音高:', onlyMidi.map((p) => `${p}×${mcnt.get(p)}`).join(' ') || '(无)');
  console.log('只有我们有音高:', onlyUs.map((p) => `${p}×${cnt.get(p)}`).join(' ') || '(无)');
  console.log('我们的音高范围:', Math.min(...cnt.keys()), '-', Math.max(...cnt.keys()), ' MIDI:', Math.min(...mcnt.keys()), '-', Math.max(...mcnt.keys()));
}

{
  const f = (r) => `${r.t.toFixed(2)}:${r.midi}`;
  console.log('\n前 2 秒 我们:', ourRows.filter((r) => r.t < 2).map(f).join(' '));
  console.log('\n前 2 秒 MIDI:', midiRows.filter((r) => r.t < 2).map(f).join(' '));
}
