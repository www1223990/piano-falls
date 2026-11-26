// 读 ZIP（.mscz 就是个 zip）——只用浏览器自带的 DecompressionStream，不引第三方库。
// .mscz 里的正片是一个 <名字>.mscx（未压缩或 deflate），读出来就是 mscx 文本。
//
// 走中央目录（而不是顺着本地头扫），因为本地头里的 size 字段流式写入时可能是 0。

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function findEocd(dv, totalLength) {
  const min = Math.max(0, totalLength - 65557); // EOCD 最大 22 + 65535 注释
  for (let i = totalLength - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {{name:string, method:number, compressedSize:number, size:number, offset:number}[]}
 */
export function listZipEntries(buffer) {
  const dv = new DataView(buffer);
  const eocd = findEocd(dv, buffer.byteLength);
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录）');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (p + 46 > buffer.byteLength || dv.getUint32(p, true) !== CD_SIG) break;
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8').decode(new Uint8Array(buffer, p + 46, nameLen));
    entries.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('这个浏览器不支持 DecompressionStream("deflate-raw")，请用较新的 Chrome/Edge');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {ArrayBuffer} buffer
 * @param {(name:string)=>boolean} predicate
 * @returns {Promise<Uint8Array>}
 */
export async function readZipEntry(buffer, predicate) {
  const entries = listZipEntries(buffer);
  const entry = entries.find((e) => predicate(e.name));
  if (!entry) throw new Error(`zip 里找不到匹配的条目`);

  const dv = new DataView(buffer);
  const lfh = entry.offset;
  if (dv.getUint32(lfh, true) !== LFH_SIG) throw new Error('本地文件头损坏');
  const nameLen = dv.getUint16(lfh + 26, true);
  const extraLen = dv.getUint16(lfh + 28, true);
  const dataStart = lfh + 30 + nameLen + extraLen;
  const raw = new Uint8Array(buffer, dataStart, entry.compressedSize);

  if (entry.method === 0) return raw.slice();
  if (entry.method === 8) return inflateRaw(raw);
  throw new Error(`不支持的压缩方式 ${entry.method}`);
}

/**
 * .mscz → mscx 文本
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}
 */
export async function readMscxFromMscz(buffer) {
  const text = await readZipEntry(buffer, (name) => /\.mscx$/i.test(name));
  return new TextDecoder('utf-8').decode(text);
}