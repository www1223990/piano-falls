// .mscz → { 音符流 + 原谱音频 }。两条都不经过 MIDI 的音符数据：
//   .mscz（zip） → 里面的 .mscx（XML） → 解析 → 音符流（乐器/谱表/时值都是原谱的）
//   同时 POST /render 让本机 MuseScore 渲染**原谱音频** + 一份 MIDI 速度表
// 音频用来出声（音色 100% 是原谱的），MIDI 只取它的 tempo map 把 tick 换算成秒，
// 这样音符落点和声音是同一个播放引擎算出来的。

import { readMscxFromMscz, readZipEntry } from './zip.js';
import { parseMscx } from './mscx.js';
import { scoreFromMscx, timingFromMidiBytes } from './score.js';
import { getRender, putRender } from './cache.js';

const renderCache = new Map(); // 会话内提速：name|size -> {audio, midi}

function cacheKey(file) {
  return `${file.name}|${file.size}|${file.lastModified ?? 0}`;
}

async function renderScore(file, { onStep } = {}) {
  const key = cacheKey(file);
  if (renderCache.has(key)) {
    onStep?.('cache');
    return renderCache.get(key);
  }

  // 先看磁盘缓存：同一份谱子第二次载入应该秒开
  const cached = await getRender(key);
  if (cached && cached.audio && cached.audio.byteLength > 1024) {
    onStep?.('cache');
    const result = { audio: cached.audio, midi: cached.midi ?? null };
    renderCache.set(key, result);
    return result;
  }

  onStep?.('render');
  const res = await fetch('/render', { method: 'POST', body: await file.arrayBuffer() });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `HTTP ${res.status}`);
  }
  const zip = await res.arrayBuffer();
  const audio = await readZipEntry(zip, (n) => /\.(mp3|ogg|wav)$/i.test(n));
  let midi = null;
  try {
    midi = await readZipEntry(zip, (n) => /\.mid$/i.test(n));
  } catch {
    midi = null;
  }
  const result = { audio, midi };
  renderCache.set(key, result);
  putRender(key, result); // 不 await：写缓存不该拖慢首次播放
  return result;
}

/**
 * @param {File|Blob} file
 * @param {{onStep?: (step: string) => void, render?: boolean}} opts
 * render=false 时只用合成钢琴（不找 MuseScore 渲染音频）
 */
export async function msczToScore(file, { onStep, render = true } = {}) {
  onStep?.('unzip');
  const buffer = await file.arrayBuffer();

  let xml;
  try {
    xml = await readMscxFromMscz(buffer);
  } catch (err) {
    throw new Error(`读不出这个 .mscz 里的乐谱：${err?.message ?? err}`);
  }

  onStep?.('parse');
  const parsed = parseMscx(xml);

  let audio = null;
  let timing = null;
  if (render) {
    try {
      const r = await renderScore(file, { onStep });
      audio = r.audio;
      if (r.midi) timing = timingFromMidiBytes(r.midi);
    } catch (err) {
      console.warn('[mscz] 渲染原谱音频失败，改用合成钢琴：', err?.message ?? err);
      window.__lastRenderError = String(err?.message ?? err);
      onStep?.('render-failed');
    }
  }

  // 用渲染音频的真实长度当"速度表裁判"：MIDI 表偶尔带多余的结尾变速，
  // 按它换算会把尾巴拉长、画面越放越晚（实测《Cancan》多出 6 秒）。
  const audioLenHint = audio ? await decodeAudioLength(audio) : null;
  const score = scoreFromMscx(parsed, { name: file.name, timing, audioLenHint });
  score.audio = audio;
  score.audioVia = audio ? 'musescore' : 'synth';
  // 留着原始 mscx：按声部静音时要改谱重渲
  score.mscxText = xml;

  if (!score.notes.length) {
    if (score.ignoredParts.length) {
      throw new Error(`这个谱子里只有非键盘乐器（${score.ignoredParts.map((p) => p.name).join('、')}），没有可显示的声部。`);
    }
    throw new Error('这个谱子里没有解析到音符');
  }
  return score;
}

/** 离线解码音频，拿到真实时长（mp3 的 duration 属性是估算值，不可靠） */
async function decodeAudioLength(bytes) {
  try {
    const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!Offline || !bytes) return null;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    const ctx = new Offline(1, 44100, 44100);
    const buf = await ctx.decodeAudioData(ab);
    return Number.isFinite(buf?.duration) && buf.duration > 1 ? buf.duration : null;
  } catch {
    return null;
  }
}
