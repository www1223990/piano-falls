// 只读：打印某段原始 <Measure> XML（人眼核对 volta/spanner 结构）
// 用法：... tools/dump-measures.mjs "<file.mscz>" <staffId> <from> <to>
import fs from 'node:fs';
import { readMscxFromMscz } from '../src/zip.js';

const [, , file, staffId = '1', from = '20', to = '26'] = process.argv;
const ab = fs.readFileSync(file);
const text = await readMscxFromMscz(ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength));

const re = /<Staff id="(\d+)">([\s\S]*?)<\/Staff>/g;
let m;
while ((m = re.exec(text))) {
  if (m[1] !== String(staffId)) continue;
  const measures = [...m[2].matchAll(/<Measure\b[^>]*>[\s\S]*?<\/Measure>/g)].map((x) => x[0]);
  for (let i = Number(from) - 1; i <= Number(to) - 1; i++) {
    console.log(`\n===== staff ${staffId} measure ${i + 1} =====`);
    console.log(measures[i]);
  }
}
