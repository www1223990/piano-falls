// 跨平台开发服务器（Node 18+）：静态文件 + 用本机 MuseScore 渲染音频。
//
// 为什么还要一个 serve.ps1：安装版给"没有 Node 的 Windows"用一键启动；
// 这个 .mjs 给开发/CI/非 Windows 用，接口和 serve.ps1 完全一致：
//   GET  /            静态文件（index.html 起）
//   GET  /health      { ok, musescore, root }
//   GET  /version     { build }（文件最新修改时间，用来提示"页面过期了"）
//   POST /render      请求体 = .mscz 或（?ext=mscx）.mscx → 返回 zip{score.mid, score.<音频>}
//   POST /convert     .mscz → .mid
//
// MuseScore 位置：环境变量 MUSESCORE_BIN 优先，否则按平台猜几个常见路径。
// 仓库里不含任何 MuseScore 二进制，也不捆绑音源（Salamander 由 CDN 提供）。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || argOf('--port') || 8765);
const HOST = '127.0.0.1';
const RENDER_TIMEOUT_MS = 120000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mid': 'audio/midi',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

/** 找 MuseScore 命令行。找到就返回路径，找不到返回 null（前端会退化成合成钢琴） */
function findMuseScore() {
  const fromEnv = process.env.MUSESCORE_BIN;
  const candidates = [
    fromEnv,
    'C:/Program Files/MuseScore 4/bin/MuseScore4.exe',
    'C:/Program Files/MuseScore 4/bin/mscore4.exe',
    'C:/Program Files/MuseScore 3/bin/MuseScore3.exe',
    '/Applications/MuseScore 4.app/Contents/MacOS/mscore',
    '/Applications/MuseScore 3.app/Contents/MacOS/mscore',
    '/usr/bin/musescore4',
    '/usr/bin/musescore',
    '/usr/local/bin/musescore4',
    '/usr/local/bin/musescore',
    'mscore4',
    'musescore',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c === 'mscore4' || c === 'musescore') return c; // 交给 PATH
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const MS = findMuseScore();

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(cmd, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(false);
    }, timeoutMs);
    child.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

// ---- 极简 zip 写入（store 方式就够：mp3/mid 压不动，反而不浪费 CPU）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // 0 = stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

// ---- MuseScore 渲染 ----
async function render({ bytes, ext, wantAudio }) {
  if (!MS) throw new Error('MuseScore CLI not found（设 MUSESCORE_BIN 或装 MuseScore 4）');
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const tmp = os.tmpdir();
  const input = path.join(tmp, `pf_${id}.${ext}`);
  const midi = path.join(tmp, `pf_${id}.mid`);
  try {
    await fsp.writeFile(input, bytes);
    if (!(await run(MS, ['-o', midi, input], RENDER_TIMEOUT_MS)) || !fs.existsSync(midi)) {
      throw new Error(`MIDI export failed (in=${input} size=${bytes.length})`);
    }
    let audio = null;
    let audioExt = wantAudio;
    for (const candidateExt of [wantAudio, 'mp3', 'ogg', 'wav']) {
      const out = path.join(tmp, `pf_${id}.${candidateExt}`);
      if (await run(MS, ['-o', out, input], RENDER_TIMEOUT_MS)) {
        if (fs.existsSync(out) && (await fsp.stat(out)).size > 1024) {
          audio = out;
          audioExt = candidateExt;
          break;
        }
      }
    }
    if (!audio) throw new Error('audio export failed (mp3/ogg/wav all failed)');
    return makeZip([
      { name: 'score.mid', data: await fsp.readFile(midi) },
      { name: `score.${audioExt}`, data: await fsp.readFile(audio) },
    ]);
  } finally {
    for (const f of [input, midi]) fsp.rm(f, { force: true }).catch(() => {});
    for (const e of ['mp3', 'ogg', 'wav', 'mid']) {
      fsp.rm(path.join(tmp, `pf_${id}.${e}`), { force: true }).catch(() => {});
    }
  }
}

async function maxBuildTime() {
  let max = 0;
  const look = async (file) => {
    try {
      const st = await fsp.stat(file);
      if (st.mtimeMs > max) max = st.mtimeMs;
    } catch {
      /* ignore */
    }
  };
  await look(path.join(ROOT, 'index.html'));
  const srcDir = path.join(ROOT, 'src');
  try {
    for (const name of await fsp.readdir(srcDir)) if (name.endsWith('.js')) await look(path.join(srcDir, name));
  } catch {
    /* ignore */
  }
  return String(Math.round(max));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, code, type, body) {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

async function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.replace(/^\/+/, ''));
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const full = path.resolve(ROOT, rel);
  if (!full.startsWith(ROOT)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
  try {
    const st = await fsp.stat(full);
    if (st.isDirectory()) return serveStatic(res, `${urlPath.replace(/\/?$/, '/')}index.html`);
    const body = await fsp.readFile(full);
    return send(res, 200, MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream', body);
  } catch {
    return send(res, 404, 'text/plain; charset=utf-8', 'not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/version') {
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ build: await maxBuildTime() }));
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, musescore: MS, root: ROOT }));
    }
    if (req.method === 'POST' && url.pathname === '/render') {
      const bytes = await readBody(req);
      const ext = url.searchParams.get('ext') === 'mscx' ? 'mscx' : 'mscz';
      const zip = await render({ bytes, ext, wantAudio: 'mp3' });
      return send(res, 200, 'application/zip', zip);
    }
    if (req.method === 'POST' && url.pathname === '/convert') {
      const bytes = await readBody(req);
      const zip = await render({ bytes, ext: 'mscz', wantAudio: 'wav' });
      // /convert 只要 MIDI：解出来返回
      const entry = unzipStoredEntry(zip, /\.mid$/i);
      return send(res, 200, 'audio/midi', entry);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, url.pathname);
    return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
  } catch (err) {
    return send(res, 500, 'text/plain; charset=utf-8', String(err?.message ?? err));
  }
});

/** 只解我们自己写出来的 store 格式 zip（/convert 用） */
function unzipStoredEntry(zip, re) {
  let p = 0;
  while (p + 30 <= zip.length && zip.readUInt32LE(p) === 0x04034b50) {
    const method = zip.readUInt16LE(p + 8);
    const size = zip.readUInt32LE(p + 18);
    const nameLen = zip.readUInt16LE(p + 26);
    const extraLen = zip.readUInt16LE(p + 28);
    const name = zip.toString('utf8', p + 30, p + 30 + nameLen);
    const dataStart = p + 30 + nameLen + extraLen;
    if (method === 0 && re.test(name)) return zip.subarray(dataStart, dataStart + size);
    p = dataStart + size;
  }
  throw new Error('zip 里没找到目标文件');
}

server.listen(PORT, HOST, () => {
  console.log(`\n  Piano Falls   http://${HOST}:${PORT}/`);
  console.log(`  root          ${ROOT}`);
  console.log(`  MuseScore     ${MS ?? 'not found（.mscz 会用合成钢琴）'}`);
  console.log('  Ctrl+C 停止\n');
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', `http://${HOST}:${PORT}/`] : [`http://${HOST}:${PORT}/`];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  }
});

server.on('error', (err) => {
  console.error(`启动失败：${err?.message ?? err}`);
  process.exit(1);
});
