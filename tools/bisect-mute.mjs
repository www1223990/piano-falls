// 二分定位：谱表 1 的哪一段换成休止符后，MuseScore 导出 MIDI 会失败
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseMscx } from '../src/mscx.js';

const EXE = 'C:/Program Files/MuseScore 4/bin/MuseScore4.exe';
const full = fs.readFileSync('.tmp/full.mscx', 'utf8');
const muted = fs.readFileSync('.tmp/mute1.mscx', 'utf8');

function splitStaff(xml) {
  const open = '<Staff id="1">';
  const start = xml.indexOf(open);
  const end = xml.indexOf('</Staff>', start);
  const body = xml.slice(start + open.length, end);
  const measures = [...body.matchAll(/<Measure\b[^>]*>[\s\S]*?<\/Measure>/g)].map((m) => m[0]);
  return { start: start + open.length, end, measures };
}
const a = splitStaff(full);
const b = splitStaff(muted);
if (a.measures.length !== b.measures.length) throw new Error(`${a.measures.length} vs ${b.measures.length}`);

function build(lo, hi) {
  // 只把 [lo,hi) 这几个小节换成静音版，其余保持原样
  const parts = a.measures.map((m, i) => (i >= lo && i < hi ? b.measures[i] : m));
  const body = parts.join('');
  return full.slice(0, a.start) + body + full.slice(a.end);
}

function tryRender(lo, hi) {
  const xml = build(lo, hi);
  fs.writeFileSync('.tmp/bisect.mscx', xml);
  try {
    fs.rmSync('.tmp/bisect.mid', { force: true });
    execFileSync(EXE, ['-o', '.tmp/bisect.mid', '.tmp/bisect.mscx'], { stdio: 'pipe', timeout: 60000 });
    return fs.existsSync('.tmp/bisect.mid') && fs.statSync('.tmp/bisect.mid').size > 200;
  } catch {
    return false;
  }
}

const N = a.measures.length;
console.log(`共 ${N} 小节；先确认“全静音”会失败、空区间会成功`);
console.log('  全静音:', tryRender(0, N) ? '成功(意外)' : '失败(符合预期)');
console.log('  空区间:', tryRender(0, 0) ? '成功(符合预期)' : '失败(意外)');

// 找最短的失败区间
let lo = 0, hi = N;
if (tryRender(0, N)) { console.log('全静音都能过，问题不在静音本身'); process.exit(0); }
while (hi - lo > 1) {
  const mid = Math.floor((lo + hi) / 2);
  if (tryRender(lo, mid)) { lo = mid; } else { hi = mid; }
}
console.log(`最小失败区间: 小节 ${hi}（1 起）— 单独替换它会不会炸:`, tryRender(hi - 1, hi) ? '不炸' : '炸');
const one = a.measures[hi - 1];
console.log('\n该小节原文（前 600 字）:\n' + one.replace(/\s+/g, ' ').slice(0, 600));
console.log('\n换成休止符后（前 600 字）:\n' + b.measures[hi - 1].replace(/\s+/g, ' ').slice(0, 600));
