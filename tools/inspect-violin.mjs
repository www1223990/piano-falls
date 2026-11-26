// 小提琴声部的客观数据：音域、分布、有没有弦号/指法标记
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMscx } from '../src/mscx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'test', 'fixtures');
const index = JSON.parse(fs.readFileSync(path.join(fixtures, 'index.json'), 'utf8'));

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const name = (m) => NOTE[m % 12] + (Math.floor(m / 12) - 1);

// 小提琴四根弦（空弦音高）
const STRINGS = [
  { name: 'G', open: 55 },
  { name: 'D', open: 62 },
  { name: 'A', open: 69 },
  { name: 'E', open: 76 },
];

/** 最低弦规则：能奏该音的最低那根弦 */
function stringFor(midi) {
  let best = null;
  for (const s of STRINGS) {
    const pos = midi - s.open;
    if (pos < 0) continue;
    if (!best || pos < best.pos) best = { ...s, pos };
  }
  return best;
}

for (const meta of index) {
  const xml = fs.readFileSync(path.join(fixtures, meta.file), 'utf8');
  const parsed = parseMscx(xml);

  const marks = {
    string: (xml.match(/<string[\s>]/g) || []).length,
    fret: (xml.match(/<fret[\s>]/g) || []).length,
    fingering: (xml.match(/<Fingering[\s>]/g) || []).length,
    text: (xml.match(/<StaffText[\s>]/g) || []).length,
    articulation: (xml.match(/<Articulation[\s>]/g) || []).length,
  };

  console.log(`\n=== ${meta.source} (mscx ${meta.version}) ===`);
  console.log(`  标记: <string> ${marks.string} · <fret> ${marks.fret} · <Fingering> ${marks.fingering} · StaffText ${marks.text} · Articulation ${marks.articulation}`);

  for (const part of parsed.parts) {
    const notes = parsed.notes.filter((n) => n.partIndex === part.index);
    if (!notes.length) continue;
    const pitches = notes.map((n) => n.midi).sort((a, b) => a - b);
    const lo = pitches[0];
    const hi = pitches[pitches.length - 1];
    const med = pitches[Math.floor(pitches.length / 2)];
    const kind = part.keyboard ? '键盘' : '非键盘';
    console.log(`  Part${part.index + 1} ${part.name} (${part.instrumentId}) [${kind}]`);
    console.log(`     ${notes.length} 音 · 音域 ${name(lo)}(${lo}) ~ ${name(hi)}(${hi}) · 中位 ${name(med)}(${med})`);

    if (!part.keyboard) {
      // 最低弦规则会怎么分布
      const byString = { G: [], D: [], A: [], E: [] };
      let unplayable = 0;
      for (const n of notes) {
        const s = stringFor(n.midi);
        if (!s) { unplayable++; continue; }
        byString[s.name].push(s.pos);
      }
      for (const [k, arr] of Object.entries(byString)) {
        if (!arr.length) continue;
        const maxPos = Math.max(...arr);
        console.log(`      弦 ${k}: ${arr.length} 音，把位(半音) 0~${maxPos}${maxPos > 12 ? ' ← 需要换把' : ''}`);
      }
      if (unplayable) console.log(`      ${unplayable} 个音低于 G 空弦（${name(55)}），不是小提琴能拉的音`);
    }
  }
}