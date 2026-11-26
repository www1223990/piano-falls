// 音符归一化 / 踏板延音 / 小节网格
// 跑法：node --import ./tools/register.mjs tools/test-score.mjs
import { normalizeMidi, demoScore, noteName, measureTimes } from '../src/score.js';

let fails = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { fails++; console.log(`  ✗ ${msg}`); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- 假 @tonejs/midi 数据（形状与真库一致：note 带 ticks/durationTicks，track 带 controlChanges）
const PPQ = 480;
const SEC_PER_TICK = 60 / 120 / PPQ; // 120 BPM → 1 tick = 1/960 s

function makeHeader({ bpm = 120, sigs = [[0, [4, 4]]] } = {}) {
  const perTick = 60 / bpm / PPQ;
  return {
    ppq: PPQ,
    tempos: [{ ticks: 0, bpm, time: 0 }],
    timeSignatures: sigs.map(([ticks, timeSignature]) => ({ ticks, timeSignature })),
    ticksToSeconds: (t) => t * perTick,
  };
}
const ticksOf = (sec) => Math.round(sec / SEC_PER_TICK);
const n = (midi, time, duration, velocity = 0.8) => ({
  midi,
  time,
  duration,
  velocity,
  ticks: ticksOf(time),
  durationTicks: ticksOf(duration),
});
const track = (notes, cc64) => ({ notes, controlChanges: cc64 ? { 64: cc64 } : {} });
const midiOf = (tracks, header = makeHeader(), name = 'x') => ({ name, tracks, header });

console.log('按轨道分左右手（MuseScore 钢琴常见：两声部两条轨道）');
const two = normalizeMidi(midiOf([
  track([n(72, 1.0, 0.5, 0.9), n(60, 0.5, 1.0, 0.6)]), // 故意乱序
  track([n(48, 0.0, 2.0, 0.7)]),
]));
check(two.notes.length === 3, '音符数 3');
check(two.notes[0].midi === 48, '按 time 升序排好（最早的是左手 48）');
check(near(two.notes[0].time, 0), '音符时间保持曲内绝对时间（不再烘 leadIn）');
check(two.notes.find((x) => x.midi === 48).hand === 1, '第二条轨道 = 左手');
check(two.notes.find((x) => x.midi === 72).hand === 0, '第一条轨道 = 右手');
check(near(two.duration, 2.0), `总时长 = max(time+dur)（${two.duration}）`);

console.log('\n单轨混排（左右手挤在一起）→ 按音高猜');
const one = normalizeMidi(midiOf([track([n(72, 0, 1), n(48, 0, 1)])]));
check(one.notes.find((x) => x.midi === 72).hand === 0, 'midi ≥ 60 视为右手');
check(one.notes.find((x) => x.midi === 48).hand === 1, 'midi < 60 视为左手');

console.log('\nCC64 踏板延音（声音比键长，视觉不该跟着变长）');
const noPedal = normalizeMidi(midiOf([track([n(60, 1, 0.5)])]));
check(noPedal.notes[0].soundDur === noPedal.notes[0].dur, '无踏板事件 → soundDur = dur');

const pedal = { 64: [
  { time: 0, value: 1, ticks: 0 },
  { time: 3, value: 0, ticks: ticksOf(3) },
] };
const held = normalizeMidi(midiOf([track([n(60, 1, 0.5)], pedal[64])]));
check(near(held.notes[0].dur, 0.5), `键按时长不变（${held.notes[0].dur}）`);
check(near(held.notes[0].soundDur, 2.0), `发声延到踏板抬起（${held.notes[0].soundDur}）`);

const afterDown = normalizeMidi(midiOf([track([n(60, 1, 0.5)], [
  { time: 2, value: 1, ticks: ticksOf(2) },
  { time: 5, value: 0, ticks: ticksOf(5) },
])]));
check(afterDown.notes[0].soundDur === afterDown.notes[0].dur, '踏板在音之后才踩下 → 不影响');

const upEarly = normalizeMidi(midiOf([track([n(60, 1, 0.5)], [
  { time: 0, value: 1, ticks: 0 },
  { time: 1.2, value: 0, ticks: ticksOf(1.2) },
])]));
check(upEarly.notes[0].soundDur === upEarly.notes[0].dur, '踏板早于自然结束抬起 → 取自然结束');

const alwaysOn = normalizeMidi(midiOf([track([n(60, 1, 0.5)], [{ time: 0, value: 1, ticks: 0 }])]));
check(alwaysOn.notes[0].soundDur === 8, `一直踩着 → 被 MAX_SUSTAIN 截断（${alwaysOn.notes[0].soundDur}）`);

console.log('\n小节网格（由 timeSignature + 拍号推，不依赖排版）');
const m44 = measureTimes({ header: makeHeader(), tracks: [{ notes: [{ ticks: 0, durationTicks: ticksOf(8) }] }] });
check(m44.length >= 4, `4/4 @120BPM 8 秒 → 至少 4 小节（${m44.length}）`);
check(near(m44[0], 0) && near(m44[1], 2) && near(m44[2], 4), '小节间隔 = 2 秒');
const m34 = measureTimes({ header: makeHeader({ sigs: [[0, [3, 4]]] }), tracks: [{ notes: [{ ticks: 0, durationTicks: ticksOf(9) }] }] });
check(near(m34[1] - m34[0], 1.5), `3/4 @120BPM 每小节 1.5 秒（${(m34[1] - m34[0]).toFixed(3)}）`);
const mixed = measureTimes({
  header: makeHeader({ sigs: [[0, [4, 4]], [ticksOf(4), [3, 4]]] }),
  tracks: [{ notes: [{ ticks: 0, durationTicks: ticksOf(10) }] }],
});
check(near(mixed[0], 0) && near(mixed[1], 2) && near(mixed[2], 4), '拍号中途变化：4/4 两小节后切 3/4');
check(near(mixed[3] - mixed[2], 1.5), '切到 3/4 后每小节 1.5 秒');
const empty = measureTimes({ header: makeHeader(), tracks: [{ notes: [] }] });
check(empty.length > 0, '没有音符也不返回空数组');
check(two.measures.length > 0, 'normalizeMidi 会把小节网格带出来');

console.log('\n脏数据兜底');
const dirty = normalizeMidi(midiOf([
  track([n(60, 0, 0, 0), n(61, 0, 1, 5), { midi: 62, time: 0, duration: 1, ticks: 0, durationTicks: 480 }]),
  track([{ midi: 63, time: 0, duration: 1 }]),
]));
check(dirty.notes.every((x) => x.dur >= 0.05), `过短时值被抬到 0.05（${dirty.notes.map((x) => x.dur).join(',')}）`);
check(dirty.notes.find((x) => x.midi === 61).vel === 1, 'velocity > 1 被夹到 1');
check(dirty.notes.find((x) => x.midi === 62).vel === 0.8, '缺 velocity 默认 0.8');

console.log('\n音名换算（Sampler 触发用）');
check(noteName(21) === 'A0', 'A0');
check(noteName(60) === 'C4', 'C4');
check(noteName(69) === 'A4', 'A4');
check(noteName(108) === 'C8', 'C8');
check(noteName(61) === 'C#4', 'C#4');

console.log('\n内置示例乐谱');
const demo = demoScore();
check(demo.notes.length > 0, `有音符（${demo.notes.length}）`);
check(demo.notes[0].time === 0, '第一个音符从 0 开始（预备段由 transport 偏移负责）');
check(demo.notes.every((x, i, a) => i === 0 || a[i - 1].time <= x.time), '已按时间排序');
check(demo.notes.some((x) => x.hand === 0) && demo.notes.some((x) => x.hand === 1), '示例左右手都有');
check(demo.measures.length >= 4, `带小节网格（${demo.measures.length}）`);
check(demo.duration > 8, `示例时长 ${demo.duration.toFixed(2)}s`);

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);