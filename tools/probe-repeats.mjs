// 只读探针：把谱子的反复结构、小节数、时长算术打出来，人工核对。
// 跑法：ELECTRON_RUN_AS_NODE=1 "<DSH exe>" --import ./tools/register.mjs tools/probe-repeats.mjs "<file.mscz>"
import fs from 'node:fs';
import path from 'node:path';
import { readMscxFromMscz } from '../src/zip.js';
import { parseMscx } from '../src/mscx.js';
import { buildTempoMap } from '../src/score.js';

const file = process.argv[2];
if (!file) { console.error('用法: node tools/probe-repeats.mjs "<file.mscz>"'); process.exit(1); }
const ab = fs.readFileSync(file);
const text = await readMscxFromMscz(ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength));

const parsed = parseMscx(text);

// ---- 原始 XML 里逐小节扫结构标记（不改解析器，纯观察）----
function scanStaffs(xml) {
  const staffs = [];
  const re = /<Staff id="(\d+)">([\s\S]*?)<\/Staff>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = Number(m[1]);
    const body = m[2];
    const measures = [];
    const mre = /<Measure\b([^>]*)>([\s\S]*?)<\/Measure>/g;
    let mm;
    while ((mm = mre.exec(body))) {
      const attrs = mm[1] || '';
      const b = mm[2];
      const volta = /<Volta\b[^>]*>([\s\S]*?)<\/Volta>/.exec(b);
      const bar = /<BarLine>([\s\S]*?)<\/BarLine>/.exec(b);
      const tempo = /<Tempo>([\s\S]*?)<\/Tempo>/.exec(b);
      measures.push({
        attrs: attrs.trim(),
        len: /len="([^"]+)"/.exec(attrs)?.[1] ?? '',
        startRepeat: /<startRepeat\b/.test(b),
        endRepeat: /<endRepeat\b/.test(b),
        repeatCount: /<repeatCount>(\d+)<\/repeatCount>/.exec(b)?.[1] ?? '',
        volta: volta ? volta[1].replace(/\s+/g, ' ').slice(0, 160) : '',
        voltaEndings: volta ? /<endings>([\d,]+)<\/endings>/.exec(volta[1])?.[1] ?? '' : '',
        mRep: /<measureRepeatCount>(\d+)<\/measureRepeatCount>/.exec(b)?.[1] ?? '',
        bar: bar ? /<subtype>([^<]+)<\/subtype>/.exec(bar[1])?.[1] ?? '' : '',
        tempo: tempo ? /<tempo>([\d.]+)<\/tempo>/.exec(tempo[1])?.[1] ?? '' : '',
        chords: (b.match(/<Chord\b/g) || []).length,
        mmRest: /<multiMeasureRest>/.test(b),
      });
    }
    staffs.push({ id, measures });
  }
  return staffs;
}

const staffs = scanStaffs(text);
console.log(`文件: ${path.basename(file)}  版本 ${parsed.version}  division ${parsed.division}`);
console.log(`谱表: ${staffs.map((s) => `${s.id}(${s.measures.length}小节)`).join(' ')}`);
console.log(`tempo 条目: ${JSON.stringify(parsed.tempos)}`);
console.log(`统计: 展开后小节 ${parsed.stats.measures}, 音符(合并连音线前) ${parsed.stats.notesBeforeTieMerge}, 最终 ${parsed.notes.length}`);

const palette = []; // 结构标记表（取最全的一张谱表）
const richest = staffs.reduce((a, b) => (b.measures.filter((x) => x.startRepeat || x.endRepeat || x.volta || x.mRep).length > a.measures.filter((x) => x.startRepeat || x.endRepeat || x.volta || x.mRep).length ? b : a));
console.log(`\n=== 结构标记表（谱表 ${richest.id}，小节号从 1 起）===`);
console.log('小节  len/attrs                    start end  count  volta(endings)   bar              mRep chords');
richest.measures.forEach((m, i) => {
  const any = m.startRepeat || m.endRepeat || m.volta || m.mRep || /repeat/.test(m.bar) || m.len || m.mmRest;
  if (!any) return;
  const flags = [m.startRepeat ? 'S' : '.', m.endRepeat ? 'E' : '.'].join('');
  console.log(
    `${String(i + 1).padStart(4)}  ${(m.len || '-').padEnd(24)}  ${flags}   ${(m.repeatCount || '-').padEnd(4)}  ${(m.voltaEndings || '-').padEnd(14)}  ${(m.bar || '-').padEnd(15)}  ${(m.mRep || '-').padEnd(3)}  ${m.chords}` +
      (m.volta ? `\n      volta: ${m.volta}` : '') +
      (m.mmRest ? `\n      multiMeasureRest` : ''),
  );
});

// ---- 时长算术 ----
const divisions = parsed.division;
const expandTicks = parsed.measures.length
  ? parsed.measures[parsed.measures.length - 1].startTicks + parsed.measures[parsed.measures.length - 1].lenTicks
  : 0;
const seen = new Map();
for (const m of parsed.measures) if (!seen.has(m.index)) seen.set(m.index, m.lenTicks);
const linearTicks = [...seen.entries()].sort((a, b) => a[0] - b[0]).reduce((s, [, len]) => s + len, 0);

const pts = buildTempoMap(parsed.tempos, divisions);
const secAt = (tick) => {
  let p = pts[0];
  for (const q of pts) if (q.tick <= tick) p = q;
  return p.seconds + ((tick - p.tick) / divisions) * (60 / p.bpm);
};
console.log('\n=== 时长算术 ===');
console.log(`线性: ${parsed.measures.length && seen.size} 个唯一小节, ${linearTicks} ticks`);
console.log(`当前解析(展开后): ${parsed.measures.length} 小节, ${expandTicks} ticks`);
console.log(`唯一小节数 ${seen.size} / 展开小节数 ${parsed.measures.length}`);
const s = secAt(expandTicks);
if (s != null) console.log(`展开时长 ${s.toFixed(2)}s`);
const sl = secAt(linearTicks);
if (sl != null) console.log(`线条时长 ${sl.toFixed(2)}s`);

