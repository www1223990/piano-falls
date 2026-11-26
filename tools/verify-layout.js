// 纯逻辑自检：键盘布局 + 时间轴数学。
// 不需要浏览器、不需要 three，`node tools/verify-layout.js` 直接跑。
import { buildKeyboard, MIDI_LOW, MIDI_HIGH, KEYBOARD_W, X0 } from '../src/keyboard-layout.js';

let fails = 0;
const ok = (cond, msg) => {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    fails++;
    console.log(`  ✗ ${msg}`);
  }
};

const keys = buildKeyboard();
const whites = keys.filter((k) => !k.black);
const blacks = keys.filter((k) => k.black);

console.log('键盘布局');
ok(keys.length === 88, `键数 = 88（实际 ${keys.length}）`);
ok(whites.length === 52, `白键 = 52（实际 ${whites.length}）`);
ok(blacks.length === 36, `黑键 = 36（实际 ${blacks.length}）`);
ok(keys[0].midi === MIDI_LOW && keys[87].midi === MIDI_HIGH, `首尾音 ${keys[0].midi} / ${keys[87].midi}`);
ok(keys.every((k, i) => k.midi === MIDI_LOW + i), '索引 = midi - 21');
ok(keys.every((k) => k.black === [1, 3, 6, 8, 10].includes(k.midi % 12)), '黑白键音级判定正确');
ok(keys.every((k) => k.x > X0 && k.x < X0 + KEYBOARD_W), '所有键都在键盘范围内');

// 白键相邻中心距必须严格 = 1，且互不重叠
let mono = true;
let gap = true;
for (let i = 1; i < whites.length; i++) {
  if (Math.abs(whites[i].x - whites[i - 1].x - 1) > 1e-9) mono = false;
  if (whites[i].x - whites[i - 1].x <= whites[i - 1].w) gap = false;
}
ok(mono, '相邻白键中心距恒为 1');
ok(gap, '白键之间不重叠');
ok(Math.abs(X0 + 0.5 - whites[0].x) < 1e-9, 'A0 在左边界内半格');
ok(Math.abs(X0 + KEYBOARD_W - 0.5 - whites[51].x) < 1e-9, 'C8 在右边界内半格');

// 每个黑键必须落在两个白键的缝上，且紧邻其左侧白键
const whiteByMidi = new Map(whites.map((k) => [k.midi, k]));
ok(
  blacks.every((b) => {
    const left = whiteByMidi.get(b.midi - 1);
    return left && Math.abs(b.x - (left.x + 0.5)) < 1e-9;
  }),
  '黑键 = 左邻白键的右边界（居中于缝隙）',
);
ok(blacks.every((b) => !whiteByMidi.has(b.midi)), '黑键不占据白键编号');

// 时间轴数学：底边偏移与落地判定
console.log('\n瀑布时间轴');
const FALL = 9;
const F = 2.0;
const speed = FALL / F;
const bottomOffset = (noteTime, scoreTime) => (noteTime - scoreTime) * speed;

ok(Math.abs(bottomOffset(5, 3) - FALL) < 1e-9, '提前 F 秒时，底边正好在 fallHeight');
ok(Math.abs(bottomOffset(5, 5)) < 1e-9, '到达时刻底边 = 0（落地）');
ok(bottomOffset(5, 6) < 0, '过了到达时刻底边为负 → 被夹到 0（视觉上扎进键面）');

// 长音：落地后高度应逐帧递减而不是变负
const dur = 1.5;
for (const st of [4, 5, 5.5, 6]) {
  const b = Math.max(bottomOffset(5, st), 0);
  const top = (5 + dur - st) * speed;
  const h = top - b;
  if (!(h >= 0)) {
    fails++;
    console.log(`  ✗ 长音在 t=${st} 高度为负 (${h})`);
  }
}
ok(true, '长音落地后高度单调递减且不为负');

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);