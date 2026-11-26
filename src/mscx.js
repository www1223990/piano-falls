// .mscx（MuseScore 工程文件里的 XML）→ 结构化数据。
//
// 为什么不用 MIDI：MIDI 只保留"发声"，丢掉了**乐器归属**和**谱表归属**——
// 而这两样正是"只画键盘乐器"和"区分左右手"的依据。mscx 里这三样都是显式的：
//   <Part id="1"><Staff id="1"/><Staff id="2"/><trackName>钢琴</trackName>
//     <Instrument id="piano"><instrumentId>keyboard.piano</instrumentId>
//   <Staff id="1"><Measure><voice><Chord><durationType>quarter</durationType>
//
// 时值不直接存，要算：durationType × dots × 三连音系数，`measure` 表示整小节。
// tempo 是"每秒拍数"：<tempo>1.916667</tempo> 对应 115 BPM，即 bpm = tempo * 60。
//
// 这个模块只产出 tick（不碰秒），换算交给 score.js，便于离线测试。

import { parseXml, child, childrenOf, kids, textOf, attrOf, numOf, pathOf } from './xml.js';

const QUARTER_RATIO = {
  longa: 16,
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
  '128th': 0.03125,
  '256th': 0.015625,
  measure: 0,
};

/** 动态记号 → 标准 MIDI 力度（没写 <velocity> 时用） */
const DYNAMIC_VELOCITY = { ppp: 16, pp: 33, p: 49, mp: 64, mf: 80, f: 96, ff: 112, fff: 126 };

const KEYBOARD_PREFIX = /^keyboard\./i;
const KEYBOARD_LEGACY = new Set([
  'piano',
  'pianoforte',
  'grand-piano',
  'electric-piano',
  'e-piano',
  'harpsichord',
  'clavichord',
  'celesta',
  'organ',
  'pipe-organ',
]);

/**
 * 判断一个乐器是不是"键盘类"。
 * MuseScore 4 用 `keyboard.piano` 这种带前缀的 id；旧版本只有 `piano`。
 */
export function isKeyboardInstrument(instrumentId, fallbackId) {
  const id = String(instrumentId || fallbackId || '').toLowerCase().trim();
  if (!id) return false;
  if (KEYBOARD_PREFIX.test(id)) return true;
  return KEYBOARD_LEGACY.has(id);
}

function durationTicks(durationType, division, measureLen) {
  const dt = String(durationType || '').toLowerCase();
  if (!dt) return 0;
  if (dt === 'measure') return measureLen;
  const ratio = QUARTER_RATIO[dt];
  if (ratio === undefined) return 0;
  return ratio * division;
}

/** 该 <Measure> 里出现的拍号（可能没有） */
function findTimeSig(measureEl) {
  const walk = (node) => {
    for (const k of kids(node)) {
      if (k.name === 'TimeSig') {
        const n = numOf(k, 'sigN', 4);
        const d = numOf(k, 'sigD', 4);
        return { n: n > 0 ? n : 4, d: d > 0 ? d : 4 };
      }
      const found = walk(k);
      if (found) return found;
    }
    return null;
  };
  return walk(measureEl);
}

/** 该 <Measure> 里出现的调号：concertKey 是"五度圈"位置（0=C，2=两升，-3=三降） */
function findKeySig(measureEl) {
  const walk = (node) => {
    for (const k of kids(node)) {
      if (k.name === 'KeySig') {
        const v = Number(textOf(child(k, 'concertKey')));
        if (Number.isFinite(v)) return { fifths: Math.max(-7, Math.min(7, v)), custom: textOf(child(k, 'accidental')) };
      }
      const found = walk(k);
      if (found) return found;
    }
    return null;
  };
  return walk(measureEl);
}

const MAJOR_BY_FIFTHS = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const MINOR_BY_FIFTHS = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];

/** 五度圈位置 → 调名和升降号个数 */
export function describeKey(fifths) {
  const f = Math.max(-7, Math.min(7, Number(fifths) || 0));
  const major = MAJOR_BY_FIFTHS[f + 7];
  const minor = MINOR_BY_FIFTHS[f + 7];
  const sharpCount = Math.max(0, f);
  const flatCount = Math.max(0, -f);
  const accidental = sharpCount > 0 ? `${sharpCount} 个升号` : flatCount > 0 ? `${flatCount} 个降号` : '没有升降号';
  return { fifths: f, major, minor, sharpCount, flatCount, accidental };
}

/** 时值类型 → 中文名 */
export const DURATION_NAMES = {
  longa: '长音符',
  breve: '倍全音符',
  whole: '全音符',
  half: '二分音符',
  quarter: '四分音符',
  eighth: '八分音符',
  '16th': '十六分音符',
  '32nd': '三十二分音符',
  '64th': '六十四分音符',
  measure: '整小节',
};

export function describeDuration(type, dots) {
  const base = DURATION_NAMES[type] || type;
  if (!dots) return base;
  const dotName = ['', '附点', '双附点', '三附点'][dots] || `${dots} 个附点`;
  return `${dotName}${base}`;
}

/**
 * 8va / 8vb / 15ma 八度线：谱面里写的是"看着的音高"，实际发声要移八度。
 *
 * 两个坑（都实测过）：
 *   1. `<play>0</play>` 表示"只显示不移调"，必须忽略（Cancan 的 m82/m128 就是这种 "loco" 线）
 *   2. `<next><location><measures>N</measures>` 不是"覆盖 N 个小节"，
 *      而是**从线条起点往后 N 个小节** —— 起点常在小节中间（Cancan 的 8va 起在小节第 1.5 拍），
 *      所以 Cancan 那条 `measures=7` 实际盖到第 8 小节的前 1.5 拍。
 *      用"整小节"去算会少盖最后一小节（m8 画低一个八度）。
 * （验证方法：自己写一个 6 小节的 MusicXML 8va 让 MuseScore 导 MIDI，实测 m5 不被移调、m2–m4 被移调）
 */
const OTTAVA_SHIFT = { '8va': 12, '8vb': -12, '15ma': 24, '15mb': -24, '22ma': 36, '22mb': -36 };

/** 某个 tick 上生效的移调量（八度线是 tick 区间，不是小节区间） */
function shiftAtTick(ranges, tick) {
  if (!ranges || !ranges.length) return 0;
  let shift = 0;
  for (const r of ranges) if (tick >= r.start && tick < r.end) shift += r.shift;
  return shift;
}

function hasTag(node, name) {
  return kids(node).some((k) => k.name === name);
}

/**
 * 反复结尾（volta / "1." "2." 跳线）。
 * 写法：<Spanner type="Volta"><Volta>…<endings>1</endings></Volta>
 *        <next><location><measures>2</measures></location></next></Spanner>
 * span = 这一段结尾占几个小节；endings = 只在这些遍数里演奏。
 * 没有 <endings> 的 Volta 只是排版续接（MuseScore 会多写一份），忽略。
 */
function voltaOf(node) {
  let found = null;
  const walk = (n) => {
    for (const k of kids(n)) {
      if (k.name === 'Spanner' && attrOf(k, 'type', '') === 'Volta') {
        const raw = textOf(child(child(k, 'Volta'), 'endings'));
        const endings = raw
          ? raw.split(',').map((s) => Number(s.trim())).filter((x) => Number.isFinite(x) && x > 0)
          : [];
        if (endings.length) {
          const span = numOf(pathOf(k, 'next/location'), 'measures', 1);
          found = { endings, span: Math.max(1, Math.floor(span)) };
        }
      }
      if (!found) walk(k);
    }
  };
  walk(node);
  return found;
}

/** 小节长度：正常由拍号决定；弱起小节用 <len>1/4</len>（以全音符为 1） */
function measureLength(measureEl, sig, division) {
  // 多小节休止（<multiMeasureRest>N</multiMeasureRest> + len="N*4/4"）是**压缩显示**：
  // 它本身不占时间，真正的时长由紧随其后的占位小节承担
  // （实测：len 算 8/4 会让画面晚 2.8 秒，按拍号算仍晚 1.4 秒，算 0 才和音频对齐）。
  if (numOf(measureEl, 'multiMeasureRest', 0) > 0) return 0;
  // MuseScore 3 把弱起长度写成属性 <Measure len="1/4">，4.x 用子元素 <len>。
  // 只认子元素的话，弱起小节会被当成整小节，后面所有音符整体晚 3 拍左右。
  const raw = attrOf(measureEl, 'len') || textOf(child(measureEl, 'len')) || '';
  if (raw) {
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(raw);
    if (m) {
      const wholeTicks = division * 4;
      const ticks = (Number(m[1]) / Number(m[2])) * wholeTicks;
      if (Number.isFinite(ticks) && ticks > 0) return Math.round(ticks);
    }
  }
  return Math.round((sig.n * division * 4) / sig.d);
}

/**
 * @param {string} xmlText .mscx 的文本内容
 * @returns {object} 结构化乐谱（tick 单位）
 */
export function parseMscx(xmlText) {
  const doc = parseXml(xmlText);
  const msNode = child(doc, 'museScore');
  const score = child(msNode, 'Score') || child(doc, 'Score');
  if (!score) throw new Error('不是有效的 .mscx（找不到 <Score>）');

  const version = attrOf(msNode, 'version', '');
  const division = numOf(score, 'Division', 480) || 480;
  const warnings = [];

  // ---------- 1. 乐器 / 谱表 ----------
  const parts = [];
  let staffCursor = 1;
  childrenOf(score, 'Part').forEach((partEl, index) => {
    const instrument = child(partEl, 'Instrument');
    const instrumentId = textOf(pathOf(partEl, 'Instrument/instrumentId')) || attrOf(instrument, 'id', '');
    const name =
      textOf(child(partEl, 'trackName')) ||
      textOf(pathOf(partEl, 'Instrument/longName')) ||
      instrumentId ||
      `Part ${index + 1}`;

    const staffEls = childrenOf(partEl, 'Staff');
    const staffIds = [];
    if (staffEls.length === 0) {
      staffIds.push(staffCursor++);
    } else {
      for (const s of staffEls) {
        const idAttr = Number(attrOf(s, 'id', ''));
        if (Number.isFinite(idAttr) && idAttr > 0) {
          staffIds.push(idAttr);
          staffCursor = Math.max(staffCursor, idAttr + 1);
        } else {
          // MuseScore 4.7 起 Part 里的 <Staff> 不再带 id，只能按出现顺序推
          staffIds.push(staffCursor++);
        }
      }
    }

    parts.push({
      index,
      name,
      instrumentId,
      instrumentName: textOf(pathOf(partEl, 'Instrument/longName')),
      staffIds,
      keyboard: isKeyboardInstrument(instrumentId, attrOf(instrument, 'id', '')),
    });
  });

  const handOf = (info) => {
    // 单谱表乐器没有"左右手"这回事，交回上层按音高回落；多谱表才是真·左右手
    if (!info || info.part.staffIds.length < 2) return null;
    return Math.min(info.staffOrder, 1);
  };

  const staffToPart = new Map();
  for (const p of parts) {
    p.staffIds.forEach((sid, order) => {
      // 同一个乐器内：第 1 条谱表=右手，其余=左手
      staffToPart.set(sid, { part: p, staffOrder: order });
    });
  }

  // ---------- 2. 谱表小节 ----------
  const staffSections = childrenOf(score, 'Staff').map((staffEl) => {
    const id = Number(attrOf(staffEl, 'id', '')) || staffCursor++;
    const measures = childrenOf(staffEl, 'Measure');
    return { id, measures };
  });
  if (!staffSections.length) throw new Error('这个 .mscx 里没有任何谱表内容');

  const firstStaff = staffSections[0];
  const measureCount = firstStaff.measures.length;
  for (const s of staffSections) {
    if (s.measures.length !== measureCount) {
      warnings.push(`谱表 ${s.id} 的小节数（${s.measures.length}）和第 1 谱表（${measureCount}）不一致`);
    }
  }

  // ---------- 3. 小节元信息 + 反复顺序 ----------
  let sig = { n: 4, d: 4 };
  let key = { fifths: 0 };
  const measureMeta = firstStaff.measures.map((m) => {
    const sigHere = findTimeSig(m);
    if (sigHere) sig = sigHere;
    const keyHere = findKeySig(m);
    if (keyHere) key = keyHere;
    return {
      len: measureLength(m, sig, division),
      sig: { ...sig },
      key: { ...key },
      startRepeat: hasTag(m, 'startRepeat'),
      endRepeat: hasTag(m, 'endRepeat'),
      repeatCount: Math.max(0, Math.floor(numOf(m, 'repeatCount', 0))),
      volta: voltaOf(m),
      measureRepeat: hasTag(m, 'measureRepeatCount'),
    };
  });

  /**
   * 演奏顺序。每项 = { index: 谱面小节下标, src: 用哪一小节的内容 }。
   * `%` 小节重复在谱面里是空的，内容要借上一小节，但时间轴用本小节的。
   */
  const order = buildPlayOrder();
  if (order.length > measureCount * 1.3 + 4) {
    // 宁可少画，不能把播放顺序炸开（曾经炸到 14654 音，页面直接卡死）
    warnings.push(`反复展开结果异常（${order.length} 小节 > 谱面 ${measureCount}），已退回顺序播放`);
    order.length = 0;
    for (let i = 0; i < measureCount; i++) order.push({ index: i, src: i });
  }

  function repeatTimesAt(i) {
    const n = measureMeta[i]?.repeatCount ?? 0;
    return n > 0 ? n : 2;
  }

  function buildPlayOrder() {
    const n = measureCount;
    // `%` 可能连着好几小节：一直往前找到真正有内容的那个
    const prevSource = (i) => {
      let s = i - 1;
      while (s > 0 && measureMeta[s].measureRepeat) s--;
      return s;
    };    const voltaAt = new Map(); // 小节下标 -> { start, end, endings }
    for (let i = 0; i < n; i++) {
      const v = measureMeta[i].volta;
      if (!v) continue;
      const end = Math.min(n - 1, i + Math.max(1, v.span) - 1);
      for (let j = i; j <= end; j++) voltaAt.set(j, { start: i, end, endings: v.endings });
    }

    const out = [];
    let i = 0;
    let sectionStart = -1;
    let sectionOpen = false;
    let curPass = 1;
    let justJumped = false;
    let guard = 0;
    while (i < n && guard++ < n * 8 + 16) {
      const meta = measureMeta[i];
      if (meta.startRepeat && !justJumped) {
        sectionStart = i;
        sectionOpen = true;
        curPass = 1;
      }
      justJumped = false;

      const v = voltaAt.get(i);
      if (v && !v.endings.includes(curPass)) {
        // 这一遍不该弹这个结尾：整段跳过去（1. 结尾在第 2 遍要跳过，反之亦然）
        let endRepeatAt = -1;
        for (let j = v.start; j <= v.end; j++) if (measureMeta[j].endRepeat) endRepeatAt = j;
        if (endRepeatAt >= 0 && sectionOpen) {
          const times = repeatTimesAt(endRepeatAt);
          curPass++;
          if (curPass <= times) {
            justJumped = true;
            i = sectionStart;
          } else {
            sectionOpen = false;
            curPass = times; // 停在最后一遍，段后的"2."结尾才能被弹到
            i = v.end + 1;
          }
        } else {
          i = v.end + 1;
        }
        continue;
      }

      out.push({ index: i, src: meta.measureRepeat && i > 0 ? prevSource(i) : i });
      if (meta.endRepeat) {
        const times = repeatTimesAt(i);
        if (curPass < times) {
          curPass++;
          justJumped = true;
          i = sectionStart;
          continue;
        }
        sectionOpen = false;
      }
      i++;
    }
    return out;
  }

  const measures = [];
  {
    let tick = 0;
    for (const entry of order) {
      const meta = measureMeta[entry.index];
      measures.push({ index: entry.index, startTicks: tick, lenTicks: meta.len, n: meta.sig.n, d: meta.sig.d, fifths: meta.key.fifths });
      tick += meta.len;
    }
  }

  // 拍号 / 调号 的变化点（按播放顺序，跳过重复的相同值）
  const timeSignatures = [];
  const keySignatures = [];
  {
    let lastSig = null;
    let lastKey = null;
    for (const m of measures) {
      const meta = measureMeta[m.index];
      if (!lastSig || lastSig.n !== meta.sig.n || lastSig.d !== meta.sig.d) {
        timeSignatures.push({ tick: m.startTicks, n: meta.sig.n, d: meta.sig.d });
        lastSig = meta.sig;
      }
      if (!lastKey || lastKey !== meta.key.fifths) {
        keySignatures.push({ tick: m.startTicks, fifths: meta.key.fifths });
        lastKey = meta.key.fifths;
      }
    }
    if (!keySignatures.length) keySignatures.push({ tick: 0, fifths: 0 });
  }

  // ---------- 4. 逐音 ----------
  const notes = [];
  const tempos = [];
  const titleText = extractTitle(score);

  /** 每条谱表的力度状态（<Dynamic> 会一直生效到下一个） */
  const velocity = new Map();
  /** 每条谱表的音符数（合并连音线之前，用来核对文件内容） */
  const countByStaff = new Map();
  /** 时值分布：附点八分音符 × 56 这种 */
  const noteValues = new Map();
  /** 每条谱表当前生效的八度线区间 { start, end, shift }（起点可能在小节中间） */
  const ottavaRanges = new Map();

  function processMeasure(measureEl, staffId, measureStart, measureLen, isFirstStaff) {
    const voices = childrenOf(measureEl, 'voice');
    const containers = voices.length ? voices : [measureEl];
    const partInfo = staffToPart.get(staffId);
    let filledMax = 0;

    for (let voiceIndex = 0; voiceIndex < containers.length; voiceIndex++) {
      let cursor = measureStart;
      let tuplet = null;
      let tremoloPartner = false; // 两音颤音的第二组和弦（不推进游标）
      // 新版 mscx 用 <endTuplet/> 显式结束，连里面的休止符也一起缩放；
      // 老格式没有这个标签，只能按 actualNotes 计数。
      const scoped = kids(containers[voiceIndex]).some((k) => k.name === 'endTuplet');

      for (const el of kids(containers[voiceIndex])) {
        switch (el.name) {
          case 'TimeSig':
          case 'KeySig':
          case 'Clef':
          case 'BarLine':
          case 'LayoutBreak':
            break;

          case 'Tempo': {
            if (!isFirstStaff) break;
            const raw = numOf(el, 'tempo', 0);
            if (raw > 0) {
              const bpm = raw * 60; // 实测：1.916667 → 115 BPM
              tempos.push({ tick: cursor, bpm });
            }
            break;
          }

          case 'Dynamic': {
            const v = numOf(el, 'velocity', 0);
            const subtype = textOf(child(el, 'subtype')).toLowerCase();
            const derived = DYNAMIC_VELOCITY[subtype] ?? 80;
            velocity.set(staffId, v > 0 ? v : derived);
            break;
          }

          case 'Tuplet': {
            const normal = numOf(el, 'normalNotes', 0);
            const actual = numOf(el, 'actualNotes', 0);
            if (normal > 0 && actual > 0) tuplet = { normal, actual, left: actual, counted: !scoped };
            break;
          }

          case 'endTuplet': {
            tuplet = null;
            break;
          }

          case 'Spanner': {
            // 八度线：起点就在当前游标（可能在小节中间），往后 span 个小节结束
            if (attrOf(el, 'type', '') === 'Ottava') {
              const ott = child(el, 'Ottava');
              const shift = OTTAVA_SHIFT[textOf(child(ott, 'subtype'))];
              const noPlay = textOf(child(ott, 'play')) === '0';
              if (shift && !noPlay && child(el, 'next')) {
                const span = Math.max(1, numOf(pathOf(el, 'next/location'), 'measures', 1));
                const list = ottavaRanges.get(staffId) ?? [];
                list.push({ start: cursor, end: cursor + span * measureLen, shift });
                ottavaRanges.set(staffId, list);
              }
            }
            break;
          }

          case 'Chord': {
            // 倚音带 <durationType>，但它是零时值的装饰音：不能算进拍子，
            // 否则它后面的所有音符都会被推后（听感上就是"卡一下再追回来"）。
            const grace = isGraceChord(el);
            const dur = grace ? 0 : eventTicks(el, measureLen, division, tuplet);
            const vel = velocity.get(staffId) ?? 80;
            const noteEls = childrenOf(el, 'Note');
            const dtLabel = textOf(child(el, 'durationType'));
            if (dtLabel) {
              const label = describeDuration(dtLabel, numOf(el, 'dots', 0));
              noteValues.set(label, (noteValues.get(label) || 0) + 1);
            }
            // 两音颤音（TremoloTwoChord）：一个"小节"里写着两个半音符，
            // 实际是两组和弦在整小节内快速交替，两个和弦**同时开始、占满整小节**。
            // 按顺序排会让小节溢出（Cancan 结尾 1920≠960，多出来的音压到下一小节）。
            const twoChordTrem = kids(el).some((k) => k.name === 'TremoloTwoChord');
            const isPartner = tremoloPartner;
            const startAt = isPartner ? measureStart : cursor;
            const soundDur = twoChordTrem || isPartner ? Math.max(0, measureLen) : dur;
            const shift = shiftAtTick(ottavaRanges.get(staffId), startAt);
            for (const noteEl of noteEls) {
              const midi = numOf(noteEl, 'pitch', NaN) + shift;
              if (!Number.isFinite(midi) || midi < 0 || midi > 127) continue;
              notes.push({
                midi,
                tick: startAt,
                dur: soundDur,
                vel,
                staffId,
                partIndex: partInfo ? partInfo.part.index : -1,
                hand: handOf(partInfo),
                voice: voiceIndex,
                tie: isTieStart(noteEl),
                grace,
              });
              countByStaff.set(staffId, (countByStaff.get(staffId) || 0) + 1);
            }
            if (twoChordTrem) {
              tremoloPartner = true;
              cursor = measureStart + measureLen; // 整小节已被占满
            } else if (isPartner) {
              tremoloPartner = false;
            } else {
              cursor += dur;
            }
            break;
          }

          case 'Rest': {
            cursor += eventTicks(el, measureLen, division, tuplet);
            break;
          }

          default:
            break;
        }
      }
      filledMax = Math.max(filledMax, cursor - measureStart);
    }
    return { filled: filledMax, expected: measureLen };
  }

  const mismatch = [];
  {
    let playbackTick = 0;
    for (const entry of order) {
      const meta = measureMeta[entry.index];
      for (const staff of staffSections) {
        // `%` 小节：内容借上一小节（src），时间轴用本小节（meta.len）
        const measureEl = staff.measures[entry.src];
        if (!measureEl) continue;
        const r = processMeasure(measureEl, staff.id, playbackTick, meta.len, staff.id === firstStaff.id);
        if (r.filled > 0 && Math.abs(r.filled - r.expected) > 2) {
          mismatch.push({ measure: entry.index + 1, staff: staff.id, expected: r.expected, actual: r.filled });
        }
      }
      playbackTick += meta.len;
    }
  }
  if (mismatch.length) {
    const head = mismatch.slice(0, 3).map((m) => `第${m.measure}小节/谱表${m.staff} ${m.actual}≠${m.expected}`).join('，');
    warnings.push(`${mismatch.length} 个小节的时值总和填不满（${head}${mismatch.length > 3 ? '…' : ''}）`);
  }

  // ---------- 5. 连音线合并 ----------
  notes.sort((a, b) => a.tick - b.tick || a.midi - b.midi);
  const merged = [];
  const openTie = new Map();
  for (const n of notes) {
    const key = `${n.staffId}|${n.voice}|${n.midi}`;
    const prev = openTie.get(key);
    if (prev && prev.tie && Math.abs(prev.tick + prev.dur - n.tick) <= 1) {
      prev.dur += n.dur;
      prev.tie = n.tie;
      continue;
    }
    openTie.set(key, n);
    merged.push(n);
  }

  tempos.sort((a, b) => a.tick - b.tick);
  const dedupTempos = [];
  for (const t of tempos) {
    const last = dedupTempos[dedupTempos.length - 1];
    if (last && last.tick === t.tick && Math.abs(last.bpm - t.bpm) < 0.01) continue;
    dedupTempos.push(t);
  }

  return {
    version,
    division,
    title: titleText,
    meta: extractMetaTags(score),
    parts,
    staves: staffSections.map((s) => {
      const info = staffToPart.get(s.id);
      return {
        id: s.id,
        partIndex: info ? info.part.index : -1,
        hand: handOf(info),
        notes: countByStaff.get(s.id) || 0,
      };
    }),
    measures,
    timeSignatures,
    keySignatures,
    noteValues: [...noteValues.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
    notes: merged,
    tempos: dedupTempos,
    warnings,
    stats: { notesBeforeTieMerge: notes.length, measures: order.length },
  };
}

/** 倚音（acciaccatura / grace8…16…32…64）：零时值，不占拍子 */
function isGraceChord(el) {
  return kids(el).some((k) => k.name === 'acciaccatura' || k.name === 'graceNoteType' || /^grace(8|16|32|64)$/.test(k.name));
}

/** 事件时值：durationType + 附点 + 三连音系数 */
function eventTicks(el, measureLen, division, tupletRef) {
  const dt = textOf(child(el, 'durationType'));
  if (!dt) return 0; // 装饰音等没有 durationType —— 不占时值
  let base = durationTicks(dt, division, measureLen);
  const dots = numOf(el, 'dots', 0);
  if (dots === 1) base *= 1.5;
  else if (dots === 2) base *= 1.75;
  else if (dots === 3) base *= 1.875;

  if (tupletRef && dt !== 'measure') {
    const active = tupletRef.counted ? tupletRef.left > 0 : true;
    if (active) {
      base = (base * tupletRef.normal) / tupletRef.actual;
      if (tupletRef.counted) tupletRef.left--;
    }
  }
  return Math.round(base);
}

/** 这个音是不是"连音线的起点"（后面还有一段） */
function isTieStart(noteEl) {
  return childrenOf(noteEl, 'Spanner').some((s) => attrOf(s, 'type', '') === 'Tie' && child(s, 'next'));
}

/** 标题：取 <Text><style>title</style><text>…</text></Text> */
function extractTitle(score) {
  const found = { text: '' };
  const walk = (node) => {
    for (const k of kids(node)) {
      if (k.name === 'Text') {
        const style = textOf(child(k, 'style'));
        if (style === 'title' || style === 'subtitle') {
          const t = textOf(child(k, 'text'));
          if (t && !found.text) found.text = t;
        }
      }
      walk(k);
    }
  };
  walk(score);
  return found.text;
}

/** <metaTag name="composer">…</metaTag> 这类元信息 */
function extractMetaTags(score) {
  const out = {};
  for (const tag of childrenOf(score, 'metaTag')) {
    const name = attrOf(tag, 'name', '');
    const value = textOf(tag);
    if (name && value) out[name] = value;
  }
  return out;
}