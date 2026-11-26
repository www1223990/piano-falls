// 把各种来源统一成一条「与渲染无关」的音符流，坐标只有秒（相对曲首）。
// { midi, time, dur, soundDur, vel, hand }
//   time     —— 键按下 / 音符条落地的时刻
//   dur      —— 键保持按下的时长（视觉）
//   soundDur —— 实际发声时长（被 CC64 踏板延音时 > dur）
// 这一层纯粹是数据换算，不涉及任何 DOM / Three.js，所以能在 Node 里单测。

import { Midi } from '@tonejs/midi';
import { describeKey } from './mscx.js';
import { stringFamilyOf, fingeringFor, stringCrossings } from './instruments.js';

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SUSTAIN_CC = 64;
const MAX_SUSTAIN = 8;      // 踏板延音上限，防止"一直踩着"把音拖到全曲
const MIN_DUR = 0.05;

/** midi 号 → 音名（Tone.Sampler 用字符串触发最不容易出错） */
export function noteName(midi) {
  return NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{notes:Array, measures:number[], duration:number, name:string, trackCount:number}}
 */
export function scoreFromMidiBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // 必须切出真实区间：Uint8Array 可能只是更大 buffer 的视图
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  let midi;
  try {
    midi = new Midi(ab);
  } catch (err) {
    // 最常见的情况：上游转换出来的是空 MIDI（只有 14 字节的文件头）
    throw new Error(`MIDI 解析失败（${u8.byteLength} 字节）：${err?.message ?? err}`);
  }
  return normalizeMidi(midi);
}

/** 从一条轨道的 CC64 事件整理出踏板开关时间线 */
function extractPedal(track) {
  const cc = track.controlChanges?.[SUSTAIN_CC];
  if (!cc || !cc.length) return [];
  return cc
    .map((e) => ({ time: e.time, down: e.value >= 0.5 }))
    .sort((a, b) => a.time - b.time);
}

/**
 * 踏板踩下时，音在松键后继续响，直到踏板抬起。
 * @returns {number} 应该响到的绝对时刻（无踏板作用时就是自然结束）
 */
function pedalEnd(pedal, t0, tEnd) {
  // 二分：t0 时刻之前最后一个事件决定当前踏板状态
  let lo = 0;
  let hi = pedal.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pedal[mid].time <= t0) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx < 0 || !pedal[idx].down) return tEnd;

  for (let i = idx + 1; i < pedal.length; i++) {
    if (!pedal[i].down) return Math.max(tEnd, pedal[i].time);
  }
  return Infinity; // 之后一直踩着
}

/** @param {import('@tonejs/midi').Midi} midi */
export function normalizeMidi(midi) {
  const tracks = (midi.tracks ?? []).filter((t) => t.notes && t.notes.length > 0);
  // 钢琴在 MuseScore 的 MIDI 导出里通常是"一个声部一条轨道"（左右手各一条），
  // 但单轨 / 多声部混排不一定，所以只在前几条都有音符时信任轨道顺序。
  const byTrack = tracks.length >= 2 && tracks.length <= 4;
  const notes = [];

  tracks.forEach((track, ti) => {
    const hand = byTrack ? Math.min(ti, 1) : null;
    const pedal = extractPedal(track);
    for (const n of track.notes) {
      const dur = Math.max(MIN_DUR, n.duration);
      const end = pedal.length ? pedalEnd(pedal, n.time, n.time + dur) : n.time + dur;
      notes.push({
        midi: n.midi,
        time: n.time,
        dur,
        soundDur: clamp(end - n.time, dur, MAX_SUSTAIN),
        vel: clamp(n.velocity ?? 0.8, 0.05, 1),
        hand,
        track: ti,
      });
    }
  });

  // 单轨（左右手挤在一起）→ 用音高猜手，只为配色，不参与任何时间计算
  if (!byTrack) for (const n of notes) n.hand = n.midi >= 60 ? 0 : 1;

  notes.sort((a, b) => a.time - b.time || a.midi - b.midi);

  return {
    notes,
    measures: measureTimes(midi),
    duration: notes.reduce((m, n) => Math.max(m, n.time + Math.max(n.dur, n.soundDur)), 0),
    name: midi.name || '',
    trackCount: tracks.length,
    via: 'midi',
  };
}

/**
 * 小节起点（秒）。瀑布流的横向参考线 + 进度刻度都用它。
 * 由 timeSignature + tempo map 推，不依赖排版，所以 webmscore 的 Boost Mode 也能用。
 */
export function measureTimes(midi, maxMeasures = 4000) {
  const header = midi.header;
  const ppq = header?.ppq || 480;
  const sigs = (header?.timeSignatures ?? []).map((s) => ({ ...s })).sort((a, b) => a.ticks - b.ticks);
  if (!sigs.length || sigs[0].ticks > 0) sigs.unshift({ ticks: 0, timeSignature: [4, 4] });

  let endTicks = 0;
  for (const t of midi.tracks ?? []) {
    for (const n of t.notes) endTicks = Math.max(endTicks, n.ticks + n.durationTicks);
  }
  if (!endTicks) endTicks = ppq * 16;

  const out = [];
  let tick = 0;
  let si = 0;
  while (tick <= endTicks && out.length < maxMeasures) {
    while (si + 1 < sigs.length && sigs[si + 1].ticks <= tick) si++;
    out.push(header.ticksToSeconds(tick));
    const [num, den] = sigs[si].timeSignature;
    tick += Math.max(1, Math.round((num * ppq * 4) / den));
  }
  return out;
}

/**
 * 内置示例：左手根音 + 右手音阶，第一个音单独放在最前面，
 * 专门用来肉眼验收「第一个音符准点落地并出声」。
 */
export function demoScore() {
  const notes = [];
  const add = (midi, time, dur, vel, hand) =>
    notes.push({ midi, time, dur, soundDur: dur, vel, hand, track: hand });

  [60, 62, 64, 65, 67, 69, 71, 72].forEach((m, i) => add(m, i * 0.5, 0.45, 0.92, 0));
  const bass = [[48, 55, 0], [45, 52, 2], [41, 48, 4], [43, 50, 6]];
  for (const [a, b, t] of bass) {
    add(a, t, 1.9, 0.72, 1);
    add(b, t, 1.9, 0.55, 1);
  }
  [60, 64, 67, 72].forEach((m) => add(m, 8, 2.2, 0.86, 0));

  notes.sort((a, b) => a.time - b.time || a.midi - b.midi);

  const duration = notes.reduce((m, n) => Math.max(m, n.time + Math.max(n.dur, n.soundDur)), 0);
  // 120 BPM 的 4/4：每小节 2 秒、每拍 0.5 秒
  const measures = [];
  for (let t = 0; t <= duration + 2; t += 2) measures.push(t);
  const beats = [];
  for (let t = 0.5; t <= duration + 2; t += 0.5) beats.push(t);

  return { notes, measures, beats, duration, name: '内置示例（C 大调）', trackCount: 2 };
}

// ===================== .mscx → 音符流 =====================

/** tick → 秒 的分段换算表（变速曲必须分段，不能用一个平均 BPM） */
export function buildTempoMap(tempos, division) {
  const pts = [{ tick: 0, bpm: 120, seconds: 0 }];
  for (const t of [...(tempos ?? [])].sort((a, b) => a.tick - b.tick)) {
    if (!(t.bpm > 0)) continue;
    const last = pts[pts.length - 1];
    if (t.tick < last.tick) continue;
    if (t.tick === last.tick) {
      last.bpm = t.bpm;
      continue;
    }
    const seconds = last.seconds + ((t.tick - last.tick) / division) * (60 / last.bpm);
    pts.push({ tick: t.tick, bpm: t.bpm, seconds });
  }
  return pts;
}

/** MuseScore 导出的 MIDI → tick→秒 的速度表 + 每个音的真实发音时长 */
export function timingFromMidiBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const midi = new Midi(ab);
  return {
    division: midi.header.ppq,
    tempos: midi.header.tempos.map((t) => ({ tick: t.ticks, bpm: t.bpm })),
    // 音频里这个音到底响了多久：延音线上的长音，谱面时值和实际发音经常不一样，
    // 画面上的条应该跟着"声音什么时候停"，而不是谱面写多长。
    notes: midi.tracks.flatMap((t) => t.notes.map((n) => ({ midi: n.midi, time: n.time, dur: n.duration }))),
  };
}

/**
 * 解析结果（tick）→ 统一的音符流（秒）。
 *
 * 乐器规则（用户定的）：
 *   - 整首只有一种乐器 → 不管是不是键盘，都用钢琴画
 *   - 有多种乐器 → 只取 keyboard.* 的声部，其余忽略（以后做成独立小窗）
 */
export function scoreFromMscx(parsed, { name = '', timing = null, audioLenHint = null } = {}) {
  const { notes, measures, parts } = parsed;
  // timing 来自 MuseScore 导出的 MIDI（和渲染音频同一个播放引擎），
  // 用它换算才能和音频严丝合缝；没有就退回 mscx 里读到的 tempo 标记。
  const mapDivision = timing?.division || parsed.division;
  const scale = mapDivision / parsed.division;

  const makeToSec = (map) => (tickMscx) => {
    const tick = tickMscx * scale;
    let lo = 0;
    let hi = map.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (map[mid].tick <= tick) lo = mid; else hi = mid - 1;
    }
    const p = map[lo];
    return p.seconds + ((tick - p.tick) / mapDivision) * (60 / p.bpm);
  };

  // ---- 速度表二选一：MuseScore 的 MIDI 表 vs 谱面自己的 tempo 标记 ----
  // MIDI 表通常和渲染音频一致，但偶尔会多出"结尾变速"（实测《Cancan》末尾多一个
  // 78 BPM 标记，音频里根本没有），按它换算会把结尾拉长一倍、画面越来越晚。
  // 用 MIDI 的音符时间当裁判：两张表各算一遍，取贴合真实播放的那张。
  const toSecMidi = timing?.tempos?.length ? makeToSec(buildTempoMap(timing.tempos, mapDivision)) : null;
  const toSecMscx = parsed.tempos?.length
    ? makeToSec(buildTempoMap(parsed.tempos.map((t) => ({ tick: t.tick * scale, bpm: t.bpm })), mapDivision))
    : null;

  /** 用 MIDI 实际音符时间检验某张速度表：返回误差中位数（秒） */
  const fitError = (fn) => {
    if (!timing?.notes?.length || !parsed.notes?.length) return Infinity;
    const byPitch = new Map();
    for (const n of timing.notes) {
      if (!byPitch.has(n.midi)) byPitch.set(n.midi, []);
      byPitch.get(n.midi).push(n.time);
    }
    for (const list of byPitch.values()) list.sort((a, b) => a - b);
    const seen = new Map();
    const ds = [];
    for (const n of parsed.notes) {
      const list = byPitch.get(n.midi);
      if (!list) continue;
      const i = seen.get(n.midi) || 0;
      seen.set(n.midi, i + 1);
      if (i >= list.length) continue;
      ds.push(Math.abs(list[i] - fn(n.tick)));
      if (ds.length >= 1200) break;
    }
    if (!ds.length) return Infinity;
    ds.sort((a, b) => a - b);
    return ds[Math.floor(ds.length / 2)];
  };

  let toSec;
  let tempoSource;
  if (toSecMidi && toSecMscx) {
    // 裁判一：音频的真实长度（最可靠——那是用户耳朵听到的东西）。
    // 两张表各算一遍"最后一个音的结束时间"，谁更接近音频长度就用谁。
    const lastTick = parsed.notes.reduce((m, n) => Math.max(m, n.tick + (n.dur || 0)), 0);
    const endMidi = toSecMidi(lastTick);
    const endMscx = toSecMscx(lastTick);
    const audioLen = Number.isFinite(audioLenHint) && audioLenHint > 1 ? audioLenHint : null;
    let useMscx;
    if (audioLen) {
      const dMidi = Math.abs(endMidi - audioLen);
      const dMscx = Math.abs(endMscx - audioLen);
      useMscx = dMscx + 0.3 < dMidi;
    } else {
      // 裁判二（没有音频长度时）：MIDI 音符时间的拟合误差
      useMscx = fitError(toSecMscx) + 0.002 < fitError(toSecMidi);
    }
    toSec = useMscx ? toSecMscx : toSecMidi;
    tempoSource = useMscx ? 'mscx' : 'midi';
  } else if (toSecMidi) {
    toSec = toSecMidi;
    tempoSource = 'midi';
  } else if (toSecMscx) {
    toSec = toSecMscx;
    tempoSource = 'mscx';
  } else {
    toSec = makeToSec(buildTempoMap([], mapDivision));
    tempoSource = 'default';
  }

  /**
   * 用 MIDI 里的真实音符时间校正"书面位置"。
   * 谱面有延长记号/反复/小节重复时，按速度表算出来的位置会和实际演奏差好几秒
   * （实测《Cancan》结尾差 3.6~4.6 秒：和弦早就响完了，画面还在等它落下来）。
   * 只在大偏差时替换（> 0.5s），正常音符一律不动，避免误伤。
   */
  const makeSnapper = () => {
    if (!timing?.notes?.length) return null;
    const byPitch = new Map();
    for (const n of timing.notes) {
      if (!byPitch.has(n.midi)) byPitch.set(n.midi, []);
      byPitch.get(n.midi).push({ time: n.time, dur: n.dur, used: false });
    }
    for (const list of byPitch.values()) list.sort((a, b) => a.time - b.time);
    return (midi, predicted) => {
      const list = byPitch.get(midi);
      if (!list) return null;
      let best = null;
      let bestD = Infinity;
      for (const c of list) {
        if (c.used) continue;
        const d = Math.abs(c.time - predicted);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (!best || bestD > 5 || bestD < 0.5) return null; // 差得不多就不动
      best.used = true;
      return { time: best.time, dur: best.dur };
    };
  };
  const snapNote = makeSnapper();

  const singleInstrument = parts.length <= 1;
  const keyboardParts = parts.filter((p) => p.keyboard);
  const stringParts = parts.filter((p) => !p.keyboard && stringFamilyOf(p.instrumentId));

  // 乐器规则（用户定的，加上弓弦乐器支持后）：
  //   - 键盘乐器 → 钢琴卷帘
  //   - 弓弦乐器（小提琴/中提琴/大提琴/低音提琴）→ 指板卷帘
  //   - 单乐器且上面两种都不支持（比如长笛）→ 退化成钢琴画
  //   - 多乐器时其他乐器仍忽略
  let usedParts;
  if (singleInstrument) {
    usedParts = keyboardParts.length || stringParts.length ? [...keyboardParts, ...stringParts] : parts;
  } else {
    usedParts = [...keyboardParts, ...stringParts];
  }
  const usedSet = new Set(usedParts.map((p) => p.index));
  const ignoredParts = parts.filter((p) => !usedSet.has(p.index));

  // 每条声部一个"轨道"，UI 上就是一个窗格
  const trackByPart = new Map();
  for (const p of usedParts) {
    const family = p.keyboard ? null : stringFamilyOf(p.instrumentId);
    trackByPart.set(p.index, {
      partIndex: p.index,
      kind: p.keyboard ? 'piano' : 'strings',
      name: p.name,
      instrumentId: p.instrumentId,
      family: family ? family.key : null,
      familyName: family ? family.name : '',
      familyDef: family,
      notes: [],
    });
  }

  // 按音高分组的 MIDI 音，用来把"谱面时值"换成"音频里实际响了多久"
  const midiByPitch = new Map();
  if (timing?.notes?.length) {
    for (const m of timing.notes) {
      if (!midiByPitch.has(m.midi)) midiByPitch.set(m.midi, []);
      midiByPitch.get(m.midi).push(m);
    }
    for (const list of midiByPitch.values()) list.sort((a, b) => a.time - b.time);
  }

  /** 找出和这个音对应的 MIDI 音（同音高、起点最近），返回它的发音时长 */
  function audioDuration(midi, time, notated) {
    const list = midiByPitch.get(midi);
    if (!list || !list.length) return null;
    // 取 [time-0.12, time+0.12] 里的候选
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (list[m].time < time) lo = m + 1; else hi = m;
    }
    const candidates = [];
    for (let i = Math.max(0, lo - 3); i < Math.min(list.length, lo + 3); i++) {
      const c = list[i];
      if (!c) continue;
      if (Math.abs(c.time - time) > 0.12) continue;
      candidates.push(c);
    }
    if (!candidates.length) return null;
    // 两个声部同音同时响时，用时值最接近谱面的那个，避免拿错声部
    candidates.sort(
      (a, b) => Math.abs(a.dur - notated) - Math.abs(b.dur - notated) || Math.abs(a.time - time) - Math.abs(b.time - time),
    );
    return candidates[0].dur;
  }

  for (const n of notes) {
    const track = trackByPart.get(n.partIndex);
    if (!track) continue;
    let time = toSec(n.tick);
    let dur = Math.max(0.03, toSec(n.tick + n.dur) - time);
    // 延长/反复导致的大偏差：改用 MIDI 里的真实时间（音频的真相）
    const snap = n.grace ? null : snapNote?.(n.midi, time);
    if (snap) {
      time = snap.time;
      dur = Math.max(0.03, snap.dur || dur);
    }
    if (n.grace) {
      // 倚音：贴着主音前面一点点，画成很短的一条（它本来就不占拍子）
      time = Math.max(0, time - 0.07);
      dur = 0.06;
      track.notes.push({
        midi: n.midi,
        time,
        dur,
        soundDur: dur,
        vel: clamp(n.vel / 127, 0.05, 1),
        hand: n.hand === null || n.hand === undefined ? (n.midi >= 60 ? 0 : 1) : n.hand,
        part: n.partIndex,
        grace: true,
      });
      continue;
    }
    // 谱面时值 vs 音频实际发音：以音频为准（否则延音线的长条会比声音多挂一会儿）
    const audioDur = audioDuration(n.midi, time, dur);
    if (audioDur !== null && audioDur > 0.02) dur = audioDur;
    track.notes.push({
      midi: n.midi,
      time,
      dur,
      soundDur: dur,
      vel: clamp(n.vel / 127, 0.05, 1),
      // 谱表给的左右手是权威；单谱表乐器没有手别，才按音高回落
      hand: n.hand === null || n.hand === undefined ? (n.midi >= 60 ? 0 : 1) : n.hand,
      part: n.partIndex,
    });
  }

  // 键盘轨道放前面（界面里在下面），弓弦按出现顺序
  const lanes = [];
  for (const p of usedParts) {
    const track = trackByPart.get(p.index);
    track.notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
    if (!track.notes.length) continue;
    if (track.kind === 'strings') {
      const fingered = fingeringFor(track.familyDef, track.notes);
      track.notes = fingered.notes;
      track.fingerStats = fingered.stats;
      track.crossings = stringCrossings(fingered.notes);
      track.stringNames = track.familyDef.strings.map((s) => s.name);
      track.stringOpens = track.familyDef.strings.map((s) => s.open);
    }
    lanes.push(track);
  }
  lanes.sort((a, b) => (a.kind === 'piano' ? 0 : 1) - (b.kind === 'piano' ? 0 : 1));

  // ---- 尾部裁剪：音频里不存在的音，画面上也不该有 ----
  // 谱面有反复/延长记号/小节重复时，"书面位置"会超出实际演奏（实测《Cancan》多出 6 小节、
  // 画面比声音晚 3.6 秒，用户听到最后一声在 2:11.8，画面却到 2:15.4）。
  // 判据：MIDI 的最后一个音就是音频里最后一个真实发声点，晚于它 0.5 秒以上的音不可能有声音。
  let midiLastNote = null;
  if (timing?.notes?.length) {
    midiLastNote = timing.notes.reduce((m, n) => Math.max(m, n.time), 0);
    const ourLast = lanes.reduce(
      (m, lane) => lane.notes.reduce((mm, n) => Math.max(mm, n.time), m),
      0,
    );
    if (midiLastNote > 0 && ourLast - midiLastNote > 1) {
      const limit = midiLastNote + 0.5;
      for (const lane of lanes) lane.notes = lane.notes.filter((n) => n.time <= limit);
    }
  }


  const primary = lanes.find((l) => l.kind === 'piano') ?? lanes[0];
  const out = primary ? primary.notes : [];
  const duration = lanes.reduce(
    (m, lane) => lane.notes.reduce((mm, n) => Math.max(mm, n.time + n.dur), m),
    0,
  );
  const measureTimes = measures.map((m) => toSec(m.startTicks)).filter((t, i, a) => i === 0 || t > a[i - 1]);

  // 拍点线：每条小节内均分 n 拍（三连音等不规则时值这里是近似，纯粹当视觉网格）
  const beats = [];
  for (const m of measures) {
    const beatTicks = m.n > 0 ? m.lenTicks / m.n : 0;
    for (let k = 1; k < m.n; k++) {
      beats.push(toSec(m.startTicks + k * beatTicks));
    }
  }
  beats.sort((a, b) => a - b);

  return {
    notes: out,
    measures: measureTimes,
    beats,
    duration,
    tempoSource,
    midiLastNote,
    name: name || parsed.title || '',
    /** 每个乐器一个窗格；键盘在前（界面里排下面），弓弦在后 */
    lanes: lanes.map((lane) => ({
      kind: lane.kind,
      name: lane.name,
      instrumentId: lane.instrumentId,
      partIndex: lane.partIndex,
      staffIds: usedParts.find((p) => p.index === lane.partIndex)?.staffIds ?? [],
      family: lane.family,
      familyName: lane.familyName,
      stringNames: lane.stringNames ?? null,
      stringOpens: lane.stringOpens ?? null,
      notes: lane.notes,
      crossings: lane.crossings ?? [],
      fingerStats: lane.fingerStats ?? null,
    })),
    // 给界面用：哪些乐器画了、哪些被忽略、为什么
    parts: usedParts.map((p) => ({
      name: p.name,
      instrumentId: p.instrumentId,
      keyboard: p.keyboard,
      kind: p.keyboard ? 'piano' : 'strings',
      notes: (trackByPart.get(p.index)?.notes || []).length,
    })),
    ignoredParts: ignoredParts.map((p) => ({ name: p.name, instrumentId: p.instrumentId })),
    mode: singleInstrument ? 'single' : 'multi',
    warnings: parsed.warnings ?? [],
    via: 'mscx',
    // 原谱信息：调号/拍号/速度/时值分布/作曲 —— 界面上要显示的"基本信息"
    info: {
      title: parsed.title || '',
      composer: parsed.meta?.composer || '',
      mscxVersion: parsed.version,
      division: parsed.division,
      keys: (parsed.keySignatures ?? []).map((k) => ({ ...describeKey(k.fifths), time: toSec(k.tick) })),
      timeSignatures: (parsed.timeSignatures ?? []).map((t) => ({ n: t.n, d: t.d, time: toSec(t.tick) })),
      tempos: (parsed.tempos ?? []).map((t) => ({ bpm: t.bpm, time: toSec(t.tick) })),
      noteValues: parsed.noteValues ?? [],
      measureCount: parsed.measures.length,
      noteCount: out.length,
      allParts: parsed.parts.map((p) => ({ name: p.name, instrumentId: p.instrumentId, keyboard: p.keyboard })),
    },
  };
}