// 极简 XML 解析器：只为 mscx / MusicXML 这类机器生成的 XML 服务。
// 手写而不用 DOMParser，是为了让同一份代码在浏览器和 Node 测试里都跑。
// 支持：元素、属性、自闭合、注释、CDATA、XML 声明、实体（含数字实体）。
// 不支持：DTD、命名空间前缀解析（mscx 用不到）。

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    return ENTITIES[e] ?? m;
  });
}

function parseAttrs(src) {
  const attrs = {};
  if (!src) return attrs;
  const re = /([-\w:.\u4e00-\u9fa5]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) {
    attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  }
  return attrs;
}

/**
 * @param {string} text
 * @returns {{name:string, attrs:Object, children:Array, text:string}} 文档根（name='#document'）
 */
export function parseXml(text) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const n = text.length;
  let i = 0;

  const top = () => stack[stack.length - 1];
  const addText = (s) => {
    if (s) top().text += decodeEntities(s);
  };

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      addText(text.slice(i));
      break;
    }
    if (lt > i) addText(text.slice(i, lt));

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      top().text += text.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }

    // 找标签的 > ：引号里的 > 不算
    let j = lt + 1;
    let quote = null;
    while (j < n) {
      const ch = text[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }
    const raw = text.slice(lt + 1, j);
    i = j + 1;

    if (raw[0] === '/') {
      const name = raw.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = /^([A-Za-z_][-\w:.]*)\s*([\s\S]*)$/.exec(body);
    if (!m) continue;

    const node = { name: m[1], attrs: parseAttrs(m[2]), children: [], text: '' };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

// ---- 便捷查询 ----
export const kids = (node) => (node && node.children) || [];
export const child = (node, name) => kids(node).find((c) => c.name === name);
export const childrenOf = (node, name) => kids(node).filter((c) => c.name === name);
export const textOf = (node) => (node ? String(node.text).trim() : '');
export const attrOf = (node, name, dflt = '') => (node && node.attrs && node.attrs[name] !== undefined ? node.attrs[name] : dflt);

/** 取子元素文本并转数字 */
export function numOf(node, name, dflt = 0) {
  const c = child(node, name);
  if (!c) return dflt;
  const v = Number(textOf(c));
  return Number.isFinite(v) ? v : dflt;
}

/** 按路径取子元素，如 path(score, 'Instrument/instrumentId') */
export function pathOf(node, path) {
  let cur = node;
  for (const part of path.split('/')) {
    cur = child(cur, part);
    if (!cur) return null;
  }
  return cur;
}