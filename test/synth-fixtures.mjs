// 测试用的合成谱面：**全部是本项目自己写的音符**，不含任何第三方乐谱，
// 可以放心公开。以前 test/fixtures/ 里放的是三首真实商业编曲的 mscx，不能进公开仓库。
//
// 三份谱子各自覆盖一类问题：
//   pianoViolin  双谱表钢琴 + 小提琴（多乐器、左右手、连音线、三连音、倚音、弱起、变速）
//   repeats      反复 / 1.2. 结尾 / "%" 小节重复 / 两音颤音 / 八度线（MuseScore 4.7 的 <Staff> 不带 id）
//   singleViolin 单一非键盘乐器（只画指板窗格那条路）

/** 一个和弦：默认单音，extra 里可以塞 tie / tuplet / grace 等 */
function chord(pitches, durType, extra = '') {
  const notes = pitches
    .map((p) => `<Note><pitch>${p}</pitch><tpc>14</tpc>${extra.includes('TIE') ? '<Spanner type="Tie"><Tie/><next><location><fractions>1/4</fractions></location></next></Spanner>' : ''}</Note>`)
    .join('');
  return `<Chord>${extra.replace('TIE', '')}<durationType>${durType}</durationType>${notes}</Chord>`;
}

const rest = (durType) => `<Rest><durationType>${durType}</durationType></Rest>`;

/**
 * 一个小节。
 * head：放在 <voice> 外面的元素（反复记号、% 小节重复这些必须是 Measure 的直接子元素，
 *       塞进 <voice> 里解析器就看不见了 —— 这个坑我自己踩过）
 */
const measure = (body, { attrs = '', head = '' } = {}) =>
  `<Measure${attrs ? ' ' + attrs : ''}>${head}<voice>${body}</voice></Measure>`;

const staffBlock = (id, measures) => `<Staff${id ? ` id="${id}"` : ''}>${measures.join('')}</Staff>`;

const PART = (id, staffIds, instrumentId, name) =>
  `<Part id="${id}">${staffIds.map((s) => (s ? `<Staff id="${s}"/>` : '<Staff/>')).join('')}` +
  `<trackName>${name}</trackName><Instrument id="${instrumentId}"><longName>${name}</longName>` +
  `<instrumentId>${instrumentId}</instrumentId></Instrument></Part>`;

const TIMESIG = '<TimeSig><sigN>4</sigN><sigD>4</sigD></TimeSig>';
const TEMPO = (n) => `<Tempo><tempo>${n}</tempo></Tempo>`;

// ---------------- 1. 钢琴 + 小提琴 ----------------
const pianoViolin = `<?xml version="1.0" encoding="UTF-8"?>
<museScore version="4.40">
  <Score>
    <Division>480</Division>
    ${PART('1', ['1', '2'], 'keyboard.piano', 'Piano')}
    ${PART('2', ['3'], 'strings.violin', 'Violin')}
    ${staffBlock(
      '1',
      [
        // 弱起小节：len 写在属性上（4.x 的写法）。倚音零时值 + 一个四分音符（连音线起点）
        measure(
          TIMESIG +
            TEMPO('1.916667') +
            `<Chord><durationType>eighth</durationType><acciaccatura/><Note><pitch>74</pitch></Note></Chord>` +
            chord([72], 'quarter', 'TIE'),
          { attrs: 'len="1/4"' },
        ),
        // 连音线终点（同音高、正好接上）→ 合并成一个 960 长音；然后一个 5:4 的十六分三连音
        measure(
          chord([72], 'quarter') +
            '<Tuplet><normalNotes>4</normalNotes><actualNotes>5</actualNotes></Tuplet>' +
            chord([64], '16th') +
            chord([67], '16th') +
            chord([69], '16th') +
            chord([71], '16th') +
            chord([72], '16th') +
            '<endTuplet/>' +
            rest('half'),
        ),
        // 变速 + 整小节和弦
        measure(TEMPO('1.083333') + chord([60], 'whole')),
        measure(chord([60, 64, 67], 'half') + chord([72, 76, 79], 'half')),
        measure(rest('whole')),
        measure(chord([60, 64], 'quarter') + rest('half') + rest('quarter')),
      ],
    )}
    ${staffBlock(
      '2',
      [
        measure(rest('quarter')),
        measure(chord([48], 'half') + chord([43], 'half')),
        measure(chord([48], 'whole')),
        measure(rest('whole')),
        measure(chord([36], 'whole')),
        measure(rest('whole')),
      ],
    )}
    ${staffBlock('3', [
      measure(chord([76], 'quarter')),
      measure(chord([72], 'quarter') + rest('half') + rest('quarter')),
      measure(chord([60], 'half') + rest('half')),
      measure(chord([67], 'half') + chord([71], 'half')),
      measure(rest('whole')),
      measure(chord([64], 'half') + rest('half')),
    ])}
  </Score>
</museScore>`;

// ---------------- 2. 反复 / 结尾 / % / 颤音 / 八度线 ----------------
const repeats = `<?xml version="1.0" encoding="UTF-8"?>
<museScore version="4.70">
  <Score>
    <Division>480</Division>
    ${PART('1', ['1'], 'keyboard.piano', 'Piano')}
    ${staffBlock(
      '1',
      [
        measure(TIMESIG + TEMPO('1.916667') + chord([72], 'quarter') + rest('half') + rest('quarter')),
        measure(chord([74], 'quarter') + rest('half') + rest('quarter'), { head: '<startRepeat/>' }),
        measure(
          '<Spanner type="Volta"><Volta><endings>1</endings></Volta><next><location><measures>2</measures></location></next></Spanner>' +
            chord([76], 'quarter') +
            rest('half') +
            rest('quarter'),
        ),
        measure(chord([77], 'quarter') + rest('half') + rest('quarter'), { head: '<endRepeat/>' }),
        measure(
          '<Spanner type="Volta"><Volta><endings>2</endings></Volta><next><location><measures>1</measures></location></next></Spanner>' +
            chord([79], 'quarter') +
            rest('half') +
            rest('quarter'),
        ),
        // "%" 小节重复：内容是空的，借用上一小节
        measure('<MeasureRepeat><subtype>1</subtype><durationType>measure</durationType></MeasureRepeat>', {
          head: '<measureRepeatCount>1</measureRepeatCount>',
        }),
        // 两音颤音：两个半音符同时开始、占满整小节
        measure(
          '<Chord><TremoloTwoChord><subtype>c16</subtype></TremoloTwoChord><durationType>half</durationType>' +
            '<Note><pitch>60</pitch></Note></Chord>' +
            chord([67], 'half'),
        ),
        // 八度线：从本小节第 1 拍起，往后 1 小节
        measure(
          '<Spanner type="Ottava"><Ottava><subtype>8va</subtype></Ottava><next><location><measures>1</measures></location></next></Spanner>' +
            chord([62], 'whole'),
        ),
      ],
    )}
  </Score>
</museScore>`;

// ---------------- 3. 单一非键盘乐器 ----------------
const singleViolin = `<?xml version="1.0" encoding="UTF-8"?>
<museScore version="4.10">
  <Score>
    <Division>480</Division>
    ${PART('1', ['1'], 'strings.violin', 'Violin')}
    ${staffBlock('1', [
      measure(TIMESIG + TEMPO('1.916667') + chord([76], 'half') + chord([72], 'half')),
      measure(chord([67], 'whole')),
      measure(chord([60], 'half') + rest('half')),
      measure(chord([64], 'whole')),
    ])}
  </Score>
</museScore>`;

// ---------------- 内存里造一个 .mscz（store 方式） ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 极简 zip 写入：默认 store；传了 raw 就按 deflate(8) 写（raw 是压缩前的原文，
 * 用来算 CRC 和未压缩长度）——真实 .mscz 基本都是 deflate。
 */
export function zipStore(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const stored = entry.raw ? entry.data : entry.data;
    const raw = entry.raw ?? entry.data;
    const method = entry.raw ? 8 : 0;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, stored);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(stored.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + stored.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

/** 把合成谱面打包成 .mscz 的 ArrayBuffer（和真实文件一样带 META-INF/container.xml） */
export function asMscz(mscxText, mscxName = 'score.mscx') {
  const zip = zipStore([
    { name: 'META-INF/container.xml', data: Buffer.from('<container/>', 'utf8') },
    { name: mscxName, data: Buffer.from(mscxText, 'utf8') },
  ]);
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
}

export const FIXTURES = { pianoViolin, repeats, singleViolin };
