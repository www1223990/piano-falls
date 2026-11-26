// .mscz（zip）→ 解包 → mscx 文本 → 解析：用自己现造的 zip 跑，不需要真实乐谱文件。
// 跑法：node test/test-mscz.mjs
import { deflateRawSync } from 'node:zlib';
import { listZipEntries, readZipEntry, readMscxFromMscz } from '../src/zip.js';
import { parseMscx } from '../src/mscx.js';
import { FIXTURES, asMscz, zipStore } from './synth-fixtures.mjs';

let fails = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { fails++; console.log(`  ✗ ${msg}`); }
};

const text = FIXTURES.pianoViolin;

console.log('=== store（不压缩）的 .mscz ===');
{
  const buf = asMscz(text);
  const entries = listZipEntries(buf);
  console.log(`  条目: ${entries.map((e) => `${e.name}(${e.method === 0 ? 'stored' : 'deflate'})`).join(', ')}`);
  check(entries.length === 2, `读到 2 个条目（${entries.length}）`);
  check(entries.some((e) => /\.mscx$/i.test(e.name)), '里面有 .mscx');

  const t0 = Date.now();
  const out = await readMscxFromMscz(buf);
  check(out === text, `解出来的文本与原文完全一致（${out.length} 字符，${Date.now() - t0}ms）`);

  const score = parseMscx(out);
  check(score.parts.length === 2, `解析出 2 个 Part（${score.parts.length}）`);
  check(score.notes.length === 26, `解析出 26 个音（${score.notes.length}）`);
}

console.log('\n=== deflate 压缩的 .mscz（真实文件基本都是这种）===');
{
  const raw = Buffer.from(text, 'utf8');
  const deflated = deflateRawSync(raw);
  const zip = zipStore([
    { name: 'META-INF/container.xml', data: Buffer.from('<container/>', 'utf8') },
    { name: 'score.mscx', data: deflated, raw },
  ]);
  const buf = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
  const entries = listZipEntries(buf);
  check(entries[1].method === 8, '这个条目是 deflate(8)');
  const out = await readMscxFromMscz(buf);
  check(out === text, '解压后的文本与原文完全一致');
  check(out.length === text.length, `长度一致（${out.length}）`);
}

console.log('\n=== 异常路径 ===');
{
  const buf = asMscz(text);
  let threw = null;
  try {
    await readZipEntry(buf, (n) => /\.none$/i.test(n));
  } catch (e) {
    threw = e;
  }
  check(!!threw && /找不到/.test(threw.message), '找不到条目时抛错（不是静默返回空）');

  let bad = null;
  try {
    listZipEntries(new ArrayBuffer(64));
  } catch (e) {
    bad = e;
  }
  check(!!bad, '不是 zip 的数据会被拒绝');
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
