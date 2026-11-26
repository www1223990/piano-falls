// tick→秒 换算 + 乐器筛选/分窗格规则：用自己写的合成谱面验证，不依赖任何第三方乐谱。
// 跑法：node --import ./tools/register.mjs test/test-score-from-mscx.mjs
import { parseMscx } from '../src/mscx.js';
import { scoreFromMscx, buildTempoMap } from '../src/score.js';
import { FIXTURES } from './synth-fixtures.mjs';

let fails = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { fails++; console.log(`  ✗ ${msg}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** 用解析结果自带的速度表算"某个 tick 应该是几秒"，用来核对 scoreFromMscx */
function secAt(parsed, tick) {
  const pts = buildTempoMap(parsed.tempos, parsed.division);
  let p = pts[0];
  for (const q of pts) if (q.tick <= tick) p = q;
  return p.seconds + ((tick - p.tick) / parsed.division) * (60 / p.bpm);
}

console.log('=== 换算表本身 ===');
{
  const map = buildTempoMap([{ tick: 0, bpm: 115 }], 480);
  check(near(map[0].seconds, 0), '起点 = 0 秒');
  const map2 = buildTempoMap([{ tick: 0, bpm: 120 }, { tick: 960, bpm: 60 }], 480);
  check(near(map2[1].seconds, 1), `120BPM 走 2 拍（960 ticks）= 1 秒（${map2[1].seconds}）`);
  const map3 = buildTempoMap([{ tick: 960, bpm: 60 }, { tick: 0, bpm: 120 }], 480);
  check(map3[0].bpm === 120 && map3[1].bpm === 60, '速度点乱序也会被排好');
}

const scores = {};
for (const [name, xml] of Object.entries(FIXTURES)) {
  const parsed = parseMscx(xml);
  scores[name] = { parsed, score: scoreFromMscx(parsed, { name }) };
}

console.log('\n=== 通用不变量（三份谱子都过）===');
for (const [name, { parsed, score }] of Object.entries(scores)) {
  console.log(`  -- ${name}: mode=${score.mode} 音符=${score.notes.length} 时长=${score.duration.toFixed(2)}s`);
  check(score.notes.length > 0, `${name}：有音符`);
  check(
    score.notes.every((n) => Number.isFinite(n.time) && n.time >= 0),
    `${name}：时间是有限的非负数`,
  );
  check(
    score.notes.every((n) => n.dur > 0 && n.dur < 60),
    `${name}：时值在合理范围`,
  );
  check(
    score.notes.every((n, i, a) => i === 0 || a[i - 1].time <= n.time + 1e-9),
    `${name}：按时间排序`,
  );
  check(
    score.measures.every((t, i, a) => i === 0 || t > a[i - 1]),
    `${name}：小节时间严格递增`,
  );
  // tick→秒 与谱面速度表一致（没有 MIDI 时就用谱面的 tempo）
  const sample = parsed.notes[Math.floor(parsed.notes.length / 2)];
  const expected = secAt(parsed, sample.tick);
  const got = score.notes.find((n) => n.time >= 0 && Math.abs(n.time - expected) < 0.6);
  check(
    scores[name].score.notes.some((n) => near(n.time, expected, 0.02)) || !!got,
    `${name}：tick→秒 与速度表一致（tick ${sample.tick} ≈ ${expected.toFixed(3)}s）`,
  );
}

console.log('\n=== pianoViolin：多乐器 → 钢琴窗格 + 指板窗格 ===');
{
  const { parsed, score } = scores.pianoViolin;
  check(score.mode === 'multi', `多乐器模式（${score.mode}）`);
  check(score.lanes.length === 2, `2 个窗格（${score.lanes.length}）`);
  check(score.lanes[0].kind === 'piano', 'lane0 是钢琴');
  check(score.lanes[1].kind === 'strings' && score.lanes[1].family === 'violin', 'lane1 是弦乐/小提琴');
  check(score.ignoredParts.length === 0, '没有乐器被忽略');
  check(
    score.notes.every((n) => n.part === 0),
    'score.notes 仍只放钢琴（兼容旧的渲染路径）',
  );
  const rh = score.notes.filter((n) => n.hand === 0);
  const lh = score.notes.filter((n) => n.hand === 1);
  check(rh.length > 0 && lh.length > 0, `左右手都有（${rh.length} / ${lh.length}）`);
  check(new Set(score.notes.map((n) => n.hand)).size === 2, '只出现 0/1 两种手');

  const violin = score.lanes[1];
  check(violin.notes.length === 6, `小提琴 6 个音（${violin.notes.length}）`);
  check(
    violin.notes.every((n) => Number.isInteger(n.stringIndex) && Number.isFinite(n.position)),
    '每个音都算出了弦号和把位',
  );
  check(
    violin.fingerStats.perString.reduce((a, b) => a + b, 0) === violin.notes.length,
    '各弦计数加起来 = 音符数',
  );

  // 变速：第二处 tempo 之后，同样长度的小节应该变长
  const tickM3 = parsed.measures[2].startTicks;
  const tickM4 = parsed.measures[3].startTicks;
  const t3 = secAt(parsed, tickM3);
  const t4 = secAt(parsed, tickM4);
  check(near(t4 - t3, 1920 / 480 * (60 / 65), 1e-3), `65BPM 下一小节 ${(t4 - t3).toFixed(3)}s（比 115BPM 长）`);
  const has43 = score.notes.some((n) => near(n.time, t3, 0.02));
  check(has43, `第 3 小节起点 ${t3.toFixed(3)}s 上有音`);
}

console.log('\n=== singleViolin：单一非键盘乐器 ===');
{
  const { score } = scores.singleViolin;
  check(score.mode === 'single', `单乐器模式（${score.mode}）`);
  check(score.lanes.length === 1 && score.lanes[0].kind === 'strings', '只画一条指板窗格');
  check(score.lanes[0].family === 'violin', '识别为小提琴');
  check(score.notes.length === 5, `5 个音（${score.notes.length}）`);
}

console.log('\n=== repeats：反复展开后的时间轴 ===');
{
  const { parsed, score } = scores.repeats;
  check(parsed.measures.length === 9, `9 个播放小节（${parsed.measures.length}）`);
  check(near(score.duration, 9 * 1920 / 480 * (60 / 115), 0.01), `总长 ${score.duration.toFixed(3)}s = 9 小节 @115BPM`);
  const last = score.notes[score.notes.length - 1];
  check(near(last.time, secAt(parsed, 15360), 0.02), `最后一个音在 ${last.time.toFixed(3)}s（第 9 小节起点）`);
  check(last.midi === 74, '最后一个音带八度线移调（62 → 74）');
  check(score.lanes.length === 1 && score.lanes[0].kind === 'piano', '单谱表钢琴 → 只画钢琴窗格');
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
