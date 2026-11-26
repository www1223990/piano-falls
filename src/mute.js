// 声部静音：把某个谱表的和弦换成等长休止符，再让 MuseScore 重新渲染。
//
// 为什么不用混音器（audiosettings.json 的 mute）：MuseScore 命令行导出根本不读它
// （实测渲染结果一字节不差）。直接删 <Chord> 又会让某些谱表崩（exit 1320）。
// 换成等长休止符是最稳的：节奏结构不变，谱面仍然合法，渲染结果里那一声部就没了。

/**
 * @param {string} xml .mscx 文本
 * @param {number[]} staffIds 要静音的谱表 id
 * @returns {string} 改好的 mscx 文本
 */
export function muteStaffs(xml, staffIds) {
  let out = xml;
  for (const id of staffIds) out = muteOneStaff(out, id);
  return out;
}

function staffBlockRange(source, staffId) {
  const open = `<Staff id="${staffId}">`;
  let pos = source.indexOf(open);
  while (pos >= 0) {
    const end = source.indexOf('</Staff>', pos);
    // <Part> 里也有 <Staff id="N"> 占位，只有谱面段里才有 <Measure>
    if (end > pos && source.slice(pos, end).includes('<Measure>')) return { start: pos, end };
    pos = source.indexOf(open, pos + open.length);
  }
  return null;
}

function chordToRest(chord) {
  const dur = /<durationType>([^<]+)<\/durationType>/.exec(chord)?.[1] ?? 'quarter';
  const dots = /<dots>(\d+)<\/dots>/.exec(chord)?.[1];
  const exact = /<duration>([\d/]+)<\/duration>/.exec(chord)?.[1];
  const tuplet = /<Tuplet>[\s\S]*?<\/Tuplet>/.exec(chord)?.[0] ?? '';
  // 三连音的结束标记在琴键里，换谱时得跟着保留，否则后面的休止符会被继续缩放
  const endTuplet = chord.includes('<endTuplet/>') ? '<endTuplet/>' : '';
  return (
    '<Rest>' +
    (dots ? `<dots>${dots}</dots>` : '') +
    (exact ? `<duration>${exact}</duration>` : '') +
    `<durationType>${dur}</durationType>` +
    tuplet +
    endTuplet +
    '</Rest>'
  );
}

function muteOneStaff(source, staffId) {
  const range = staffBlockRange(source, staffId);
  if (!range) return source;
  let block = source.slice(range.start, range.end);

  // 1) 束符（<Beam>…</Beam>、<Beam/>）挂在声部层级，引用音符偏移；
  //    和弦被拿掉之后它就成了悬空引用，MuseScore 会直接崩掉。
  block = block.replace(/<Beam>[\s\S]*?<\/Beam>/g, '');
  block = block.replace(/<Beam\/>/g, '');

  // 2) 和弦 → 等长休止符。倚音（acciaccatura / grace16 等）是零时值的，
  //    换成休止符会把小节时值撑坏，直接整块删掉。
  //
  //    两音颤音（TremoloTwoChord）要特别处理：谱面里写着两个半音符，但它们**同时**演奏，
  //    只占一小节的时值。如果各换成一个休止符，小节就变成 4 拍（2/4 里放不下），
  //    MuseScore 直接拒绝导出（Cancan 结尾实测 exit≠0，分轨备好失败）。
  //    所以：第一个换成休止符，紧跟的"另一半"整个删掉。
  let skipTremoloPartner = false;
  block = block.replace(/<Chord>[\s\S]*?<\/Chord>/g, (chord) => {
    if (skipTremoloPartner) {
      skipTremoloPartner = false;
      return '';
    }
    if (/<acciaccatura\/>|<grace(8|16|32|64)\/>|<graceNoteType>/.test(chord)) return '';
    if (chord.includes('<TremoloTwoChord')) skipTremoloPartner = true;
    return chordToRest(chord);
  });

  return source.slice(0, range.start) + block + source.slice(range.end);
}

/**
 * 用改过的谱面重新渲染音频。
 * @param {string} xmlText 改好的 .mscx
 * @returns {Promise<Uint8Array>} 音频字节
 */
export async function renderMuted(xmlText) {
  const bytes = new TextEncoder().encode(xmlText);
  const res = await fetch('/render?ext=mscx', { method: 'POST', body: bytes });
  if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
  const zip = await res.arrayBuffer();
  const { readZipEntry } = await import('./zip.js');
  return readZipEntry(zip, (n) => /\.(mp3|ogg|wav)$/i.test(n));
}