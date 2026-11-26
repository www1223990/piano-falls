// 用打桩的 three 驱动 waterfall.js，验证"音符条随时间下落"的坐标数学。
// 跑法：node --import ./tools/register.mjs tools/test-frames.mjs
import { createStage } from '../src/waterfall.js';
import { registry } from './three-stub.js';
import { KEY_H } from '../src/keyboard-layout.js';

let fails = 0;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { fails++; console.log(`  ✗ ${msg}`); }
};

const container = { clientWidth: 1600, clientHeight: 900, appendChild() {} };
const stage = createStage(container, { mode: '3d' }); // 先验 3D 的既有坐标，再单独验 2D
stage.fitCamera();

const keyMesh = registry.find((m) => m.capacity === 88);
const bars = registry.find((m) => m.capacity === 512);
const measureMesh = registry.find((m) => m.capacity === 48);
check(!!keyMesh && !!bars && !!measureMesh, '三个 InstancedMesh 已创建（88 键 / 512 条 / 48 小节线）');
check(keyMesh.instanceColor !== null, '琴键 instanceColor 显式创建（否则 setColorAt 会抛）');
check(measureMesh.visible === false, '小节线默认关闭');

const keyOf = (midi) => stage.getKey(midi);

const F = 2;
const FALL = 9;
const speed = FALL / F;

const bottomOf = (i) => bars.matrixRows[i].p[1] - bars.matrixRows[i].s[1] / 2;
const keyPressed = (midi) => {
  const i = stage.getKeyIndex(midi);
  return i >= 0 && keyMesh.matrixRows[i].p[1] < KEY_H * 0.5 - 1e-9;
};
const barIndexOf = (midi) => {
  const x = keyOf(midi).x;
  for (let i = 0; i < bars.count; i++) {
    if (near(bars.matrixRows[i].p[0], x, 1e-9)) return i;
  }
  return -1;
};
const colorOf = (i) => [
  bars.instanceColor.array[i * 3],
  bars.instanceColor.array[i * 3 + 1],
  bars.instanceColor.array[i * 3 + 2],
];

stage.setScore({ notes: [{ midi: 60, time: 5, dur: 1, soundDur: 1, vel: 0.9, hand: 0 }], measures: [] });

console.log('\n单音：t=5 触发，下落时长 2s');
stage.update(3.0, F);
check(bars.count === 1, '提前满 2 秒时已经可见（不多不少一帧就出现）');
check(near(bottomOf(0), KEY_H + FALL), `底边 = 键面 + fallHeight（${bottomOf(0).toFixed(3)} vs ${(KEY_H + FALL).toFixed(3)}）`);
check(near(bars.matrixRows[0].p[0], keyOf(60).x, 1e-9), '横向位置 = C4 键中心');

stage.update(4.0, F);
check(near(bottomOf(0), KEY_H + 4.5), `过半时底边 = 键面 + 4.5（${bottomOf(0).toFixed(3)}）`);
check(!keyPressed(60), '尚未落地 → 键未按下');

stage.update(5.0, F);
check(near(bottomOf(0), KEY_H), `落地瞬间底边正好压在键面（${bottomOf(0).toFixed(3)} vs ${KEY_H}）`);
check(keyPressed(60), '落地瞬间 C4 被按下');
check(near(bars.matrixRows[0].s[1], 1 * speed), `条高 = 时值 × 速度（${bars.matrixRows[0].s[1]}）`);

stage.update(5.5, F);
check(near(bottomOf(0), KEY_H), '落地后底边夹在键面（不再往下穿）');
check(near(bars.matrixRows[0].s[1], 0.5 * speed), '落地后条高随时值剩余量收缩');
check(keyPressed(60), '按住期间键保持按下');

stage.update(6.2, F);
check(bars.count === 0, '音结束后条消失');
check(!keyPressed(60), '松手后键回弹');

console.log('\n回退（暂停后重播 / 拖动 seek）');
stage.update(4.0, F);
check(bars.count === 1, '时间倒退后游标重置，音符重新出现');
check(near(bottomOf(0), KEY_H + 4.5), '倒退后位置依旧正确');

console.log('\n踏板延音不该拉长音符条');
stage.setScore({
  notes: [{ midi: 60, time: 5, dur: 0.5, soundDur: 3.0, vel: 0.9, hand: 0 }],
  measures: [],
});
stage.update(5.0, F);
check(near(bars.matrixRows[0].s[1], 0.5 * speed), `条高按"键按时长"而非发声时长（${bars.matrixRows[0].s[1]}）`);
stage.update(5.6, F);
check(bars.count === 0, '键松开就消失，哪怕声音还在响');

console.log('\n配色与力度');
stage.setScore({
  notes: [
    { midi: 60, time: 5, dur: 1, soundDur: 1, vel: 0.9, hand: 0 },
    { midi: 48, time: 5, dur: 1, soundDur: 1, vel: 0.7, hand: 1 },
    { midi: 64, time: 5, dur: 1, soundDur: 1, vel: 0.2, hand: 0 },
  ],
  measures: [],
});
stage.update(4.5, F);
check(bars.count === 3, '同刻三音 → 三条');
const rh = colorOf(barIndexOf(60));
const lh = colorOf(barIndexOf(48));
const rhSoft = colorOf(barIndexOf(64));
check(rh[2] > rh[0] && rh[2] > 0.8, '右手 = 蓝色系');
check(lh[0] > lh[2], '左手 = 橙色系');
check(rh[2] > rhSoft[2] + 0.1, `力度大的更亮（${rh[2].toFixed(2)} > ${rhSoft[2].toFixed(2)}）`);

console.log('\n小节线');
stage.setScore({
  notes: [{ midi: 60, time: 100, dur: 1, soundDur: 1, vel: 0.8, hand: 0 }],
  measures: [0, 2, 4, 6],
});
stage.setMeasureVisible(false);
stage.update(3.0, F);
check(measureMesh.count === 0 && measureMesh.visible === false, '关闭时完全不写实例');
stage.setMeasureVisible(true);
stage.update(3.0, F);
check(measureMesh.count === 1, `只画视野内的小节线（${measureMesh.count} 条：t=4 那条）`);
check(near(measureMesh.matrixRows[0].p[1] - measureMesh.matrixRows[0].s[1] / 2, KEY_H + 4.5), '小节线底边也在正确位置（与音符条同一基准）');
stage.update(6.5, F);
check(measureMesh.count === 0, '走过之后小节线消失');

console.log('\n容量与越界');
const many = [];
for (let i = 0; i < 2000; i++) many.push({ midi: 21 + (i % 88), time: 10, dur: 0.5, soundDur: 0.5, vel: 0.8, hand: i % 2 });
stage.setScore({ notes: many, measures: [] });
stage.update(9.5, F);
check(bars.count === 512, `同时可见数被 MAX_BARS 截断（${bars.count}）`);
check(bars.matrixRows.length <= 512, '不会写出实例数组之外');

console.log('\n2D 正交模式（音符沿屏幕竖直下落）');
stage.setMode('2d');
{
  const v = stage.getView();
  check(v.mode === '2d', '模式切到 2d');
  check(near(v.baseY, v.keyDepth), '2D：落点基准 = 键盘后沿（俯视键盘）');
  check(v.fallHeight > 5, `2D：瀑布区高度由窗口比例算出来（${v.fallHeight.toFixed(2)}）`);

  stage.setScore({ notes: [{ midi: 60, time: 5, dur: 1, soundDur: 1, vel: 0.9, hand: 0 }], measures: [], beats: [] });
  // setScore 会按音域重选键盘（宽度变了 → 视高也变），所以要重新读一次
  const v2 = stage.getView();
  const F2 = 2;
  const H2 = v2.fallHeight;
  const bottom2 = () => bars.matrixRows[0].p[1] - bars.matrixRows[0].s[1] / 2;

  stage.update(5 - F2, F2);
  check(near(bottom2(), v2.keyDepth + H2), '2D：刚好在下落时长前从顶部出现');

  stage.update(4.5, F2);
  const yMid = bars.matrixRows[0].p[1];

  stage.update(5, F2);
  check(near(bottom2(), v2.keyDepth), `2D：落地瞬间底边压在键盘后沿（${bottom2().toFixed(3)} vs ${v.keyDepth}）`);
  check(yMid > bars.matrixRows[0].p[1], '2D：时间推进 → 音符沿屏幕向下移动（y 减小）');

  // 键盘是"从上往下看"：白键纵向铺开 = 键盘深度，z 方向几乎为 0
  const wi = stage.getKeyIndex(60);
  check(near(keyMesh.matrixRows[wi].s[1], v2.keyDepth), '2D：白键纵向尺寸 = 键盘深度');
  check(near(keyMesh.matrixRows[wi].s[2], 0.02), '2D：白键是平的（z 厚度 0.02）');
  const blackKey = stage.getKey(61);
  check(
    near(keyMesh.matrixRows[stage.getKeyIndex(61)].s[1], v2.keyDepth * 0.58),
    '2D：黑键只占键盘后半段',
  );
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);