// 弓弦乐器：定弦表 + 指位换算 + 换弦检测
// 跑法：node test/test-instruments.mjs
import {
  STRING_FAMILIES,
  stringFamilyOf,
  assignString,
  stringRange,
  fingeringFor,
  stringCrossings,
  pitchName,
  MAX_POSITION,
} from '../src/instruments.js';

let fails = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { fails++; console.log(`  ✗ ${msg}`); }
};

const V = STRING_FAMILIES.violin;
const C = STRING_FAMILIES.cello;
const VA = STRING_FAMILIES.viola;

console.log('乐器识别');
check(stringFamilyOf('strings.violin') === V, 'strings.violin → 小提琴');
check(stringFamilyOf('violin') === V, '旧版 violin → 小提琴');
check(stringFamilyOf('strings.viola') === VA, 'strings.viola → 中提琴');
check(stringFamilyOf('strings.cello') === C, 'strings.cello → 大提琴');
check(stringFamilyOf('strings.contrabass')?.key === 'contrabass', '低音提琴也能识别');
check(stringFamilyOf('Violin') === V, '大小写不敏感');
check(stringFamilyOf('strings.violin.solo')?.key === 'violin', '带后缀（.solo）也能认');
check(stringFamilyOf('keyboard.piano') === null, '钢琴不是弓弦乐器');
check(stringFamilyOf('') === null, '空字符串 → null');
check(stringFamilyOf('flute') === null, '长笛 → null');

console.log('\n指位规则（每根弦负责到下一根空弦的上一个音）');
{
  const cases = [
    [55, 0, 0, 'G 空弦'],
    [61, 0, 6, 'C#4 仍在 G 弦（D4 才换弦）'],
    [62, 1, 0, 'D 空弦'],
    [67, 1, 5, 'G4 在 D 弦第 5 半音（不是 G 弦第 12）'],
    [68, 1, 6, 'G#4 仍在 D 弦'],
    [69, 2, 0, 'A 空弦'],
    [75, 2, 6, 'D#5 仍在 A 弦'],
    [76, 3, 0, 'E 空弦'],
    [90, 3, 14, 'F#6 在 E 弦第 14 半音'],
  ];
  for (const [midi, idx, pos, why] of cases) {
    const r = assignString(V, midi);
    check(r.stringIndex === idx && r.position === pos, `${midi} → 弦${idx} 位置${pos}（${why}）`);
  }
}

console.log('\n边界');
{
  const open = assignString(V, 50);
  check(open.below && open.stringIndex === 0, '低于最低空弦（D3 < G3）→ 标记 below');
  const a3 = assignString(V, 57);
  check(!a3.below && a3.stringIndex === 0 && a3.position === 2, 'A3 是能拉的：G 弦第 2 半音');
  const high = assignString(V, 76 + MAX_POSITION + 3);
  check(high.tooHigh, '超过指板跨度 → 标记 tooHigh');
  const e = assignString(V, 76);
  check(e.open && !e.below, '空弦不算 below');
  check(assignString(C, 36).position === 0, '大提最低 C2 = 空弦');
  check(assignString(VA, 48).position === 0, '中提最低 C3 = 空弦');
}

console.log('\n弦的音域区间');
{
  const r0 = stringRange(V, 0);
  check(r0.from === 55 && r0.to === 61, `小提琴 G 弦 55~61（${r0.from}~${r0.to}）`);
  const r3 = stringRange(V, 3);
  check(r3.from === 76 && r3.to === 76 + MAX_POSITION, `E 弦往上到 76+${MAX_POSITION}`);
}

console.log('\n整条声部的指法统计');
{
  const notes = [
    { midi: 55, time: 0, dur: 0.5 },
    { midi: 62, time: 0.5, dur: 0.5 },
    { midi: 69, time: 1.0, dur: 0.5 },
    { midi: 76, time: 1.5, dur: 0.5 },
    { midi: 67, time: 2.0, dur: 0.5 },
  ];
  const { notes: out, stats } = fingeringFor(V, notes);
  check(out.length === 5, '音符数不变');
  check(out.every((n) => typeof n.stringIndex === 'number'), '每个音都有弦号');
  check(stats.perString.join(',') === '1,2,1,1', `各弦计数 ${stats.perString.join(',')}（G1 D2 A1 E1）`);
  check(stats.maxPosition === 5, `最大把位 ${stats.maxPosition}`);
  check(stats.below === 0 && stats.tooHigh === 0, '没有越界');
}

console.log('\n换弦弧线（连奏时换弦才算）');
{
  const notes = [
    { midi: 62, stringIndex: 1, time: 0, dur: 0.5 },   // D 弦
    { midi: 69, stringIndex: 2, time: 0.45, dur: 0.5 }, // 0.45 < 0.5 → 与上一个音重叠，算连奏换弦
    { midi: 74, stringIndex: 2, time: 1.2, dur: 0.3 },  // 同弦，不算
    { midi: 76, stringIndex: 3, time: 1.9, dur: 0.3 },  // 距上个音结束 0.4s，太远，不算
  ];
  const crossings = stringCrossings(notes);
  check(crossings.length === 1, `检测到 ${crossings.length} 处换弦（应为 1）`);
  check(crossings[0]?.from.midi === 62 && crossings[0]?.to.midi === 69, '弧线连在 D→A 那对音上');
}

console.log('\n音名');
{
  check(pitchName(60) === 'C4', `60 → ${pitchName(60)}`);
  check(pitchName(69) === 'A4', `69 → ${pitchName(69)}`);
  check(pitchName(76) === 'E5', `76 → ${pitchName(76)}`);
  check(pitchName(61) === 'C#4', `61 → ${pitchName(61)}`);
  check(pitchName(21) === 'A0', `21 → ${pitchName(21)}`);
  check(pitchName(108) === 'C8', `108 → ${pitchName(108)}`);
  check(pitchName(55) === 'G3', `55 → ${pitchName(55)}`);
  // 梯子的每一格 = 空弦 + 指位。注意"下一根空弦的那个音"按规则归下一根弦，
  // 所以每根弦只独占 [空弦, 下一根空弦) 这一段。
  for (const family of [STRING_FAMILIES.violin, STRING_FAMILIES.cello]) {
    for (let i = 0; i < family.strings.length; i++) {
      const open = family.strings[i].open;
      const next = family.strings[i + 1];
      const span = next ? next.open - open : 6;
      let ok = true;
      for (let p = 0; p < span; p++) {
        const r = assignString(family, open + p);
        if (r.stringIndex !== i || r.position !== p) ok = false;
      }
      check(ok, `${family.name} 弦${i}：指位 0~${span - 1} 都在本弦上`);
      if (next) {
        const edge = assignString(family, next.open);
        check(
          edge.stringIndex === i + 1 && edge.position === 0 && edge.open,
          `${family.name} ${pitchName(next.open)} 是弦${i + 1}的空弦（弦${i}到此为止）`,
        );
      }
    }
  }
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);