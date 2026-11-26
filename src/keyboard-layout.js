// 键盘几何：音高 → 世界坐标。单位是「一个白键宽 = 1」。
//
// 两个视图共用：钢琴用 49/61/76/88 键的标准音域，
// 小提琴用「这段把位」的紧凑音域（四根弦各一段，带黑键）。

export const MIDI_LOW = 21;   // A0
export const MIDI_HIGH = 108; // C8

export const WHITE_W = 1;
export const WHITE_DEPTH = 6;
export const BLACK_W = 0.62;
export const BLACK_DEPTH = 3.9;
export const KEY_H = 0.5;

export const TOTAL_WHITE = 52;
export const KEYBOARD_W = TOTAL_WHITE * WHITE_W; // 88 键时 = 52
export const X0 = -KEYBOARD_W / 2;

export const BLACK_PCS = new Set([1, 3, 6, 8, 10]); // C# D# F# G# A#

/** 标准键盘规格：键数 → 音域（覆盖乐谱音域就选最小的那个） */
export const KEYBOARD_SPANS = [
  { keys: 49, low: 36, high: 84, label: 'C2–C6' },
  { keys: 61, low: 36, high: 96, label: 'C2–C7' },
  { keys: 76, low: 28, high: 103, label: 'E1–G7' },
  { keys: 88, low: 21, high: 108, label: 'A0–C8' },
];

/**
 * 按乐谱实际音域挑键盘：能覆盖就用最小的，覆盖不了用 88。
 * @returns {{keys:number, low:number, high:number, label:string, fitted:boolean}}
 */
export function pickKeyboardSpan(minMidi, maxMidi) {
  for (const span of KEYBOARD_SPANS) {
    if (minMidi >= span.low && maxMidi <= span.high) return { ...span, fitted: true };
  }
  const last = KEYBOARD_SPANS[KEYBOARD_SPANS.length - 1];
  return { ...last, fitted: false };
}

/**
 * 生成任意音域的键盘（带黑键）。
 * @param {number} low 最低音（含）
 * @param {number} high 最高音（含）
 * @param {{whiteW?:number, originX?:number}} opts originX = 左边界，默认以 0 为中心
 * @returns {{keys:Array, totalWhite:number, width:number, x0:number, low:number, high:number}}
 */
export function buildKeyboardRange(low, high, opts = {}) {
  const whiteW = opts.whiteW ?? WHITE_W;
  const from = Math.max(0, Math.min(low, high));
  const to = Math.max(from, high);

  // 第一遍：白键编号（从 0 开始），黑键靠左邻白键定位
  const whiteIndexOf = new Map();
  let n = 0;
  for (let m = from; m <= to; m++) {
    if (!BLACK_PCS.has(((m % 12) + 12) % 12)) whiteIndexOf.set(m, n++);
  }
  const totalWhite = Math.max(1, n);
  const width = totalWhite * whiteW;
  const x0 = opts.originX ?? -width / 2;

  const keys = [];
  for (let m = from; m <= to; m++) {
    const pc = ((m % 12) + 12) % 12;
    if (BLACK_PCS.has(pc)) {
      const leftWhite = whiteIndexOf.get(m - 1);
      // 起点本身是黑键时，左邻白键不在范围内 —— 贴着左边界放
      const anchor = leftWhite === undefined ? -0.5 : leftWhite + 0.5;
      keys.push({
        midi: m,
        black: true,
        x: x0 + (anchor + 0.5) * whiteW,
        z: -WHITE_DEPTH / 2 + BLACK_DEPTH / 2,
        w: BLACK_W * whiteW,
        d: BLACK_DEPTH,
        h: KEY_H * 1.42,
      });
    } else {
      const wi = whiteIndexOf.get(m) ?? 0;
      keys.push({
        midi: m,
        black: false,
        x: x0 + (wi + 0.5) * whiteW,
        z: 0,
        w: whiteW * 0.985,
        d: WHITE_DEPTH,
        h: KEY_H,
      });
    }
  }
  return { keys, totalWhite, width, x0, low: from, high: to };
}

/**
 * 返回按 midi 升序排列的 88 个键（索引 = midi - MIDI_LOW）。
 * @returns {{midi:number, black:boolean, x:number, z:number, w:number, d:number, h:number}[]}
 */
export function buildKeyboard() {
  return buildKeyboardRange(MIDI_LOW, MIDI_HIGH).keys;
}

/** 白键序列（用来画 C1..C8 标签） */
export function whiteKeysOf(keys) {
  return keys.filter((k) => !k.black);
}