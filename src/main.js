// 装配层：唯一持有"当前时间"的地方。
// 规则：Transport（Tone 的音频时钟）是权威，requestAnimationFrame 只负责把 scoreTime 读出来交给渲染层。
//
// 时间轴约定（全部相对曲首，单位秒）：
//   transport.seconds = START_OFFSET + scoreTime
//   START_OFFSET       = 播放前留出的"下落时间"，让第一个音符从顶端进场
//   音符时间不加任何偏移，偏移只存在于 transport 的坐标里 —— 这样 seek / 改下落时长都不会漂。

import * as Tone from 'tone';
import { createStage } from './stage.js';
import { createPanes } from './panes.js';
import { demoScore, scoreFromMidiBytes } from './score.js';
import { Piano } from './audio.js';
import { MediaPlayer } from './media-player.js';
import { msczToScore } from './mscz.js';
import { cacheStats, clearRenders, getRender, putRender } from './cache.js';
import { makeWindow } from './window.js';
import { muteStaffs, renderMuted } from './mute.js';
import { VERSION } from './version.js';

const $ = (id) => document.getElementById(id);

function fatal(err) {
  console.error(err);
  const el = $('fatal');
  if (el) {
    el.textContent = `出错了：${err?.message ?? err}\n\n打开控制台看完整堆栈。`;
    el.classList.add('on');
  }
  window.__PIANO_READY__ = true;
}

let stage;
let panes;
let infoWin;

// 声部状态：哪只手不显示 / 哪个声部不发声
const partState = {
  hiddenHands: new Set(), // 0=右手 1=左手
  mutedHands: new Set(),
  mutedLanes: new Set(), // 窗格序号（非键盘乐器）
  link: false, // 隐藏时同时静音
};

/** 分轨是否就绪（每个谱表一轨，静音 = 拉增益，立即生效） */
let stemsReady = false;

/** 当前应该静音的谱表 id */
function mutedStaffIds() {
  const ids = new Set();
  (score?.lanes ?? []).forEach((lane, i) => {
    if (lane.kind === 'piano') {
      const s = lane.staffIds ?? [];
      if (partState.mutedHands.has(0) && s[0]) ids.add(s[0]);
      if (partState.mutedHands.has(1) && s[1]) ids.add(s[1]);
    } else if (partState.mutedLanes.has(i)) {
      for (const s of lane.staffIds ?? []) ids.add(s);
    }
  });
  return [...ids];
}
let piano;
let transport;
/** 有原谱音频时的播放器；null 表示走合成钢琴 + Tone.Transport */
let player = null;
/** 当前这份乐谱是否真的有音频（player 会复用，不能靠 player 是否存在判断） */
let playerActive = false;

let score = { notes: [], measures: [], duration: 0, name: '' };
let scheduled = false;
let startOffset = 2.0;
let userOffsetMs = 0;
let debugAV = false; // 按 D 显示"音频时钟 - 画面时钟"
let dragging = false;
let frames = 0;
let fpsClock = performance.now();
let fps = 0;
let lastTimeLabel = '';

const fallDuration = () => Number($('fall').value);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function fmt(t) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

// 状态行是"有粘性"的：loading / 报错这类信息不能被每 500ms 的 fps 刷新盖掉。
// 之前就是这么被吃掉的 —— 加载 mscz 时你根本看不到"转换中"。
let stickyUntil = 0;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 乐谱信息面板：调号 / 拍号 / 速度 / 时值分布 / 规模。
 * 数据全部来自 .mscx 本身（不是从 MIDI 猜的），所以调号、拍号、时值都是原谱的。
 */
function renderInfo(score) {
  const el = $('info');
  if (!el) return;
  // 窗口化之后内容是写进 .win-body 的，标题栏归窗口自己管
  const body = el.querySelector('.win-body') || el;
  const info = score.info || {};
  const rows = [];
  const add = (k, v) => {
    if (v !== undefined && v !== null && String(v).length) rows.push([k, v]);
  };

  add('曲目', info.title || score.name || '—');
  add('作曲', info.composer);

  if (score.parts?.length) {
    add('乐器', score.parts.map((p) => `${p.name}${p.keyboard ? '（键盘）' : ''}`).join(' · '));
  }
  if (score.ignoredParts?.length) add('已忽略', score.ignoredParts.map((p) => p.name).join(' · '));

  const key = info.keys?.[0];
  if (key) add('调号', `${key.accidental}（${key.major} 大调 / ${key.minor} 小调）`);
  if (info.keys?.length > 1) add('转调', `全曲 ${info.keys.length} 次调号变化`);

  const ts = info.timeSignatures ?? [];
  if (ts.length) {
    const uniq = [...new Set(ts.map((t) => `${t.n}/${t.d}`))];
    add('拍号', uniq.join(' → '));
  }

  const tempos = info.tempos ?? [];
  if (tempos.length) {
    const bpms = tempos.map((t) => t.bpm);
    const lo = Math.min(...bpms);
    const hi = Math.max(...bpms);
    add('速度', lo === hi || hi - lo < 1
      ? `${Math.round(lo)} BPM`
      : `${Math.round(lo)}~${Math.round(hi)} BPM（${tempos.length} 处变速）`);
  }

  if (info.noteValues?.length) {
    add('时值', info.noteValues.slice(0, 6).map((v) => `${v.label} ×${v.count}`).join(' · '));
  }

  add('规模', `${info.measureCount ?? score.measures?.length ?? 0} 小节 · ${score.notes.length} 音 · ${fmt(score.duration)}`);
  if (info.mscxVersion) add('来源', `.mscz（mscx ${info.mscxVersion}）`);
  else if (score.via === 'midi') add('来源', 'MIDI（不含乐器/调号信息）');
  else add('来源', '内置示例');

  body.innerHTML =
    rows.map(([k, v]) => `<div class="row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`).join('') +
    '<div class="row" id="cacheRow"><span class="k">渲染缓存</span><span class="v">…</span></div>' +
    (score.warnings?.length
      ? `<div class="sub">解析提示：${escapeHtml(score.warnings.join('；'))}</div>`
      : '');

  cacheStats().then((s) => {
    const cell = body.querySelector('#cacheRow .v');
    if (!cell) return;
    cell.textContent = s.count
      ? `${s.count} 份 / ${(s.bytes / 1048576).toFixed(1)} MB（同一份谱子再载入就不用再等渲染）`
      : '空（下次载入会重新渲染）';
  });
}

function setHud(text, keepMs = 6000) {
  $('status').textContent = text;
  stickyUntil = keepMs === Infinity ? Infinity : performance.now() + keepMs;
}

function clearHud() {
  stickyUntil = 0;
}

// 预渲染是要等的（3 分钟曲子约 20 秒），等待期间让状态行一直在动，
// 否则会让人以为卡死了。
let renderTimer = null;

function beginRenderStatus(label) {
  const t0 = performance.now();
  const paint = () => setHud(`${label}…  已等 ${Math.round((performance.now() - t0) / 1000)} 秒`, Infinity);
  paint();
  if (renderTimer) clearInterval(renderTimer);
  renderTimer = setInterval(paint, 500);
}

function endRenderStatus() {
  if (renderTimer) {
    clearInterval(renderTimer);
    renderTimer = null;
  }
}

function refreshHud() {
  if (performance.now() < stickyUntil) return;
  const lat = currentLatency();
  const src = usingAudio()
    ? (stemsReady ? 'MuseScore 分轨（可即时静音）' : 'MuseScore 渲染（原谱音色）')
    : piano.kind;
  const ctxSuspended = usingAudio() && player?.ctx && player.ctx.state === 'suspended';
  // 音画诊断：音频时钟 vs 画面时钟（正常应恒等于 输出延迟-偏移，比如 53ms）
  const avDiff = debugAV && usingAudio() ? Math.round((player.time() - viewScoreTime()) * 1000) : null;
  // 直接写，不走 setHud（否则会给自己设一个 6 秒的粘性，fps 再也不更新）
  $('status').textContent =
    `${score.name || '—'} · ${score.notes.length} 音符 · ${score.measures.length} 小节` +
    `${score.mode === 'keyboard-only' ? ' · 只显示键盘声部' : ''}` +
    `${score.ignoredParts?.length ? ` · 已忽略 ${score.ignoredParts.map((p) => p.name).join('/')}` : ''}` +
    `${stage && stage.getMode() === '3d' ? ' · 3D' : ''}\n` +
    `${fmt(curScoreTime())} / ${fmt(totalDuration())} · ${fps} fps\n` +
    `音源 ${src}${!usingAudio() && piano.source && piano.kind === 'salamander' ? `（${new URL(piano.source).host}）` : ''} · 输出延迟 ${(lat * 1000).toFixed(0)}ms · 偏移 ${userOffsetMs}ms · 下落 ${fallDuration().toFixed(1)}s${avDiff === null ? '' : ` · 音画差 ${avDiff}ms`}${ctxSuspended ? ' · ⚠ 声音未启用（点一下播放）' : ''}${usingAudio() && player?.desync ? ` · ⚠ 分轨不同步 ${Math.round(player.lastHardAlignSpread * 1000)}ms（重播可恢复）` : ''}`;
}

/** 有原谱音频时以它为时钟（time() 在预备段是负的） */
function usingAudio() {
  return playerActive && !!(player && player.ready);
}

function currentLatency() {
  return usingAudio() ? player.latency() : piano.outputLatency();
}

function totalDuration() {
  const scoreEnd = score.duration || 0;
  if (!usingAudio()) return scoreEnd;
  const audio = player.duration || 0;
  if (!audio) return scoreEnd;
  // mp3 时长是估算值；而且结尾常拖着几秒编码静音（Cancan 实测 4.6s）。
  // 以谱面结束为准，只多留 0.6s 余音，否则进度条和画面会在结尾空转一大段。
  if (audio > scoreEnd + 0.8) return scoreEnd + 0.6;
  return Math.max(audio, scoreEnd);
}

/** 当前曲内播放位置（不含下落预备段，负数夹到 0） */
function curScoreTime() {
  return clamp(viewScoreTime(), 0, Math.max(0, totalDuration()));
}

/** 渲染用的曲内时间：扣掉输出延迟，让"看到落地"和"听到声音"对齐 */
function viewScoreTime() {
  const lat = currentLatency();
  if (usingAudio()) return player.time() - lat + userOffsetMs / 1000;
  return transport.seconds - startOffset - lat + userOffsetMs / 1000;
}

async function applyScore(next, { autoPlay = false } = {}) {
  score = next;
  transport.stop();
  transport.cancel(0);
  scheduled = false;
  piano.releaseAll();

  // 有渲染音频就换掉时钟；没有就沿用 Tone.Transport
  stemsReady = false;
  stemsPromise = null;
  playerActive = false;
  // 换谱子：旧播放器整个丢掉（<audio> 元素和 Blob URL 都要回收）
  if (player) {
    try {
      player.dispose?.();
    } catch {
      /* ignore */
    }
    player = null;
  }
  if (next.audio && MediaPlayer.supported()) {
    try {
      // 每份谱子重建一个播放器；dispose 里会把旧的 <audio> 和 Blob URL 回收
      if (!player) player = new MediaPlayer();
      await player.load(next.audio);
      calibrateOffsetFromBytes(next.audio);
      player.setRate?.(speedRate);
      player.setVolumeDb(Number($('vol').value));
      window.__player = player; // 调试：控制台里能看播放器状态
      clipScoreToAudio(player.duration);
      playerActive = true;
    } catch (err) {
      console.warn('[audio] 原谱音频播放不可用：', err);
      setHud('原谱音频解码失败，回退成合成钢琴', 6000);
    }
  }
  stage.setScore(score);
  stage.setMeasureVisible($('measures').checked);
  panes?.refresh();
  renderInfo(score);
  window.__score = score; // 调试用：控制台里看音符数据
  score._fullAudio = next.audio; // 原始混音，恢复静音时用
  applySavedKeyFrac();
  stage.setHandVisible(0, !partState.hiddenHands.has(0));
  stage.setHandVisible(1, !partState.hiddenHands.has(1));
  $('play').textContent = '播放';
  $('tEnd').textContent = fmt(totalDuration());
  $('seek').value = '0';
  refreshHud();

  // 预渲染 + 自动开播：渲完直接从头放，不用再点一下
  if (autoPlay && usingAudio() && score.notes.length && !mutedStaffIds().length) {
    // 同理：resume 不能 await（合成事件下永远不 resolve），让它自己去恢复
    if (player.ctx.state === 'suspended') player.ctx.resume().catch(() => {});
    player.play({ delay: Math.max(0.6, fallDuration()) });
    $('play').textContent = '暂停';
  }

  // 之前设过静音：载入后按同样的设置重新渲染一次
  if (mutedStaffIds().length) applyMutes();
  // 载入完就在后台把分轨备好（首次要渲几个轨，之后走缓存），
  // 备好之前改发声走"单次重渲"兜底，备好之后静音就是瞬时的
  if (score.mscxText) setTimeout(() => prefetchStems(), 1200);
  if (!$('partList').hidden) buildPartList();
}

function scheduleScore() {
  transport.cancel(0);
  transport.bpm.value = 120; // 全部按"秒"调度，bpm 只影响 4n 这类记法的换算
  // 预备段 = 一次完整下落时间，第一个音符才能从顶端进场
  startOffset = Math.max(0.6, fallDuration());
  for (const n of score.notes) {
    // 回调里的 time 就是该事件应触发的绝对音频时间 —— 不要用 Tone.now() 替代
    transport.schedule((time) => piano.trigger(n, time), n.time + startOffset);
  }
  scheduled = true;
}

function seekTo(t) {
  const target = clamp(t, 0, totalDuration());
  if (usingAudio()) {
    player.seek(target);
    return;
  }
  transport.seconds = startOffset + target; // Tone v15 没有 transport.seek()
  piano.releaseAll(); // 跳转前已经排上的长音不该继续响
}

/**
 * 谱面比音频长时，把超出音频末尾的音符丢掉。
 * 真实案例：《Cancan》的 mp3 解码长度 136.15s，谱面线性时间轴到 142.31s
 * （末尾有反复/结尾小节），结果最后 3 秒音符还在落、声音已经结束。
 * 音频才是用户真正听到的东西，超出部分不该再画。
 */
function clipScoreToAudio(audioLen) {
  if (!score || !audioLen || !Number.isFinite(audioLen)) return;
  const over = (score.duration || 0) - audioLen;
  if (over < 0.3) return;
  const limit = audioLen - 0.05;
  let dropped = 0;
  for (const lane of score.lanes ?? []) {
    const kept = lane.notes.filter((n) => n.time < limit);
    dropped += lane.notes.length - kept.length;
    lane.notes = kept;
  }
  if (!dropped) return;
  const primary = score.lanes?.find((l) => l.kind === 'piano') ?? score.lanes?.[0];
  if (primary) score.notes = primary.notes;
  score.duration = audioLen;
  setHud(`谱面比音频长 ${over.toFixed(1)} 秒（末尾超出），已裁掉 ${dropped} 个听不到的音符`, 6000);
}

/** 只允许一个引擎出声：把合成钢琴（Tone.Transport）彻底掐掉 */
function killSynth() {
  try {
    transport.stop();
  } catch {
    /* ignore */
  }
  try {
    transport.cancel(0);
  } catch {
    /* ignore */
  }
  try {
    piano.releaseAll();
  } catch {
    /* ignore */
  }
  scheduled = false;
}

async function togglePlay() {
  // 去抖：空格会同时触发 keydown 处理和按钮自身的空格激活（两次 toggle），
  // 两次翻转会让播放位置错乱（甚至回到开头）。250ms 内只认第一次。
  const now = performance.now();
  if (now - lastToggleAt < 250) return;
  lastToggleAt = now;

  if (!score.notes.length) {
    setHud('没有音符可播放');
    return;
  }

  // ---- 有原谱音频：音频就是时钟 ----
  if (usingAudio()) {
    // 同一时刻只允许一个引擎出声：先把合成引擎彻底掐掉，
    // 否则它会在音频外面多挂一路声音（暂停也停不掉，只有"停止"才清掉）。
    killSynth();
    if (player.playing) {
      player.pause();
      $('play').textContent = '播放';
      return;
    }
    if (player.ctx.state === 'suspended') await player.ctx.resume();
    const from = Math.max(0, player.time());
    // 从头播时留一段预备，让第一个音符从顶端落下来
    const delay = from < 0.02 ? Math.max(0.6, fallDuration()) : 0;
    player.play({ delay, from });
    $('play').textContent = '暂停';
    return;
  }

  // ---- 没有音频：合成钢琴 + Tone.Transport ----
  // 反过来也要保证：进合成引擎前，把音频播放器停掉
  try {
    player?.stop?.();
  } catch {
    /* ignore */
  }
  if (transport.state === 'started') {
    transport.pause();
    piano.releaseAll();
    $('play').textContent = '播放';
    return;
  }
  if (!piano.ready || piano.shouldRetrySamples) {
    setHud('加载钢琴采样…（首次约 3MB，冷启动可能要十几秒）', Infinity);
    const kind = await piano.init();
    clearHud();
    refreshHud();
    if (kind !== 'salamander') {
      setHud('采样没加载成功，先用合成音色顶着；再点一次「播放」会重试采样。', 9000);
    }
  }
  if (!scheduled) scheduleScore();
  // 从头开始播时，把 position 拉回预备段起点，避免停在末尾又按播放
  if (transport.seconds >= startOffset + score.duration - 0.05) {
    transport.seconds = startOffset;
  }
  transport.start();
  $('play').textContent = '暂停';
}

function stop({ releaseAudio = true } = {}) {
  if (usingAudio()) {
    player.stop();
  }
  transport.stop();
  transport.cancel(0);
  scheduled = false;
  // 手动停止要立刻掐断；播放到结尾自动停时让最后一个和弦自然衰减
  if (releaseAudio) piano.releaseAll();
  $('play').textContent = '播放';
  $('seek').value = '0';
  refreshHud();
}

function loop() {
  requestAnimationFrame(loop);

  stage.update(viewScoreTime(), fallDuration());
  stage.draw();

  updateGrip();
  // 进度条（拖动时不要回写，否则会和手指打架）
  const dur = totalDuration();
  if (!dragging && dur > 0) {
    $('seek').value = String(Math.round((curScoreTime() / dur) * 1000));
  }
  // 只在文字真的变了才写 DOM（否则每秒 60 次布局抖动）
  const nowLabel = fmt(curScoreTime());
  if (nowLabel !== lastTimeLabel) {
    lastTimeLabel = nowLabel;
    $('tNow').textContent = nowLabel;
  }

  if (usingAudio()) {
    // 音频播完就停（给 0.15s 余量）
    if (player.playing && player.finished) stop({ releaseAudio: false });
    // mp3 结尾常有几秒编码静音：到"谱面结束 + 余音"就停，别让画面空转
    else if (player.playing && totalDuration() > 0 && player.time() > totalDuration() + 0.05) stop({ releaseAudio: false });
    if (!player.playing && player.finished) $('play').textContent = '播放';
  } else if (transport.state === 'started' && score.duration > 0 && transport.seconds > startOffset + score.duration + 2.5) {
    stop({ releaseAudio: false });
  }

  frames++;
  const now = performance.now();
  if (now - fpsClock >= 500) {
    fps = Math.round((frames * 1000) / (now - fpsClock));
    frames = 0;
    fpsClock = now;
    refreshHud();
  }
}

async function loadFile(file) {
  if (!file) return;
  const name = (file.name || '').toLowerCase();
  try {
    let next;
    if (name.endsWith('.mscz') || name.endsWith('.mscx')) {
      next = await msczToScore(file, {
        onStep: (step) => {
          if (step === 'render') {
            beginRenderStatus('正在预渲染原谱音频（3 分钟的曲子约 20 秒）');
          } else if (step === 'cache') {
            endRenderStatus();
            setHud('用上次渲染好的音频，秒开', 2500);
          } else if (step === 'render-failed') {
            endRenderStatus();
          } else {
            setHud('解析乐谱…', Infinity);
          }
        },
      });
    } else {
      next = scoreFromMidiBytes(new Uint8Array(await file.arrayBuffer()));
    }
    if (!next.notes.length) throw new Error('这个文件里没有解析到音符');
    clearHud();
    endRenderStatus();
    await applyScore({ ...next, name: file.name }, { autoPlay: true });
  } catch (err) {
    endRenderStatus();
    console.error(err);
    setHud(`载入失败：${err?.message ?? err}\n（mscz 需要联网下载 webmscore；也可以先用 MuseScore 导出 .mid）`, 20000);
  }
}

function boot() {
  try {
    stage = createStage($('stage'));
    panes = createPanes($('stage'), { stage });
    infoWin = makeWindow($('info'), {
      key: 'piano-falls:info',
      defaultOpen: true,
      onChange: (open) => $('infoBtn').classList.toggle('on', open),
    });
    $('infoBtn').classList.toggle('on', infoWin.isOpen());
    piano = new Piano();
    transport = Tone.getTransport();

    stage.resize();
    applyScore(demoScore());
    requestAnimationFrame(loop);
    window.__stage = stage; // 调试用：控制台里 __stage.debug()
    window.__PIANO_READY__ = true;
  } catch (err) {
    fatal(err);
  }
}

// ---------------- UI 绑定 ----------------
// ---- 琴键上沿拖拽：改变琴键高度（钢琴窗格）----
const KEYFRAC_LS = 'piano-falls:keyfrac';
function applySavedKeyFrac() {
  const saved = Number(localStorage.getItem(KEYFRAC_LS));
  if (Number.isFinite(saved) && saved > 0) stage.setKeyFrac(saved);
  else stage.setKeyFrac(0.28);
}

function keyFracPanes() {
  return (stage?.getPanes?.() ?? []).filter((p) => !p.hidden && p.kind === 'piano');
}

function updateGrip() {
  const grip = $('keyGrip');
  if (!grip) return;
  const panes = keyFracPanes();
  if (!panes.length) {
    grip.hidden = true;
    return;
  }
  const rect = panes[0].rect;
  const frac = stage.getKeyFrac();
  grip.hidden = false;
  grip.classList.add('on');
  grip.style.left = `${rect.x + 6}px`;
  grip.style.width = `${Math.max(40, rect.w - 12)}px`;
  grip.style.top = `${rect.y + rect.h * (1 - frac) - 6}px`;
}

let gripDrag = null;
$('keyGrip')?.addEventListener('pointerdown', (e) => {
  const panes = keyFracPanes();
  if (!panes.length) return;
  e.preventDefault();
  gripDrag = { rect: panes[0].rect };
  $('keyGrip').classList.add('dragging');
  $('keyGrip').setPointerCapture?.(e.pointerId);
});
$('keyGrip')?.addEventListener('pointermove', (e) => {
  if (!gripDrag) return;
  const frac = 1 - (e.clientY - gripDrag.rect.y) / Math.max(1, gripDrag.rect.h);
  stage.setKeyFrac(frac);
  localStorage.setItem(KEYFRAC_LS, String(stage.getKeyFrac().toFixed(3)));
});
$('keyGrip')?.addEventListener('pointerup', (e) => {
  gripDrag = null;
  $('keyGrip').classList.remove('dragging');
  $('keyGrip').releasePointerCapture?.(e.pointerId);
});

// ---- 控制栏：播放时收成一条小白条，点一下展开 ----
const BAR_INSET_FULL = 168;
const BAR_INSET_COLLAPSED = 44;

function setBarCollapsed(on) {
  const panel = $('panel');
  if (!panel) return;
  panel.classList.toggle('collapsed', !!on);
  panel.title = on ? '点击展开控制栏' : '';
  requestAnimationFrame(syncBarInsets);
}

/** 底部留白按控制栏的真实高度算：琴键下沿正好贴着控制栏上沿 */
function syncBarInsets() {
  if (!stage) return;
  const panel = $('panel');
  if (!panel) return;
  if (panel.classList.contains('collapsed')) {
    stage.setInsets(96, 44);
    stage.resize();
    return;
  }
  const r = panel.getBoundingClientRect();
  const bottom = Math.max(24, Math.round(window.innerHeight - r.top + 2));
  stage.setInsets(96, bottom);
  stage.resize();
}

$('barGrip')?.addEventListener('click', (e) => {
  e.stopPropagation();
  setBarCollapsed(true);
});

$('panel')?.addEventListener('click', () => {
  if ($('panel').classList.contains('collapsed')) setBarCollapsed(false);
});

$('play').addEventListener('click', () => {
  // 空格已经由 keydown 处理过了，按钮自己的空格激活不要再触发一次
  // （否则一次空格 = pause+play 两次翻转，位置会被搞乱甚至回到开头）
  if (performance.now() - lastSpaceHandle < 350) return;
  togglePlay().catch(fatal);
});
$('stop').addEventListener('click', () => stop());
$('demoBtn').addEventListener('click', () => applyScore(demoScore()));
$('fileBtn').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => { loadFile(e.target.files?.[0]); e.target.value = ''; });

$('modeBtn').addEventListener('click', () => {
  const next = stage.getMode() === '2d' ? '3d' : '2d';
  stage.setMode(next);
  $('modeBtn').textContent = next === '2d' ? '透视 3D' : '平面 2D';
  $('modeBtn').classList.toggle('on', next === '3d');
  refreshHud();
});

$('infoBtn').addEventListener('click', () => {
  const isOpen = infoWin ? infoWin.toggle() : $('info').classList.toggle('on');
  $('infoBtn').classList.toggle('on', !!isOpen);
});

// ---- 版本提示：服务器上的代码更新了，提醒刷新（否则会一直跑旧页面）----
let pageBuild = null;
async function checkBuild() {
  try {
    const res = await fetch('/version');
    const { build } = await res.json();
    if (!build || build === '0') return;
    if (pageBuild === null) pageBuild = build;
    else if (build !== pageBuild) setHud('程序已更新：按 Ctrl+F5 刷新页面以使用新版本', Infinity);
  } catch {
    /* 忽略 */
  }
}

// ---- 声部面板 ----
let muteToken = 0;

function buildPartList() {
  const el = $('partList');
  if (!el) return;
  const rows = [];
  (score?.lanes ?? []).forEach((lane, i) => {
    if (lane.kind === 'piano') {
      for (const [hand, label] of [[0, '右手'], [1, '左手']]) {
        rows.push(
          `<div class="part-row"><span class="part-name">${label}</span>` +
            `<label><input type="checkbox" data-kind="show" data-hand="${hand}" ${partState.hiddenHands.has(hand) ? '' : 'checked'}/>显示</label>` +
            `<label><input type="checkbox" data-kind="sound" data-hand="${hand}" ${partState.mutedHands.has(hand) ? '' : 'checked'}/>发声</label></div>`,
        );
      }
    } else {
      rows.push(
        `<div class="part-row"><span class="part-name">${escapeHtml(lane.name)}</span>` +
          `<label><input type="checkbox" data-kind="sound" data-lane="${i}" ${partState.mutedLanes.has(i) ? '' : 'checked'}/>发声</label></div>`,
      );
    }
  });
  rows.push(
    `<label class="part-link"><input type="checkbox" id="linkSound" ${partState.link ? 'checked' : ''}/>隐藏时同时静音</label>`,
  );
  rows.push(`<div class="part-cache"><span id="cacheInfo">渲染缓存读取中…</span><button id="clearCache" class="pane-reset">清理缓存</button></div>`);
  el.innerHTML = '<h3>声部</h3>' + rows.join('') + `<div class="part-hint">${stemsReady ? '分轨已就绪：静音即时生效' : '正在准备分轨，就绪前改发声要重渲约 15 秒'}</div>`;

  el.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const hand = cb.dataset.hand !== undefined ? Number(cb.dataset.hand) : null;
      const lane = cb.dataset.lane !== undefined ? Number(cb.dataset.lane) : null;
      if (cb.dataset.kind === 'show') {
        if (cb.checked) partState.hiddenHands.delete(hand);
        else partState.hiddenHands.add(hand);
        stage?.setHandVisible(hand, cb.checked);
        if (partState.link) {
          if (cb.checked) partState.mutedHands.delete(hand);
          else partState.mutedHands.add(hand);
          buildPartList();
          applyMutes();
        }
      } else {
        if (hand !== null) {
          if (cb.checked) partState.mutedHands.delete(hand);
          else partState.mutedHands.add(hand);
        } else if (lane !== null) {
          if (cb.checked) partState.mutedLanes.delete(lane);
          else partState.mutedLanes.add(lane);
        }
        applyMutes();
      }
    });
  });
  el.querySelector('#linkSound')?.addEventListener('change', (e) => {
    partState.link = e.target.checked;
    if (partState.link) {
      // 把当前隐藏的手也静音
      for (const hand of partState.hiddenHands) partState.mutedHands.add(hand);
      buildPartList();
      applyMutes();
    }
  });

  // 缓存：显示占用 + 一键清理（改过渲染逻辑之后旧缓存会失效，需要能清）
  const info = el.querySelector('#cacheInfo');
  cacheStats().then(({ count, bytes }) => {
    if (info) info.textContent = count ? `渲染缓存 ${count} 项 · ${(bytes / 1048576).toFixed(1)} MB` : '渲染缓存为空';
  });
  el.querySelector('#clearCache')?.addEventListener('click', async () => {
    const okClear = await clearRenders();
    // 只清磁盘缓存，不动当前会话已经装好的分轨，否则播放器状态和界面会打架
    score._muteCache?.clear();
    if (info) info.textContent = okClear ? '缓存已清理，下次载入会重新渲染' : '清理失败（缓存可能被占用）';
  });
}

/**
 * 自动对齐音画：拿"谱面第一个音的时间"去比"音频里第一个起声"，
 * 差值就是渲染+编码带来的固定延迟（mp3 编码器延迟通常 20~50ms）。
 * 用户手动拖过滑块就不再自动改。
 */
let offsetManual = false;

/** 用音频字节离线解码，量出"第一个起声"比谱面第一个音晚多少毫秒 */
async function calibrateOffsetFromBytes(bytes) {
  if (offsetManual || !bytes || !score?.notes?.length) return null;
  let buf;
  try {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return null;
    const octx = new Offline(1, 44100 * 2, 44100);
    const copy = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes;
    buf = await octx.decodeAudioData(copy);
  } catch {
    return null;
  }
  if (!buf) return null;
  const firstNote = Math.min(...score.notes.map((n) => n.time));
  if (!Number.isFinite(firstNote)) return null;

  const c = buf.getChannelData(0);
  const sr = buf.sampleRate;
  const win = Math.min(c.length, Math.floor(sr * 4));
  let peak = 0;
  for (let i = 0; i < win; i++) peak = Math.max(peak, Math.abs(c[i]));
  if (peak < 0.004) return null; // 开头是静音，无法判断
  const threshold = peak * 0.06;
  let onset = 0;
  for (let i = 0; i < c.length; i++) {
    if (Math.abs(c[i]) > threshold) {
      onset = i / sr;
      break;
    }
  }
  const deltaMs = Math.round((onset - firstNote) * 1000);
  if (!Number.isFinite(deltaMs) || deltaMs < 8 || deltaMs > 300) return null;
  // 声音比画面晚 deltaMs → 把画面也往后推同样多
  userOffsetMs = -deltaMs;
  const slider = $('lat');
  if (slider) slider.value = String(userOffsetMs);
  const label = $('latVal');
  if (label) label.textContent = `${userOffsetMs}ms`;
  return userOffsetMs;
}

/** 分轨就绪后：把静音映射成各轨的增益 */
function applyStemGains() {
  if (!player?.setMute) return false;
  const muted = new Set(mutedStaffIds());
  for (const lane of score?.lanes ?? []) {
    for (const sid of lane.staffIds ?? []) player.setMute(sid, muted.has(sid));
  }
  return true;
}

/** 准备分轨：每个谱表单独渲染一轨（只保留它自己），之后静音就是即时的 */
let stemsPromise = null;

async function prefetchStems({ quiet = false } = {}) {
  if (stemsReady || stemsPromise || !score?.mscxText) return stemsPromise;
  const staffIds = [...new Set((score.lanes ?? []).flatMap((l) => l.staffIds ?? []))].sort((a, b) => a - b);
  if (staffIds.length < 2) {
    // 只有一轨就没有分轨的意义
    return null;
  }
  const btn = $('partsBtn');
  const label = (txt) => {
    if (btn) btn.textContent = txt;
  };
  const token = ++stemsToken;
  const myScore = score;
  stemsPromise = (async () => {
    if (!quiet) label(`声部 · 备轨 0/${staffIds.length}`);
    try {
      const stems = [];
      for (let i = 0; i < staffIds.length; i++) {
        const id = staffIds[i];
        label(`声部 · 备轨 ${i}/${staffIds.length}`);
        const cacheKey = `${score.name}|${score.mscxText.length}|stem2:${id}`;
        let hit = await getRender(cacheKey);
        if (!hit?.audio) {
          const others = staffIds.filter((x) => x !== id);
          const bytes = await renderMuted(muteStaffs(score.mscxText, others));
          hit = { audio: bytes };
          putRender(cacheKey, hit);
        }
        if (token !== stemsToken || score !== myScore) return; // 换谱了，停止备轨
        stems.push({ key: id, bytes: hit.audio });
      }
      label(`声部 · 备轨 ${staffIds.length}/${staffIds.length}`);
      await switchToStems(stems, token);
    } catch (err) {
      stemsPromise = null;
      setHud(`分轨准备失败，静音仍可用（每次重渲约 15 秒）：${err?.message ?? err}`, 9000);
    } finally {
      if (btn) btn.textContent = '声部';
    }
    return true;
  })();
  return stemsPromise;
}

/** 换成分轨播放器，接住当前播放位置 */
/** 备轨令牌：换谱子后，上一首还在跑的备轨结果必须作废（否则会把播放器换成旧曲子的音频） */
let stemsToken = 0;

async function switchToStems(stems, token) {
  if (token !== undefined && token !== stemsToken) return; // 已经换谱了，这次结果作废
  const pos = player ? Math.max(0, player.time()) : 0;
  const wasPlaying = !!player?.playing;
  const next = new MediaPlayer();
  await next.load(stems); // 解码期间旧音轨继续响
  // 再等"能立刻出声"：只等元数据就起播，几条轨的起播时刻会差几十毫秒
  await next.ready?.();
  next.setRate?.(speedRate);
  // 偏移校准要离线解码 2MB：放在起播之前，别和起播抢 CPU
  if (stems?.[0]?.bytes) await calibrateOffsetFromBytes(stems[0].bytes);
  // 位置要现取：上面等解码的时候旧播放器还在往前放
  const livePos = player ? Math.max(0, player.time()) : pos;
  const old = player;
  if (old) {
    old.pause();
    old.dispose?.();
  }
  window.__oldPlayer = old;
  next.setVolumeDb(Number($('vol').value));
  next.seek(livePos);
  if (wasPlaying) next.play({ delay: 0 });
  player = next;
  window.__player = next;
  playerActive = true;
  stemsReady = true;
  applyStemGains();
  if (!$('partList').hidden) buildPartList();
  clearHud();
  refreshHud();
}
async function applyMutes() {
  // 分轨就绪时：直接把增益拉到 0，立即生效
  if (stemsReady && player?.setMute) {
    applyStemGains();
    refreshHud();
    return;
  }
  if (!score?.mscxText) {
    setHud('这个谱子不能按声部静音（没有原始谱面）', 5000);
    return;
  }
  const token = ++muteToken;
  const staffIds = mutedStaffIds();
  const wasPlaying = !!player?.playing;
  const pos = player ? Math.max(0.02, player.time()) : 0;
  setHud(staffIds.length ? '正在按声部静音重新渲染音频…（约 15 秒）' : '正在恢复原谱音频…', Infinity);
  try {
    const key = staffIds.slice().sort().join(',');
    if (!score._muteCache) score._muteCache = new Map();
    let bytes = staffIds.length ? score._muteCache.get(key) : (score._fullAudio ?? score.audio);
    if (!bytes) {
      bytes = await renderMuted(muteStaffs(score.mscxText, staffIds));
      if (token !== muteToken) return; // 又改了一次，这次结果作废
      score._muteCache.set(key, bytes);
    }
    if (!player) player = new MediaPlayer();
    await player.load(bytes);
    player.setRate?.(speedRate);
    player.setVolumeDb(Number($('vol').value));
    playerActive = true;
    player.seek(pos);
    if (wasPlaying) player.play();
    clearHud();
    refreshHud();
  } catch (err) {
    setHud(`静音渲染失败：${err?.message ?? err}`, 9000);
  }
}
$('cacheBtn')?.addEventListener('click', async () => {
  const btn = $('cacheBtn');
  const { count, bytes } = await cacheStats();
  const ok = await clearRenders();
  stemsPromise = null;
  score?._muteCache?.clear();
  setHud(ok ? `已清理渲染缓存：${count} 项 / ${(bytes / 1048576).toFixed(1)} MB。下次载入会重新渲染。` : '清理缓存失败（可能被占用）', 6000);
  if (btn) {
    btn.textContent = ok ? '已清理' : '缓存';
    setTimeout(() => {
      btn.textContent = '缓存';
    }, 2000);
  }
});

$('partsBtn')?.addEventListener('click', () => {
  const el = $('partList');
  if (!el) return;
  const open = el.hidden;
  el.hidden = !open;
  if (open) {
    buildPartList();
    if (!stemsReady) prefetchStems();
  }
});

// ---- 窗格：布局预设 + 显示/隐藏 ----
$('splitV')?.addEventListener('click', () => panes?.setLayout('split-v'));
$('splitH')?.addEventListener('click', () => panes?.setLayout('split-h'));
$('gridBtn')?.addEventListener('click', () => panes?.setLayout('grid'));
$('panesBtn')?.addEventListener('click', () => panes?.toggleList());

$('fall').addEventListener('input', () => {
  $('fallVal').textContent = `${fallDuration().toFixed(1)}s`;
});
$('speed').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  applySpeed(v);
  localStorage.setItem('piano-falls:speed', String(v));
});

/** 变速：音频改 playbackRate，合成引擎改 transport.playbackRate */
function applySpeed(v) {
  const rate = Math.max(0.25, Math.min(2, Number(v) || 1));
  player?.setRate?.(rate);
  try {
    transport.playbackRate = rate;
  } catch {
    /* ignore */
  }
  const label = $('speedVal');
  if (label) label.textContent = `${rate.toFixed(2)}×`;
  const slider = $('speed');
  if (slider && Math.abs(Number(slider.value) - rate) > 1e-6) slider.value = String(rate);
  speedRate = rate;
}

let speedRate = 1;

$('lat').addEventListener('input', (e) => {
  userOffsetMs = Number(e.target.value);
  offsetManual = true; // 用户自己拖过，之后不再自动校准
  $('latVal').textContent = `${userOffsetMs}ms`;
});
$('measures').addEventListener('change', (e) => stage.setMeasureVisible(e.target.checked));
$('vol').addEventListener('input', (e) => {
  const db = Number(e.target.value);
  piano.setVolume(db);
  if (player) player.setVolumeDb(db);
});

const seekEl = $('seek');
seekEl.addEventListener('pointerdown', () => { dragging = true; });
window.addEventListener('pointerup', () => { dragging = false; });
seekEl.addEventListener('input', () => {
  if (score.duration > 0) seekTo((Number(seekEl.value) / 1000) * score.duration);
});

let lastSpaceHandle = 0;
let lastToggleAt = 0;
window.addEventListener('keydown', (e) => {
  // 空格永远只管播放/暂停：先把焦点从按钮/滑块上摘掉，
  // 否则浏览器还会把这个空格当成"激活当前控件"，一次按键做两件事。
  if (e.code === 'Space') {
    e.preventDefault();
    const active = document.activeElement;
    if (active && active !== document.body && typeof active.blur === 'function') active.blur();
    lastSpaceHandle = performance.now();
    togglePlay().catch(fatal);
    return;
  }
  if (e.target instanceof HTMLInputElement) return;
  const step = e.shiftKey ? 1 : 5;
  if (e.code === 'ArrowRight') { e.preventDefault(); seekTo(curScoreTime() + step); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); seekTo(curScoreTime() - step); }
  else if (e.code === 'Home') { e.preventDefault(); seekTo(0); }
  else if (e.code === 'KeyD') { e.preventDefault(); debugAV = !debugAV; refreshHud(); }
  else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    e.preventDefault();
    const v = clamp(fallDuration() + (e.code === 'ArrowUp' ? 0.1 : -0.1), Number($('fall').min), Number($('fall').max));
    $('fall').value = String(v);
    $('fallVal').textContent = `${v.toFixed(1)}s`;
  }
});

window.addEventListener('resize', () => {
  stage?.resize();
  syncBarInsets();
  panes?.relayout();
});
// 只接真正的运行时错误；资源加载失败（img/script 的 error）不弹整屏提示
window.addEventListener('error', (e) => {
  if (!(e instanceof ErrorEvent)) return;
  fatal(e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => fatal(e.reason));

// 拖拽载入
const drop = $('drop');
window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('on'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('on'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('on');
  loadFile(e.dataTransfer?.files?.[0]);
});

boot();
// 版本号只有一个来源（src/version.js），别在页面里再抄一份
{
  const tag = `v${VERSION}`;
  const el = $('ver');
  if (el) el.textContent = tag;
  document.title = `Piano Falls ${tag}`;
}
// 恢复上次的速度
{
  const saved = Number(localStorage.getItem('piano-falls:speed'));
  if (Number.isFinite(saved) && saved > 0) applySpeed(saved);
}
// 控制栏高度可能随字体/换行变化，起来之后再对一次
requestAnimationFrame(syncBarInsets);

// 每 60 秒问一次服务器上的版本，变了就提示刷新（用户常常开着旧页面）
checkBuild();
setInterval(checkBuild, 60000);