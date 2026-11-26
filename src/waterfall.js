// 表现层：默认 2D 正交正面视角（音符沿屏幕竖直下落），可切回 3D 透视。
//
// 2D 模式的坐标系（世界单位 = 一个白键宽）：
//   x ∈ [-26, 26]                     88 键
//   y = 0               键盘前沿（屏幕下方）
//   y = KEY_DEPTH       键盘后沿 = 音符落点线（黑键在上半段，白键向下延伸）
//   y > KEY_DEPTH       瀑布区，音符从这里落到 KEY_DEPTH
// 相机是正交的，且正对 +z，所以世界 y 就是屏幕 y —— 这才是"竖向"。
//
// 这一层仍然是纯函数式的：给它 scoreTime 就画成那个样子，不自己计时。

import * as THREE from 'three';
import { buildKeyboardRange, pickKeyboardSpan, KEY_H, MIDI_LOW, MIDI_HIGH } from './keyboard-layout.js';

const MAX_BARS = 512;
const MAX_MEASURE_LINES = 48;
const KEY_DEPTH_FALLBACK = 6.4; // 2D 兼容值（3D/旧测试用）
// 2D 模式：键盘高度 = 窗格可视高度 × keyFrac（可拖拽键盘上沿调整）
let keyFrac = 0.28;
const KEY_FRAC_MIN = 0.12;
const KEY_FRAC_MAX = 0.55;
const BAR_RADIUS = 0.18; // 音符条左右两侧的圆角半径（世界单位）
const MEASURE_THICK = 0.07;
const BEAT_THICK = 0.03;

const C_WHITE = new THREE.Color('#e8eef6');
const C_BLACK = new THREE.Color('#171d27');
const C_WHITE_HIT = new THREE.Color('#4fc3ff');
const C_BLACK_HIT = new THREE.Color('#2b8fc4');
const C_RH = new THREE.Color('#41b8ff');
const C_LH = new THREE.Color('#ffab49');
const C_MEASURE = new THREE.Color('#6fa8dc');
const C_BEAT = new THREE.Color('#3d6b96');

const hasDOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

/** 圆角条的遮罩：左右边缘按圆角半径渐隐，竖直方向拉伸时不会变形 */
function makeBarTexture() {
  if (!hasDOM) return null;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = 4;
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, 4);
  g.fillStyle = '#fff';
  const r = Math.max(1, Math.round(size * BAR_RADIUS * 0.5));
  // 中间实心，两端做圆角
  g.beginPath();
  g.moveTo(r, 0);
  g.lineTo(size - r, 0);
  g.quadraticCurveTo(size, 0, size, 2);
  g.quadraticCurveTo(size, 4, size - r, 4);
  g.lineTo(r, 4);
  g.quadraticCurveTo(0, 4, 0, 2);
  g.quadraticCurveTo(0, 0, r, 0);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/** 落点光晕：径向渐变 */
function makeGlowTexture() {
  if (!hasDOM) return null;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/** 键上的 C1..C8 标签 */
function makeLabelTexture(text) {
  if (!hasDOM) return null;
  const w = 128;
  const h = 64;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(20,28,40,0.55)';
  g.font = 'bold 34px ui-sans-serif, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

export function createStage(container, opts = {}) {
  // headless = 由 stage.js 统一管画布，这里只管场景/相机/实例
  const headless = !!opts.headless;
  let rect = opts.rect ?? null;
  let renderer = null;
  if (!headless) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
  }

  const scene = new THREE.Scene();
  const box = new THREE.BoxGeometry(1, 1, 1);

  scene.add(new THREE.HemisphereLight(0xfff4e6, 0x0b1018, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.3);
  sun.position.set(-12, 24, 18);
  scene.add(sun);

  // 键盘音域按乐谱实际音高自动选（49/61/76/88 键），不再固定 88
  const MAX_KEYS = 88;
  let kb = buildKeyboardRange(MIDI_LOW, MIDI_HIGH);
  let keys = kb.keys;
  let keyboardW = kb.width;
  let keyByMidi = new Array(128).fill(null);
  let whites = [];
  function reindexKeys() {
    keyByMidi = new Array(128).fill(null);
    for (const k of keys) keyByMidi[k.midi] = k;
    whites = keys.filter((k) => !k.black);
  }
  reindexKeys();

  // ---- 琴键 ----
  // 2D 用不受光的平色材质（像参考图那样干净），3D 用受光材质
  const keyMatLit = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.05 });
  const keyMatFlat = new THREE.MeshBasicMaterial({});
  const keyMesh = new THREE.InstancedMesh(box, keyMatFlat, MAX_KEYS);
  keyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  keyMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_KEYS * 3).fill(1), 3);
  scene.add(keyMesh);

  // ---- 音符条 ----
  const barTex = makeBarTexture();
  const barMatLit = new THREE.MeshStandardMaterial({
    roughness: 0.34,
    metalness: 0.02,
    transparent: true,
    alphaMap: barTex,
    alphaTest: 0.02,
  });
  const barMatFlat = new THREE.MeshBasicMaterial({
    transparent: true,
    alphaMap: barTex,
    alphaTest: 0.02,
  });
  const barMesh = new THREE.InstancedMesh(box, barMatFlat, MAX_BARS);
  barMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  barMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BARS * 3).fill(1), 3);
  barMesh.count = 0;
  scene.add(barMesh);

  // ---- 小节线（水平） ----
  const measureMesh = new THREE.InstancedMesh(
    box,
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 }),
    MAX_MEASURE_LINES,
  );
  measureMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  measureMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MEASURE_LINES * 3).fill(1), 3);
  measureMesh.count = 0;
  measureMesh.visible = false; // 默认关，界面上勾选后打开
  scene.add(measureMesh);

  // ---- 拍点线（水平，比小节线淡） ----
  const beatMesh = new THREE.InstancedMesh(
    box,
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.65 }),
    MAX_MEASURE_LINES * 4,
  );
  beatMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  beatMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MEASURE_LINES * 4 * 3).fill(1), 3);
  beatMesh.count = 0;
  beatMesh.visible = false;
  scene.add(beatMesh);

  // ---- 竖直八度分隔线（像参考图那样，C 的位置一条竖线） ----
  const octaveLines = [];
  function rebuildOctaveLines() {
    for (const l of octaveLines) { scene.remove(l.mesh); l.mesh.geometry?.dispose?.(); l.mesh.material?.dispose?.(); }
    octaveLines.length = 0;
    for (const k of whites) {
      if (k.midi % 12 !== 0) continue;
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(0.02, 1, 0.01),
        new THREE.MeshBasicMaterial({ color: 0x5487bd, transparent: true, opacity: 0.8 }),
      );
      octaveLines.push({ mesh: line, x: k.x - 0.5 });
      scene.add(line);
    }
  }
  rebuildOctaveLines();

  // ---- 落点参考线 ----
  const markerLine = new THREE.Mesh(
    new THREE.BoxGeometry(1, 0.035, 0.06),
    new THREE.MeshBasicMaterial({ color: 0x6fe6ff, transparent: true, opacity: 0.6 }),
  );
  markerLine.scale.x = keyboardW;
  scene.add(markerLine);

  // ---- 键床（3D 模式用） ----
  const bed = new THREE.Mesh(
    new THREE.BoxGeometry(1, 0.9, 7.6),
    new THREE.MeshStandardMaterial({ color: 0x0a0f17, roughness: 0.92, metalness: 0.08 }),
  );
  bed.position.set(0, -0.45, -0.15);
  bed.scale.x = keyboardW + 1.8;
  scene.add(bed);

  // ---- 落点光晕池 ----
  const glowTex = makeGlowTexture();
  const glowPool = [];
  if (glowTex) {
    const glowMat = new THREE.SpriteMaterial({
      map: glowTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.85,
    });
    for (let i = 0; i < 24; i++) {
      const s = new THREE.Sprite(glowMat.clone());
      s.visible = false;
      scene.add(s);
      glowPool.push(s);
    }
  }

  // ---- C 标签 ----
  const labels = [];
  function rebuildCLabels() {
    for (const lb of labels) { scene.remove(lb.sprite); lb.sprite.material?.map?.dispose?.(); lb.sprite.material?.dispose?.(); }
    labels.length = 0;
    if (!hasDOM) return;
    for (const k of whites) {
      if (k.midi % 12 !== 0) continue;
      const tex = makeLabelTexture(`C${Math.floor(k.midi / 12) - 1}`);
      if (!tex) continue;
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.5 }),
      );
      labels.push({ sprite, x: k.x });
      scene.add(sprite);
    }
  }
  rebuildCLabels();

  // ---- 状态 ----
  let mode = opts.mode === '3d' ? '3d' : '2d';
  let camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  const view = { fallHeight: 12, visibleH: 20, halfW: 27 };
  const state = { notes: [], measures: [], beats: [], maxDur: 1, cursor: 0, lastTime: -Infinity };
  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  // 按下状态按 midi 存，不依赖键盘起点（音域是可变的）
  const pressed = new Uint8Array(128);

  function lowerBound(time) {
    let lo = 0;
    let hi = state.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (state.notes[mid].time < time) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function upperBound(time) {
    let lo = 0;
    let hi = state.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (state.notes[mid].time <= time) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function setScore(score) {
    state.notes = score.notes ?? [];
    state.measures = score.measures ?? [];
    state.beats = score.beats ?? [];
    state.maxDur = 1;
    for (const n of state.notes) {
      const d = Math.max(n.dur, n.soundDur ?? n.dur);
      if (d > state.maxDur) state.maxDur = d;
    }
    state.cursor = 0;
    state.lastTime = -Infinity;

    // 按这首曲子实际用到的音域选键盘（49/61/76/88），上下各留 3 个半音余量
    const MARGIN = 3;
    let lo = 127;
    let hi = 0;
    for (const n of state.notes) {
      if (n.midi < lo) lo = n.midi;
      if (n.midi > hi) hi = n.midi;
    }
    if (lo > hi) {
      lo = MIDI_LOW;
      hi = MIDI_HIGH;
    }
    const span = pickKeyboardSpan(Math.max(0, lo - MARGIN), Math.min(127, hi + MARGIN));
    setKeyRange(span.low, span.high);
    state.kbSpan = span;
  }

  const hiddenHands = new Set(); // 0=右手 1=左手，隐藏的那只手不画
  function setHandVisible(hand, visible) {
    if (visible) hiddenHands.delete(hand);
    else hiddenHands.add(hand);
  }

  /** 换一套键盘（49/61/76/88 或任意音域） */
  function setKeyRange(low, high) {
    kb = buildKeyboardRange(low, high);
    keys = kb.keys;
    keyboardW = kb.width;
    reindexKeys();
    rebuildOctaveLines();
    rebuildCLabels();
    markerLine.scale.x = keyboardW;
    bed.scale.x = keyboardW + 1.8;
    applyStaticPositions();
    fitCamera();
  }

  function setMeasureVisible(on) {
    measureMesh.visible = !!on;
    beatMesh.visible = !!on;
    for (const l of octaveLines) l.mesh.visible = !!on;
  }

  function layout2D(w, h) {
    const aspect = w / h || 1.7;
    const halfW = (keyboardW * 1.02) / 2;
    const halfH = halfW / aspect;
    const visibleH = halfH * 2;
    // 键盘高度按窗格高度的比例来（可拖拽），底部不留白：琴键直接贴窗格下沿
    const bottomMargin = 0;
    const keyDepth = Math.max(0.5, visibleH * keyFrac);
    const fallHeight = Math.max(2, visibleH - bottomMargin - keyDepth);
    view.halfW = halfW;
    view.visibleH = visibleH;
    view.fallHeight = fallHeight;
    view.keyDepth = keyDepth;
    return { halfW, halfH, visibleH, fallHeight, bottomMargin, keyDepth };
  }

  function fitCamera() {
    // headless 模式下 container 是 null，尺寸完全由 stage 分配的 rect 决定
    const w = rect ? rect.w : (container?.clientWidth || window.innerWidth);
    const h = rect ? rect.h : (container?.clientHeight || window.innerHeight);
    if (renderer) renderer.setSize(w, h);

    if (mode === '2d') {
      const { halfW, halfH, visibleH, fallHeight, bottomMargin } = layout2D(w, h);
      if (!(camera instanceof THREE.OrthographicCamera)) {
        camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 200);
      }
      // 注意：OrthographicCamera 的 left/right/top/bottom 是"相对相机中心的偏移"，
      // 不是世界坐标。相机放在内容中心，上下各半个视高。
      const worldBottom = -bottomMargin;
      const worldTop = worldBottom + visibleH;
      const centerY = (worldBottom + worldTop) / 2;
      camera.left = -halfW;
      camera.right = halfW;
      camera.bottom = -halfH;
      camera.top = halfH;
      camera.position.set(0, centerY, 40);
      camera.lookAt(0, centerY, 0);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      view.fallHeight = fallHeight;
    } else {
      camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 500);
      const vFov = THREE.MathUtils.degToRad(50);
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
      const dist = (keyboardW * 0.56) / Math.tan(hFov / 2);
      const pitch = THREE.MathUtils.degToRad(28);
      camera.position.set(0, 2.2 + Math.sin(pitch) * dist, Math.cos(pitch) * dist);
      camera.lookAt(0, 2.7, -0.9);
      camera.updateMatrixWorld();
      view.fallHeight = 9;
    }
    applyStaticPositions();
  }

  /** 与模式相关的固定物件位置（落点线、竖线、标签、键床、光晕高度） */
  function applyStaticPositions() {
    const is2d = mode === '2d';
    const baseY = is2d ? (view.keyDepth ?? KEY_DEPTH_FALLBACK) : KEY_H;
    // 2D 用平色，3D 用受光材质
    keyMesh.material = is2d ? keyMatFlat : keyMatLit;
    barMesh.material = is2d ? barMatFlat : barMatLit;
    markerLine.position.set(0, baseY, is2d ? 0.12 : 1.02);
    markerLine.scale.set(1, 1, 1);
    bed.visible = mode === '3d';
    for (const l of octaveLines) {
      l.mesh.position.set(l.x, baseY + view.fallHeight / 2, mode === '2d' ? 0.02 : -2.7);
      l.mesh.scale.set(1, view.fallHeight, 1);
      l.mesh.visible = octaveLines.length > 0 && measureMesh.visible;
    }
    for (const lb of labels) {
      lb.sprite.position.set(lb.x, is2d ? 0.95 : KEY_H + 0.05, is2d ? 0.15 : 1.1);
      const s = is2d ? 0.95 : 0.5;
      lb.sprite.scale.set(s * 2, s, 1);
      lb.sprite.visible = is2d;
    }
    for (const g of glowPool) {
      g.position.set(0, baseY, mode === '2d' ? 0.14 : 1.05);
      g.scale.set(1.6, mode === '2d' ? 0.9 : 1.6, 1);
    }
  }

  function setMode(next) {
    mode = next === '3d' ? '3d' : '2d';
    fitCamera();
  }

  /**
   * @param {number} scoreTime 曲内时间（秒）
   * @param {number} fallDuration 从顶到落点的时长（秒）
   */
  function update(scoreTime, fallDuration) {
    const notes = state.notes;
    const is2d = mode === '2d';
    const baseY = is2d ? (view.keyDepth ?? KEY_DEPTH_FALLBACK) : KEY_H;
    const H = view.fallHeight;
    const speed = H / Math.max(0.35, fallDuration);

    if (scoreTime < state.lastTime - 0.05) state.cursor = lowerBound(Math.max(0, scoreTime - state.maxDur));
    while (state.cursor < notes.length && notes[state.cursor].time + notes[state.cursor].dur <= scoreTime) {
      state.cursor++;
    }
    const lo = state.cursor;
    state.lastTime = scoreTime;
    const hi = upperBound(scoreTime + fallDuration);

    pressed.fill(0);
    let count = 0;
    let glowIndex = 0;

    for (let i = lo; i < hi; i++) {
      const n = notes[i];
      const key = keyByMidi[n.midi];
      if (!key) continue;
      if (hiddenHands.size && hiddenHands.has(n.hand)) continue;

      const bottom = (n.time - scoreTime) * speed;
      const top = (n.time + n.dur - scoreTime) * speed;
      if (top <= 0 || bottom > H) continue;

      const b = bottom > 0 ? bottom : 0;
      // 长音（踏板/全音符）不该变成一根顶到天的柱子
      const h = Math.min(top - b, H * 0.9);
      if (h < 0.02 || count >= MAX_BARS) continue;

      if (is2d) {
        dummy.position.set(key.x, baseY + b + h * 0.5, 0.06);
        dummy.scale.set(key.w * 0.92, h, 0.02);
      } else {
        dummy.position.set(key.x, baseY + b + h * 0.5, key.z);
        dummy.scale.set(key.w * 0.84, h, key.d * 0.5);
      }
      dummy.updateMatrix();
      barMesh.setMatrixAt(count, dummy.matrix);
      const bright = 0.6 + 0.4 * Math.min(1, n.vel ?? 0.8);
      tmpColor.copy(n.hand === 1 ? C_LH : C_RH).multiplyScalar(bright);
      barMesh.setColorAt(count, tmpColor);
      count++;

      // 落地瞬间：按键 + 光晕
      if (bottom <= 0) {
        pressed[n.midi] = 1;
        if (glowIndex < glowPool.length) {
          const g = glowPool[glowIndex++];
          const since = scoreTime - n.time; // 落地后经过的秒数
          const alpha = Math.max(0, 1 - since / 0.35);
          if (alpha > 0.02) {
            g.visible = true;
            g.position.set(key.x, baseY, g.position.z);
            g.material.opacity = 0.85 * alpha;
            const s = 1.6 + 0.5 * (1 - alpha);
            g.scale.set(s, s * 0.55, 1);
          }
        }
      }
    }
    for (let i = glowIndex; i < glowPool.length; i++) glowPool[i].visible = false;

    barMesh.count = count;
    barMesh.instanceMatrix.needsUpdate = true;
    barMesh.instanceColor.needsUpdate = true;

    // ---- 小节线 / 拍点线 ----
    if (measureMesh.visible) {
      let mcount = 0;
      for (let i = 0; i < state.measures.length && mcount < MAX_MEASURE_LINES; i++) {
        const y = (state.measures[i] - scoreTime) * speed;
        if (y < 0) continue;
        if (y > H) break;
        dummy.position.set(0, baseY + y + MEASURE_THICK / 2, is2d ? 0.04 : -2.7);
        dummy.scale.set(keyboardW, MEASURE_THICK, 0.04);
        dummy.updateMatrix();
        measureMesh.setMatrixAt(mcount, dummy.matrix);
        measureMesh.setColorAt(mcount, C_MEASURE);
        mcount++;
      }
      measureMesh.count = mcount;
      measureMesh.instanceMatrix.needsUpdate = true;
      measureMesh.instanceColor.needsUpdate = true;

      let bcount = 0;
      for (let i = 0; i < state.beats.length && bcount < MAX_MEASURE_LINES * 4; i++) {
        const y = (state.beats[i] - scoreTime) * speed;
        if (y < 0) continue;
        if (y > H) break;
        dummy.position.set(0, baseY + y + 0.01, is2d ? 0.03 : -2.69);
        dummy.scale.set(keyboardW, BEAT_THICK, 0.03);
        dummy.updateMatrix();
        beatMesh.setMatrixAt(bcount, dummy.matrix);
        beatMesh.setColorAt(bcount, C_BEAT);
        bcount++;
      }
      beatMesh.count = bcount;
      beatMesh.instanceMatrix.needsUpdate = true;
      beatMesh.instanceColor.needsUpdate = true;
    }

    // ---- 琴键 ----
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (is2d) {
        // 俯视：白键从 y=0 伸到键盘上沿；黑键占后半段
        const kd = view.keyDepth ?? KEY_DEPTH_FALLBACK;
        if (k.black) {
          const d = kd * 0.58;
          dummy.position.set(k.x, kd - d / 2, 0.02);
          dummy.scale.set(k.w, d, 0.02);
        } else {
          dummy.position.set(k.x, kd / 2, 0);
          dummy.scale.set(k.w, kd, 0.02);
        }
      } else {
        const down = pressed[k.midi] ? (k.black ? 0.08 : 0.055) : 0;
        dummy.position.set(k.x, k.h * 0.5 - down, k.z);
        dummy.scale.set(k.w, k.h, k.d);
      }
      dummy.updateMatrix();
      keyMesh.setMatrixAt(i, dummy.matrix);

      tmpColor.copy(k.black ? C_BLACK : C_WHITE);
      if (!k.black && k.midi % 12 === 0) tmpColor.lerp(C_WHITE_HIT, 0.1);
      if (pressed[k.midi]) tmpColor.lerp(k.black ? C_BLACK_HIT : C_WHITE_HIT, 0.85);
      keyMesh.setColorAt(i, tmpColor);
    }
    keyMesh.count = keys.length;
    keyMesh.instanceMatrix.needsUpdate = true;
    keyMesh.instanceColor.needsUpdate = true;
  }

  function draw() {
    if (renderer) renderer.render(scene, camera);
  }

  /** 由舞台分配窗格位置（CSS px，左上角原点） */
  function setRect(next) {
    rect = next;
    fitCamera();
  }

  // InstancedMesh 的包围球是懒计算的（第一帧按当时实例算），之后实例移出旧球
  // 就会被整个剔除。这层每帧都在动，直接关掉视锥剔除。
  for (const m of [keyMesh, barMesh, measureMesh, beatMesh]) m.frustumCulled = false;

  applyStaticPositions();
  fitCamera();

  return {
    kind: 'piano',
    setScore,
    setMeasureVisible,
    setHandVisible,
    // 键盘高度（占窗格高度的比例），拖键盘上沿时调用
    setKeyFrac(f) {
      const next = Math.min(KEY_FRAC_MAX, Math.max(KEY_FRAC_MIN, Number(f) || keyFrac));
      if (Math.abs(next - keyFrac) < 1e-4) return;
      keyFrac = next;
      fitCamera();
    },
    getKeyFrac: () => keyFrac,
    setMode,
    setRect,
    getScene: () => scene,
    getCamera: () => camera,
    getMode: () => mode,
    getKey: (midi) => keyByMidi[midi] || null,
    getKeyIndex: (midi) => keys.findIndex((k) => k.midi === midi),
    getKeyboard: () => ({
      low: kb.low,
      high: kb.high,
      width: keyboardW,
      count: keys.length,
      span: state.kbSpan ?? null,
    }),
    /** 给测试和调试用：当前模式的关键尺寸 */
    getView: () => ({
      mode,
      baseY: mode === '2d' ? (view.keyDepth ?? KEY_DEPTH_FALLBACK) : KEY_H,
      keyDepth: view.keyDepth ?? KEY_DEPTH_FALLBACK,
      keyFrac,
      fallHeight: view.fallHeight,
      visibleH: view.visibleH,
    }),
    /** 排错用：把相机和第一个键的矩阵摊开看 */
    debug: () => {
      const m = new THREE.Matrix4();
      keyMesh.getMatrixAt(0, m);
      const p = new THREE.Vector3();
      const s = new THREE.Vector3();
      const q = new THREE.Quaternion();
      m.decompose(p, q, s);
      return {
        mode,
        view: { ...view },
        cam: {
          left: camera.left, right: camera.right, top: camera.top, bottom: camera.bottom,
          pos: camera.position ? camera.position.toArray() : null,
        },
        key0: { pos: p.toArray(), scale: s.toArray() },
        visible: { key: keyMesh.visible, bars: barMesh.visible, measures: measureMesh.visible },
        counts: { bars: barMesh.count, measures: measureMesh.count, beats: beatMesh.count },
      };
    },
    update,
    fitCamera,
    draw,
    renderer,
    keys,
  };
}