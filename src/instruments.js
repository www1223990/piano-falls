// 弓弦乐器模型：定弦 + 指位换算。
//
// 谱面里通常没有弦号/指法标记（你三首谱子都是 0 个），所以"这个音在哪根弦"要推。
// 规则（按你给的说法）：每根弦负责"从自己空弦到下一根弦空弦前一个音"，
// 等价于「取空弦音高不高于该音的最高那根弦」。
// 例：G4(67) 归 D 弦第 5 个半音，而不是 G 弦第 12 个。

export const STRING_FAMILIES = {
  violin: {
    key: 'violin',
    name: '小提琴',
    short: 'Vln',
    ids: ['strings.violin', 'violin'],
    // 低 → 高
    strings: [
      { name: 'G', open: 55 },
      { name: 'D', open: 62 },
      { name: 'A', open: 69 },
      { name: 'E', open: 76 },
    ],
  },
  viola: {
    key: 'viola',
    name: '中提琴',
    short: 'Vla',
    ids: ['strings.viola', 'viola'],
    strings: [
      { name: 'C', open: 48 },
      { name: 'G', open: 55 },
      { name: 'D', open: 62 },
      { name: 'A', open: 69 },
    ],
  },
  cello: {
    key: 'cello',
    name: '大提琴',
    short: 'Vc',
    ids: ['strings.cello', 'cello', 'violoncello'],
    strings: [
      { name: 'C', open: 36 },
      { name: 'G', open: 43 },
      { name: 'D', open: 50 },
      { name: 'A', open: 57 },
    ],
  },
  contrabass: {
    key: 'contrabass',
    name: '低音提琴',
    short: 'Cb',
    ids: ['strings.contrabass', 'contrabass', 'double-bass', 'doublebass'],
    strings: [
      { name: 'E', open: 28 },
      { name: 'A', open: 33 },
      { name: 'D', open: 38 },
      { name: 'G', open: 43 },
    ],
  },
};

/** 指板显示的最大跨度（半音）。超过这个就标记为"超高把位"，仍照常分配 */
export const MAX_POSITION = 24;

const ID_INDEX = new Map();
for (const family of Object.values(STRING_FAMILIES)) {
  for (const id of family.ids) ID_INDEX.set(id, family);
}

/** 乐器 id → 弓弦家族（不是弓弦返回 null） */
export function stringFamilyOf(instrumentId) {
  const id = String(instrumentId || '').toLowerCase().trim();
  if (!id) return null;
  if (ID_INDEX.has(id)) return ID_INDEX.get(id);
  // 兜底：strings.violin.solo 这类带后缀的
  for (const family of Object.values(STRING_FAMILIES)) {
    if (family.ids.some((candidate) => id.startsWith(candidate))) return family;
  }
  return null;
}

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI 音高 → 音名（C4 = 60） */
export function pitchName(midi) {
  const m = Math.round(midi);
  return `${PITCH_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

/**
 * 音高 → 弦与指位。
 * @param {object} family STRING_FAMILIES.*
 * @param {number} midi
 * @returns {{stringIndex:number, stringName:string, position:number, open:boolean, below:boolean, tooHigh:boolean}}
 */
export function assignString(family, midi) {
  const strings = family.strings;
  let index = 0;
  for (let i = 0; i < strings.length; i++) {
    if (strings[i].open <= midi) index = i;
  }
  const target = strings[index];
  const position = midi - target.open;
  return {
    stringIndex: index,
    stringName: target.name,
    position,
    open: position === 0,
    below: midi < strings[0].open, // 比最低空弦还低，实际拉不出来
    tooHigh: position > MAX_POSITION,
  };
}

/** 一根弦覆盖的音高范围（含），用来画刻度 */
export function stringRange(family, index) {
  const strings = family.strings;
  const from = strings[index].open;
  const to = index + 1 < strings.length ? strings[index + 1].open - 1 : from + MAX_POSITION;
  return { from, to: Math.min(to, from + MAX_POSITION) };
}

/**
 * 把一条声部的音符加上指位信息。
 * @param {Array} notes 归一化音符（有 midi）
 * @returns {{notes: Array, stats: object}}
 */
export function fingeringFor(family, notes) {
  const out = [];
  let below = 0;
  let tooHigh = 0;
  const perString = family.strings.map(() => 0);

  for (const n of notes) {
    const f = assignString(family, n.midi);
    if (f.below) below++;
    if (f.tooHigh) tooHigh++;
    perString[f.stringIndex]++;
    out.push({ ...n, stringIndex: f.stringIndex, position: f.position, open: f.open, below: f.below, tooHigh: f.tooHigh });
  }

  return {
    notes: out,
    stats: {
      notes: out.length,
      perString,
      below,
      tooHigh,
      maxPosition: out.reduce((m, n) => Math.max(m, n.position), 0),
    },
  };
}

/**
 * 找"换弦点"：相邻两个音在很短时间内换了弦 → 值得画一条弧线。
 * @param {Array} notes 已带 stringIndex 的音符（按时间排序）
 * @param {{maxGap?: number}} opts maxGap 秒；超过就不算连奏
 */
export function stringCrossings(notes, { maxGap = 0.12 } = {}) {
  const out = [];
  for (let i = 1; i < notes.length; i++) {
    const a = notes[i - 1];
    const b = notes[i];
    if (a.stringIndex === b.stringIndex) continue;
    const gap = b.time - (a.time + a.dur);
    if (gap > maxGap) continue;
    out.push({ from: a, to: b, gap });
  }
  return out;
}