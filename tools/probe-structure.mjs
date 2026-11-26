// 只读：只打印结构标签（反复/volta/mRep），不打印音符
import fs from 'node:fs';
import { readMscxFromMscz } from '../src/zip.js';

const file = process.argv[2];
const ab = fs.readFileSync(file);
const text = await readMscxFromMscz(ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength));

const re = /<Staff id="(\d+)">([\s\S]*?)<\/Staff>/g;
const staffBlocks = [];
let m;
while ((m = re.exec(text))) staffBlocks.push({ id: m[1], body: m[2] });

for (const { id, body } of staffBlocks) {
  const measures = [...body.matchAll(/<Measure\b[^>]*>[\s\S]*?<\/Measure>/g)].map((x) => x[0]);
  const rows = [];
  measures.forEach((xml, i) => {
    const tags = [];
    if (/<startRepeat\b/.test(xml)) tags.push('START');
    if (/<endRepeat\b/.test(xml)) tags.push('END');
    const rc = /<repeatCount>(\d+)<\/repeatCount>/.exec(xml);
    if (rc) tags.push(`count=${rc[1]}`);
    const mrep = /<measureRepeatCount>(\d+)<\/measureRepeatCount>/.exec(xml);
    if (mrep) tags.push(`mRep=${mrep[1]}`);
    for (const v of xml.matchAll(/<Spanner type="Volta">([\s\S]*?)<\/Spanner>/g)) {
      const endings = /<endings>([\d,]+)<\/endings>/.exec(v[1])?.[1] ?? '?';
      const span = /<next>\s*<location>\s*<measures>(\d+)<\/measures>/.exec(v[1])?.[1] ?? '?';
      const begin = /<beginText>([^<]*)<\/beginText>/.exec(v[1])?.[1] ?? '';
      tags.push(`VOLTA[${begin}] endings=${endings} span=${span}`);
    }
    if (tags.length) rows.push(`${String(i + 1).padStart(4)} ${tags.join(' | ')}`);
  });
  console.log(`--- staff ${id} (${measures.length} measures) ---`);
  console.log(rows.join('\n'));
}
