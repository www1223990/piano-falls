// 弓弦乐器的键盘条视图（色盲友好版）。
//
// 三个层次的区分，不只靠颜色：
//   1. 每条弦下面一个大色块，块里写大字母 G / D / A / E（字母是色盲也能读的硬信息）
//   2. 弦与弦之间一条很粗的黑分隔线
//   3. 键面颜色：同一条弦内由浅到深（明度梯度，不依赖色相分辨）
//
// 配色用 Okabe-Ito（公认的色盲安全色板），四色在红绿色盲下也能分开。
// 键盘顶部是共用触发线，音符从上方落到自己那个键上，块上写音名。

import * as THREE from 'three';
import { pitchName, assignString } from './instruments.js';
import { buildKeyboardRange, BLACK_PCS } from './keyboard-layout.js';

const MAX_BARS = 200;
const MAX_KEYS = 96;
const MAX_LABELS = 40;
const ARC_SEGMENTS = 12;
const MAX_ARCS = 12;
const MAX_HITS = 32;

// Okabe-Ito 色盲安全色：蓝 / 橙 / 绿 / 洋红
const STRING_COLORS = ['#0072B2', '#E69F00', '#009E73', '#CC79A7'];
const STRING_NAMES = ['G', 'D', 'A', 'E'];
// 弦与弦之间那条粗黑线的宽度（颜色一律止步于它两侧，绝不互相贴边）
const SEP_W = 0.11;
// 键盘上段（黑键那一排）不画分隔线（用户要求：黑键里面不能有缝），
// 粗黑线只出现在黑键下沿以下。
const KEY_GAP = 0.03;

const hasDOM = typeof document !== 'undefined' && typeof document.createElement === 'function';
const texCache = new Map();

function labelTexture(text, { size = 44, color = '#ffffff', weight = '700' } = {}) {
  const key = `${text}|${size}|${color}|${weight}`;
  if (texCache.has(key)) return texCache.get(key);
  if (!hasDOM) return null;
  const w = 256;
  const h = 96;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.font = `${weight} ${size}px ui-sans-serif, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  g.fillText(text, w / 2, h / 2);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  texCache.set(key, t);
  return t;
}

export function createStringsLane({ family, laneName } = {}) {
  const scene = new THREE.Scene();
  let camera = new THREE.OrthographicCamera(-8, 8, 5, -5, 0.1, 100);
  let rect = { x: 0, y: 0, w: 800, h: 400 };

  const view = { worldW: 16, keyH: 1.6, legendH: 0.7, baseY: 2.3, fallHeight: 4, visibleH: 6, halfW: 8 };
  const state = {
    notes: [],
    crossings: [],
    cursor: 0,
    lastTime: -Infinity,
    perStringMax: [0, 0, 0, 0],
    keyByMidi: new Map(),
  };

  const box = new THREE.BoxGeometry(1, 1, 1);
  let keyboard = null;

  // ---- 每根弦的发光底色（演奏时整段亮）----
  const glowBands = [];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(
      box,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(STRING_COLORS[i]),
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    m.frustumCulled = false;
    scene.add(m);
    glowBands.push(m);
  }

  // ---- 键盘 ----
  const keyMesh = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({}), MAX_KEYS);
  keyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  keyMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_KEYS * 3).fill(1), 3);
  keyMesh.count = 0;
  keyMesh.frustumCulled = false;
  scene.add(keyMesh);

  // ---- 弦的大色块 + 大字母 ----
  const legendBlocks = [];
  const legendLabels = [];
  for (let i = 0; i < 4; i++) {
    const block = new THREE.Mesh(
      box,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(STRING_COLORS[i]), transparent: true, opacity: 0.95 }),
    );
    scene.add(block);
    legendBlocks.push(block);

    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    sprite.visible = false;
    scene.add(sprite);
    legendLabels.push(sprite);
  }

  // ---- 弦之间的分隔线：下段（黑键下沿以下）粗，上段只用普通键缝粗细 ----
  const separators = [];
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(
      box,
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.95 }),
    );
    m.visible = false;
    scene.add(m);
    separators.push(m);
  }
  // （黑键那一排不画任何分隔线：黑键之间不能有缝）

  // ---- 按下的标记（亮红条 + 白色垫底，任何键色/色盲下都跳得出来）----
  const hitBack = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_HITS);
  hitBack.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  hitBack.count = 0;
  hitBack.frustumCulled = false;
  scene.add(hitBack);

  const hitMesh = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0xff3b30 }), MAX_HITS);
  hitMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  hitMesh.count = 0;
  hitMesh.frustumCulled = false;
  scene.add(hitMesh);

  // ---- 触发线 ----
  const triggerLine = new THREE.Mesh(
    box,
    new THREE.MeshBasicMaterial({ color: 0x6fe6ff, transparent: true, opacity: 0.9 }),
  );
  triggerLine.frustumCulled = false;
  scene.add(triggerLine);

  // ---- 键上的音名 ----
  const keyLabels = [];
  for (let i = 0; i < MAX_KEYS; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, opacity: 0.8 }));
    sprite.visible = false;
    scene.add(sprite);
    keyLabels.push(sprite);
  }

  // ---- 音符块 ----
  const barMesh = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({}), MAX_BARS);
  barMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  barMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BARS * 3).fill(1), 3);
  barMesh.count = 0;
  barMesh.frustumCulled = false;
  scene.add(barMesh);

  // ---- 音符上的音名 ----
  const noteLabels = [];
  for (let i = 0; i < MAX_LABELS; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    sprite.visible = false;
    scene.add(sprite);
    noteLabels.push(sprite);
  }

  // ---- 换弦弧线 ----
  const arcs = [];
  for (let i = 0; i < MAX_ARCS; i++) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_SEGMENTS * 3), 3));
    const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    arcs.push(line);
  }

  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  const WHITE = new THREE.Color('#ffffff');

  function baseColor(s, out) {
    return out.set(STRING_COLORS[s] ?? STRING_COLORS[0]);
  }

  function annotateKeys() {
    state.keyByMidi.clear();
    if (!keyboard) return;
    for (const k of keyboard.keys) {
      const a = assignString(family, k.midi);
      k.stringIndex = a.stringIndex;
      k.position = a.position;
      state.keyByMidi.set(k.midi, k);
    }
  }

  function setScore(laneData) {
    const notes = (laneData.notes ?? []).slice().sort((a, b) => a.time - b.time);
    state.notes = notes;
    state.crossings = (laneData.crossings ?? []).filter((c) => c.from && c.to);
    state.cursor = 0;
    state.lastTime = -Infinity;

    const perMax = [0, 0, 0, 0];
    const perMin = [127, 127, 127, 127];
    let lo = 127;
    let hi = 0;
    for (const n of notes) {
      const s = n.stringIndex ?? 0;
      if ((n.position ?? 0) > perMax[s]) perMax[s] = n.position;
      if (n.midi < perMin[s]) perMin[s] = n.midi;
      if (n.midi < lo) lo = n.midi;
      if (n.midi > hi) hi = n.midi;
    }
    state.perStringMax = perMax;

    // 起点 = 全曲最低音；终点 = 最高音。
    // 规则：每根弦"一般六格"，第四根弦也一样——只有当曲子用到更高音时才往外补。
    const from = lo > hi ? (family?.strings?.[0]?.open ?? 55) : lo;
    let to = hi > 0 ? hi : from + 5;
    const eFirst = perMin[3] < 127 ? perMin[3] : null;
    if (eFirst !== null) to = Math.max(to, eFirst + 5); // 第四根弦至少留六个音高
    else to = Math.max(to, from + 5);
    to = Math.min(108, to);

    keyboard = buildKeyboardRange(from, to);
    annotateKeys();
    fitCamera();
  }

  function setRect(next) {
    rect = next;
    fitCamera();
  }

  function layout() {
    const aspect = rect.w / Math.max(1, rect.h);
    const worldW = keyboard ? keyboard.width : 16;
    const halfW = (worldW * 1.02) / 2;
    const halfH = halfW / aspect;
    const visibleH = halfH * 2;
    const keyH = Math.min(visibleH * 0.3, worldW * 0.16);
    const legendH = Math.min(visibleH * 0.12, keyH * 0.42);
    const baseY = legendH + keyH;
    const fallHeight = Math.max(1.2, visibleH - baseY);
    Object.assign(view, { worldW, halfW, halfH, visibleH, keyH, legendH, baseY, fallHeight });
    return view;
  }

  /** 每条弦在 x 上的范围 */
  function segments() {
    if (!keyboard) return [];
    const raw = [];
    for (let s = 0; s < 4; s++) {
      const seg = keyboard.keys.filter((k) => k.stringIndex === s);
      if (!seg.length) {
        raw.push(null);
        continue;
      }
      const x1 = Math.min(...seg.map((k) => k.x - k.w / 2));
      const x2 = Math.max(...seg.map((k) => k.x + k.w / 2));
      raw.push({ x1, x2, keys: seg });
    }
    // 相邻两条弦在键盘上的音域会互相压进去半个键宽。如果各画各的，
    // 后画的颜色就会盖在前一条弦上，黑线两边出现"另一种颜色贴着一小块"。
    // 所以在两者中间切一刀，让每段独占自己的横坐标区间。
    const cuts = [];
    for (let s = 0; s < 3; s++) {
      const a = raw[s];
      const b = raw[s + 1];
      let mid;
      if (a && b) mid = (a.x2 + b.x1) / 2;
      else if (a) mid = a.x2;
      else if (b) mid = b.x1;
      else mid = 0;
      // 让分隔线正好从某个黑键的中央落下来：取离这个中点最近的黑键，
      // 位置差太多就退回中点（有的调弦附近没有黑键）。
      let best = null;
      let bestD = Infinity;
      for (const k of keyboard.keys) {
        if (!k.black) continue;
        const d = Math.abs(k.x - mid);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      cuts[s] = best && bestD < 0.5 ? best.x : mid;
      if (!state.cutKeys) state.cutKeys = [];
      state.cutKeys[s] = best && bestD < 0.5 ? { midi: best.midi, x: +best.x.toFixed(2), d: +bestD.toFixed(2) } : null;
    }
    // 交界处那个黑键要整块保留（不能被裁掉半边），粗线从它正中穿下去
    state.cutMids = new Set((state.cutKeys ?? []).filter(Boolean).map((c) => c.midi));
    return raw.map((seg, s) => {
      if (!seg) return null;
      let left = s === 0 ? seg.x1 : cuts[s - 1];
      let right = s === 3 ? seg.x2 : cuts[s];
      if (right < left) [left, right] = [right, left];
      // 该段最靠边的白键/黑键各记一个：延伸时要按"同类里最外边的那一个"补，
      // 否则最高音是黑键时，白键就补不到分隔线上（黑线边会空出一条背景色）。
      const pick = (arr, fn) => arr.reduce((best, k) => (!best || fn(k) > fn(best) ? k : best), null);
      const whites = seg.keys.filter((k) => !k.black);
      const blacks = seg.keys.filter((k) => k.black);
      return {
        x1: left,
        x2: right,
        keys: seg.keys,
        lw: pick(whites, (k) => -(k.x - k.w / 2)),
        rw: pick(whites, (k) => k.x + k.w / 2),
        lb: pick(blacks, (k) => -(k.x - k.w / 2)),
        rb: pick(blacks, (k) => k.x + k.w / 2),
      };
    });
  }

  function fitCamera() {
    const v = layout();
    camera.left = -v.halfW;
    camera.right = v.halfW;
    camera.bottom = -v.halfH;
    camera.top = v.halfH;
    const bottom = -0.15;
    const top = bottom + v.visibleH;
    const centerY = (bottom + top) / 2;
    const cx = (keyboard ? keyboard.x0 : 0) + (keyboard ? keyboard.width : 0) / 2;
    camera.position.set(cx, centerY, 30);
    camera.lookAt(cx, centerY, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    triggerLine.position.set(cx, v.baseY, 0.05);
    triggerLine.scale.set(v.worldW + 0.4, 0.03, 0.01);

    const segs = segments();
    state.segs = segs;
    const sepX = [];
    for (let s = 0; s < 4; s++) {
      const seg = segs[s];
      const block = legendBlocks[s];
      const label = legendLabels[s];
      if (!seg) {
        block.visible = false;
        label.visible = false;
        glowBands[s].visible = false;
        continue;
      }
      // 大色块
      block.visible = true;
      block.position.set((seg.x1 + seg.x2) / 2, v.legendH / 2, 0.02);
      block.scale.set(Math.max(0.02, seg.x2 - seg.x1 - SEP_W), v.legendH - 0.06, 0.01);

      // 大字母（色盲靠这个读弦）
      label.material.map = labelTexture(STRING_NAMES[s], { size: 62, color: '#ffffff', weight: '800' });
      label.material.needsUpdate = true;
      label.position.set((seg.x1 + seg.x2) / 2, v.legendH / 2, 0.08);
      const w = Math.min(seg.x2 - seg.x1 - 0.15, v.legendH * 0.62);
      label.scale.set(w * 1.6, v.legendH * 0.62, 1);
      label.visible = true;

      // 该段的发光范围：从底到触发线
      glowBands[s].visible = true;
      glowBands[s].position.set((seg.x1 + seg.x2) / 2, v.baseY / 2, 0.015);
      glowBands[s].scale.set(Math.max(0.02, seg.x2 - seg.x1 - SEP_W), v.baseY, 0.01);

      sepX.push(seg.x2);
    }

    // 分隔线：只画在黑键下面（黑键那一排不留任何缝）
    const kbBotY = v.legendH + v.keyH * 0.42; // 黑键下沿
    const lowerH = Math.max(0.02, kbBotY);
    for (let i = 0; i < separators.length; i++) {
      const sep = separators[i];
      const x = sepX[i];
      if (x === undefined || i >= sepX.length - 1) {
        sep.visible = false;
        continue;
      }
      sep.visible = true;
      sep.position.set(x, lowerH / 2, 0.06);
      sep.scale.set(SEP_W, lowerH, 0.01);
    }

    // 音名标签
    let li = 0;
    if (keyboard) {
      for (const k of keyboard.keys) {
        if (k.black) continue;
        if (li >= keyLabels.length) break;
        const sprite = keyLabels[li++];
        sprite.material.map = labelTexture(pitchName(k.midi), { size: 36, color: '#0b1220' });
        sprite.material.needsUpdate = true;
        sprite.position.set(k.x, v.legendH + v.keyH * 0.28, 0.07);
        sprite.scale.set(Math.min(k.w * 0.9, 0.95), 0.16, 1);
        sprite.visible = true;
      }
    }
    for (; li < keyLabels.length; li++) keyLabels[li].visible = false;
  }

  function update(scoreTime, fallDuration) {
    const v = view;
    const H = v.fallHeight;
    const speed = H / Math.max(0.35, fallDuration);
    const notes = state.notes;

    if (scoreTime < state.lastTime - 0.05) state.cursor = 0;
    while (state.cursor < notes.length && notes[state.cursor].time + notes[state.cursor].dur <= scoreTime) {
      state.cursor++;
    }
    const lo = Math.max(0, state.cursor - 10);
    state.lastTime = scoreTime;

    const active = [false, false, false, false];
    const hit = new Set();
    for (const n of notes) {
      if (n.time <= scoreTime && n.time + n.dur > scoreTime) {
        active[n.stringIndex ?? 0] = true;
        hit.add(n.midi);
      } else if (n.time > scoreTime) break;
    }

    // ---- 键盘 ----
    let kc = 0;
    let hc = 0;
    if (keyboard) {
      for (const k of keyboard.keys) {
        const isHit = hit.has(k.midi);
        // 键的横坐标按它所属那条弦的区间裁一刀：跨过分隔线的部分不画，
        // 否则会在黑线另一边露出一条别的颜色（用户说的"挨一块"）。
        const seg = state.segs?.[k.stringIndex];
        let kx = k.x;
        let kw = k.w;
        if (seg && !state.cutMids?.has(k.midi)) {
          const gap = KEY_GAP / 2;
          // 只补白键：白键是满高的，补到分隔线上正好把上下两排的缝都填住，
          // 黑键保持自然宽度（否则边上的黑键会被拉成一大块黑板）。
          const left = !k.black && k === seg.lw ? seg.x1 + gap : Math.max(k.x - k.w / 2, seg.x1 + gap);
          const right = !k.black && k === seg.rw ? seg.x2 - gap : Math.min(k.x + k.w / 2, seg.x2 - gap);
          if (right - left < 0.004) continue;
          kw = right - left;
          kx = (left + right) / 2;
        }
        const depth = k.black ? v.keyH * 0.58 : v.keyH;
        dummy.position.set(kx, v.legendH + v.keyH - depth / 2, k.black ? 0.03 : 0.01);
        dummy.scale.set(kw, depth, 0.02);
        dummy.updateMatrix();
        keyMesh.setMatrixAt(kc, dummy.matrix);

        const span = Math.max(1, state.perStringMax[k.stringIndex] ?? 1);
        const t = Math.min(1, Math.max(0, k.position / span));
        baseColor(k.stringIndex, tmpColor);
        // 同一条弦内由浅到深（明度梯度，色盲也能看出顺序）
        if (k.black) tmpColor.multiplyScalar(0.42);
        else tmpColor.lerp(WHITE, 0.45 * (1 - t));
        // 按下的键：黑键绝对不能变白（会失去"黑键"身份、和浅色键混在一起），
        // 只在自己色相上提亮一档；白键照常提亮。
        if (isHit) {
          if (k.black) tmpColor.lerp(WHITE, 0.16);
          else tmpColor.lerp(WHITE, 0.5);
        }
        keyMesh.setColorAt(kc, tmpColor);
        kc++;

        // 按下的键：键面顶端一条亮红横条（下面垫一条稍宽的白条做描边）
        if (isHit && hc < MAX_HITS) {
          dummy.position.set(kx, v.baseY - 0.055, 0.085);
          dummy.scale.set(kw * 1.04, 0.13, 0.01);
          dummy.updateMatrix();
          hitBack.setMatrixAt(hc, dummy.matrix);

          dummy.position.set(kx, v.baseY - 0.055, 0.095);
          dummy.scale.set(kw * 0.88, 0.075, 0.01);
          dummy.updateMatrix();
          hitMesh.setMatrixAt(hc, dummy.matrix);
          hc++;
        }
      }
    }
    keyMesh.count = kc;
    hitMesh.count = hc;
    hitBack.count = hc;
    hitMesh.instanceMatrix.needsUpdate = true;
    hitBack.instanceMatrix.needsUpdate = true;
    keyMesh.instanceMatrix.needsUpdate = true;
    keyMesh.instanceColor.needsUpdate = true;

    // ---- 音符 ----
    let count = 0;
    let labelCount = 0;
    for (let i = lo; i < notes.length; i++) {
      const n = notes[i];
      const bottom = (n.time - scoreTime) * speed;
      if (bottom > H) break;
      const top = (n.time + n.dur - scoreTime) * speed;
      if (top <= 0) continue;

      const key = state.keyByMidi.get(n.midi);
      let x = key ? key.x : (keyboard ? keyboard.x0 : 0);
      let w = (key ? key.w : 1) * 0.9;
      // 下落的音符条也别跨过黑线，否则会盖到隔壁那条弦的颜色上
      const barSeg = state.segs?.[n.stringIndex ?? 0];
      if (barSeg) {
        const halfBar = KEY_GAP / 2;
        const bLeft = Math.max(x - w / 2, barSeg.x1 + halfBar);
        const bRight = Math.min(x + w / 2, barSeg.x2 - halfBar);
        if (bRight - bLeft < 0.004) continue;
        w = bRight - bLeft;
        x = (bLeft + bRight) / 2;
      }
      const b = Math.max(bottom, 0);
      const h = Math.min(top - b, H * 0.95) - 0.04;
      if (h < 0.02 || count >= MAX_BARS) continue;

      dummy.position.set(x, v.baseY + b + h / 2, 0.05);
      dummy.scale.set(w, h, 0.01);
      dummy.updateMatrix();
      barMesh.setMatrixAt(count, dummy.matrix);
      baseColor(n.stringIndex ?? 0, tmpColor);
      if (n.below || n.tooHigh) tmpColor.lerp(new THREE.Color('#88909c'), 0.5);
      barMesh.setColorAt(count, tmpColor);
      count++;

      if (labelCount < MAX_LABELS) {
        const sprite = noteLabels[labelCount++];
        sprite.material.map = labelTexture(pitchName(n.midi), { size: 52, color: '#08101a', weight: '800' });
        sprite.material.needsUpdate = true;
        sprite.position.set(x, v.baseY + b + Math.min(h / 2, 0.14), 0.09);
        sprite.scale.set(Math.min(w * 1.15, 1.05), 0.19, 1);
        sprite.visible = true;
      }
    }
    barMesh.count = count;
    barMesh.instanceMatrix.needsUpdate = true;
    barMesh.instanceColor.needsUpdate = true;
    for (let i = labelCount; i < noteLabels.length; i++) noteLabels[i].visible = false;

    // ---- 演奏中整段发光 ----
    for (let s = 0; s < 4; s++) {
      if (!glowBands[s].visible) continue;
      glowBands[s].material.opacity = active[s] ? 0.22 : 0;
    }

    // ---- 换弦弧线：从前一个音的"尾"连到后一个音的"头" ----
    let arcCount = 0;
    for (const c of state.crossings) {
      if (arcCount >= arcs.length) break;
      const ka = state.keyByMidi.get(c.from.midi);
      const kz = state.keyByMidi.get(c.to.midi);
      if (!ka || !kz) continue;

      // 尾连头：A 的结束点 → B 的起始点（音符向下落，所以时间越晚越高）
      const yTailA = (c.from.time + c.from.dur - scoreTime) * speed;
      const yHeadB = (c.to.time - scoreTime) * speed;
      // 后一个音已经落地 = 这条连线已经"弹完了"，立刻消失
      if (yHeadB < -0.15) continue;
      if (yTailA > H + 4) continue;

      const line = arcs[arcCount++];
      const pos = line.geometry.getAttribute('position');
      const yA = v.baseY + Math.max(yTailA, 0);
      const yZ = v.baseY + Math.max(yHeadB, 0);
      const midY = (yA + yZ) / 2 + Math.min(0.7, v.keyH * 0.45);
      for (let s = 0; s < ARC_SEGMENTS; s++) {
        const t = s / (ARC_SEGMENTS - 1);
        const x = (1 - t) * (1 - t) * ka.x + 2 * (1 - t) * t * ((ka.x + kz.x) / 2) + t * t * kz.x;
        const y = (1 - t) * (1 - t) * yA + 2 * (1 - t) * t * midY + t * t * yZ;
        pos.setXYZ(s, x, y, 0.065);
      }
      pos.needsUpdate = true;
      line.geometry.computeBoundingSphere();
      line.visible = true;
    }
    for (let i = arcCount; i < arcs.length; i++) arcs[i].visible = false;
  }

  fitCamera();

  return {
    kind: 'strings',
    family,
    name: laneName,
    setScore,
    setRect,
    update,
    getScene: () => scene,
    getCamera: () => camera,
    getView: () => ({ ...view, ...rect }),
    debug: () => ({
      bars: barMesh.count,
      keys: keyMesh.count,
      labels: noteLabels.filter((x) => x.visible).length,
      arcs: arcs.filter((a) => a.visible).length,
      notes: state.notes.length,
      low: keyboard?.low ?? null,
      high: keyboard?.high ?? null,
      width: keyboard ? +keyboard.width.toFixed(2) : null,
      perStringMax: state.perStringMax,
      keyH: +view.keyH.toFixed(2),
      baseY: +view.baseY.toFixed(2),
      // 排错用：每段边界、以及该边界选中的黑键（midi + 中心 x）
      cuts: (state.segs ?? []).map((s) => (s ? +s.x2.toFixed(2) : null)),
      cutKeys: state.cutKeys ?? null,
      // 第一条可见弧线的起止点（排错用：应该 = 前一个音的尾 → 后一个音的头）
      arc0: (() => {
        const line = arcs.find((a) => a.visible);
        if (!line) return null;
        const pos = line.geometry.getAttribute('position');
        return {
          from: [+pos.getX(0).toFixed(2), +pos.getY(0).toFixed(2)],
          to: [+pos.getX(ARC_SEGMENTS - 1).toFixed(2), +pos.getY(ARC_SEGMENTS - 1).toFixed(2)],
        };
      })(),
    }),
    dispose() {
      scene.traverse((obj) => {
        obj.geometry?.dispose?.();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
        else obj.material?.dispose?.();
      });
    },
  };
}