// .mscx 解析器：用**自己写的合成谱面**（test/synth-fixtures.mjs）跑，不依赖任何第三方乐谱。
// 跑法：node test/test-mscx.mjs
import { parseMscx, isKeyboardInstrument } from '../src/mscx.js';
import { FIXTURES } from './synth-fixtures.mjs';

let fails = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { fails++; console.log(`  ✗ ${msg}`); }
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const pianoViolin = parseMscx(FIXTURES.pianoViolin);
const repeats = parseMscx(FIXTURES.repeats);
const singleViolin = parseMscx(FIXTURES.singleViolin);

// ---------- 通用不变量 ----------
for (const [name, score] of Object.entries({ pianoViolin, repeats, singleViolin })) {
  console.log(`\n=== ${name} ===`);
  console.log(
    `  division=${score.division} parts=${score.parts.length} staves=${score.staves.length} 小节=${score.measures.length} 音=${score.notes.length}`,
  );
  check(score.warnings.length === 0, `没有解析警告${score.warnings.length ? '：' + score.warnings.join('；') : ''}`);
  check(score.notes.length > 0 && score.measures.length > 0, '解析出音符和小节');
  check(score.notes.every((n) => n.midi >= 0 && n.midi <= 127), '音高都在 0..127');
  check(score.notes.every((n) => n.dur >= 0), '时值非负');
  check(score.notes.every((n) => n.vel >= 1 && n.vel <= 127), '力度在 1..127');
  const last = score.measures[score.measures.length - 1];
  check(
    score.notes.every((n) => n.tick + n.dur <= last.startTicks + last.lenTicks + 2),
    '没有音符跑出曲末',
  );
}

// ---------- 多乐器 / 左右手 / 记谱细节 ----------
console.log('\n=== pianoViolin：双谱表钢琴 + 小提琴 ===');
{
  const s = pianoViolin;
  check(s.parts.length === 2, `2 个 Part（${s.parts.length}）`);
  check(s.parts[0].instrumentId === 'keyboard.piano' && s.parts[0].keyboard, 'Part1 是钢琴（键盘）');
  check(s.parts[0].staffIds.join(',') === '1,2', `钢琴占谱表 1,2（${s.parts[0].staffIds}）`);
  check(s.parts[1].instrumentId === 'strings.violin' && !s.parts[1].keyboard, 'Part2 是小提琴（非键盘）');

  check(s.staves[0].hand === 0 && s.staves[1].hand === 1, '钢琴两条谱表 = 右/左手');
  check(s.staves[2].hand === null, '单谱表小提琴不硬猜左右手');

  // 弱起小节：属性写法 len="1/4"，480 ticks
  check(s.measures[0].lenTicks === 480, `弱起小节长度 480 ticks（${s.measures[0].lenTicks}）`);
  check(s.measures[1].startTicks === 480, '第二小节从 480 开始（弱起不吃掉一拍）');

  // 倚音：零时值 + grace 标记
  const grace = s.notes.find((n) => n.grace);
  check(!!grace && grace.dur === 0, `倚音零时值（${grace && grace.dur}）`);
  check(grace && grace.midi === 74, '倚音音高来自它自己的 <pitch>');

  // 连音线：两个 480 的四分音符合成 960
  const tied = s.notes.find((n) => n.tick === 0 && n.midi === 72);
  check(tied && tied.dur === 960, `连音线合并后长 960（${tied && tied.dur}）`);
  check(s.notes.length < s.stats.notesBeforeTieMerge, `连音线确实合并了（${s.stats.notesBeforeTieMerge} → ${s.notes.length}）`);

  // 三连音：16 分 5:4 → 96 ticks，5 个音加起来正好一拍
  const tuplet = s.notes.filter((n) => n.dur === 96);
  check(tuplet.length === 5, `三连音 5 个音（${tuplet.length}）`);
  check(tuplet.every((n) => n.tick >= 960) && tuplet[4].tick - tuplet[0].tick === 384, '三连音 5 个音均匀排在一拍内');

  // tempo：<tempo>1.916667</tempo> = 115 BPM；第二处 1.083333 = 65 BPM
  check(s.tempos.length === 2, `读到 2 个变速点（${s.tempos.length}）`);
  check(near(s.tempos[0].bpm, 115, 0.5), `tempo 1.916667 → ${s.tempos[0].bpm.toFixed(2)} BPM ≈ 115`);
  check(near(s.tempos[1].bpm, 65, 0.5), `tempo 1.083333 → ${s.tempos[1].bpm.toFixed(2)} BPM ≈ 65`);

  // 左右手音域
  const avg = (a) => a.reduce((x, n) => x + n.midi, 0) / a.length;
  const rh = s.notes.filter((n) => n.hand === 0);
  const lh = s.notes.filter((n) => n.hand === 1);
  check(rh.length > 0 && lh.length > 0, `左右手都有音（${rh.length} / ${lh.length}）`);
  check(avg(rh) > avg(lh), `右手平均音高 ${avg(rh).toFixed(1)} > 左手 ${avg(lh).toFixed(1)}`);
}

// ---------- 反复 / 结尾 / % / 颤音 / 八度线 ----------
console.log('\n=== repeats：反复结构 ===');
{
  const s = repeats;
  const order = s.measures.map((m) => m.index).join(',');
  check(s.measures.length === 9, `展开成 9 个小节（${s.measures.length}）`);
  check(order === '0,1,2,3,1,4,5,6,7', `播放顺序 ${order}`);
  const ticks74 = s.notes.filter((n) => n.midi === 74).map((n) => n.tick).sort((a, b) => a - b);
  check(ticks74.join(',') === '1920,7680,15360', `m2 弹了两遍（74 在 ${ticks74.join('/')}；最后那个是八度移调后的）`);
  check(s.notes.filter((n) => n.midi === 76).length === 1, '1. 结尾只在第一遍弹（76 只 1 次）');
  check(s.notes.filter((n) => n.midi === 79).length === 2, '"%" 小节借用了上一小节（79 出现 2 次）');

  // 两音颤音：两个半音符在整小节内按 c16（十六分）交替
  const trem = s.notes.filter((n) => n.midi === 60 || n.midi === 67);
  check(trem.length === 16, `两音颤音铺成 16 个交替音（${trem.length}）`);
  check(trem.every((n) => n.dur === 120), '每个交替音是十六分（120 ticks）');
  const byTick = new Map(trem.map((n) => [n.tick, n.midi]));
  const seq = [];
  for (let t = 13440; t < 13440 + 16 * 120; t += 120) seq.push(byTick.get(t));
  check(
    seq.join(',') === '60,67,60,67,60,67,60,67,60,67,60,67,60,67,60,67',
    `A/B 交替铺满整小节（${seq.slice(0, 6).join(',')}…）`,
  );
  check(trem.filter((n) => n.midi === 60).length === 8, '每组各出现 8 次');

  const oct = s.notes.filter((n) => n.midi === 74 && n.tick === 15360);
  check(oct.length === 1, '八度线上的音被移调（谱面写的 62 → 74）');
}

console.log('\n=== singleViolin：单一非键盘乐器 ===');
{
  const s = singleViolin;
  check(s.parts.length === 1, '1 个 Part');
  check(s.parts[0].instrumentId === 'strings.violin', '是小提琴');
  check(s.parts[0].keyboard === false, '不算键盘乐器');
  check(s.notes.length === 5, `5 个音符（${s.notes.length}）`);
}

// ---------- 乐器判定 ----------
console.log('\n=== 乐器判定 ===');
check(isKeyboardInstrument('keyboard.piano'), 'keyboard.piano → 键盘');
check(isKeyboardInstrument('keyboard.electric-piano'), 'keyboard.electric-piano → 键盘');
check(isKeyboardInstrument('keyboard.harpsichord'), 'keyboard.harpsichord → 键盘');
check(isKeyboardInstrument('piano'), '旧版 piano → 键盘');
check(!isKeyboardInstrument('strings.violin'), 'strings.violin → 不是');
check(isKeyboardInstrument('keyboard.harpsichord.extra'), 'keyboard. 前缀一律算');
check(!isKeyboardInstrument(''), '空 id → 不是');

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
