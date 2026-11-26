// 八度线（8va/8vb）的回归测试：区间按 **tick** 算，不是按整小节算。
//
// 事实（用 MuseScore 自己验出来的）：
//   - 谱面 <pitch> 是"写出来的音高"，实际发声要按八度线移调
//   - <next><location><measures>N</measures> 是"从线条起点往后 N 个小节"，
//     起点常在小节中间 → 用整小节算会少盖最后一小节（Cancan 的 m8 就画低了一个八度）
//   - <play>0</play> 的八度线只显示不移调
import { parseMscx } from '../src/mscx.js';

let fails = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { fails++; console.log(`  ✗ ${msg}`); }
};

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<museScore version="4.70">
  <Score>
    <Division>480</Division>
    <Part id="1">
      <Staff id="1"/>
      <trackName>P</trackName>
      <Instrument id="piano"><instrumentId>keyboard.piano</instrumentId></Instrument>
    </Part>
    <Staff id="1">
      <Measure>
        <voice>
          <TimeSig><sigN>4</sigN><sigD>4</sigD></TimeSig>
          <Rest><durationType>half</durationType></Rest>
          <Spanner type="Ottava">
            <Ottava><subtype>8va</subtype></Ottava>
            <next><location><measures>1</measures></location></next>
          </Spanner>
          <Chord><durationType>half</durationType><Note><pitch>60</pitch></Note></Chord>
        </voice>
      </Measure>
      <Measure>
        <voice><Chord><durationType>whole</durationType><Note><pitch>60</pitch></Note></Chord></voice>
      </Measure>
      <Measure>
        <voice>
          <Spanner type="Ottava">
            <Ottava><subtype>8va</subtype><play>0</play></Ottava>
            <next><location><measures>1</measures></location></next>
          </Spanner>
          <Chord><durationType>whole</durationType><Note><pitch>60</pitch></Note></Chord>
        </voice>
      </Measure>
    </Staff>
  </Score>
</museScore>`;

const parsed = parseMscx(xml);
const byTick = new Map(parsed.notes.map((n) => [n.tick, n.midi]));

check(parsed.notes.length === 3, `解析出 3 个音（实际 ${parsed.notes.length}）`);
check(byTick.get(960) === 72, '八度线从小节第 3 拍开始：这一拍之后写的 C4 变成 C5(72)');
check(byTick.get(1920) === 72, '往后 1 小节仍在线内（起点的偏移保留）：下一小节的 C4 也变 72');
check(byTick.get(3840) === 60, '线结束后不再移调：再下一小节是 60');
check(![...byTick.values()].includes(84), '没有重复移调（84 不出现）');

console.log(fails ? `\n${fails} 条失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
