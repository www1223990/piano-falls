// 舞台：一个 WebGL 画布 + N 个自由窗格（lane）。
// 每个窗格有自己的场景和相机，渲染时用 viewport + scissor 切到自己的矩形里，
// 所以"多乐器"只是多画几次，不需要多个画布（浏览器对 WebGL 上下文数量有限制）。
//
// 窗格不再按"权重分栏"，而是各有自由矩形 {x,y,w,h}；重叠时按 z 序绘制。
// 预设（分栏/并排/网格）只是批量算一次矩形。

import * as THREE from 'three';
import { createStage as createPianoLane } from './waterfall.js';
import { createStringsLane } from './lane-strings.js';

const MIN_W = 260;
const MIN_H = 110;
let topInset = 96;     // 左上角 HUD
let bottomInset = 168; // 底部控制面板（控制栏收起时变小）
const HEAD_H = 26;        // 窗格标题栏高度（内容要让出来）
const PANE_BG = 0x080d16;
const LS_KEY = 'piano-falls:layout';

export function createStage(container, { mode = '2d' } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearAlpha(1);
  container.appendChild(renderer.domElement);

  let lanes = []; // { lane, spec, rect, z, hidden, index }
  let mode2d = mode !== '3d';
  let layoutMode = 'split-v';
  let zTop = 1;
  // 载入乐谱时算出来的初始布局不该覆盖用户存好的布局，只在用户操作后写盘
  let persistEnabled = false;
  let size = { w: container.clientWidth || window.innerWidth, h: container.clientHeight || window.innerHeight };

  function disposeLanes() {
    for (const item of lanes) {
      try {
        item.lane.dispose?.();
      } catch {
        /* ignore */
      }
    }
    lanes = [];
  }

  function persist() {
    if (!persistEnabled) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        mode: layoutMode,
        count: lanes.length,
        panes: lanes.map((l) => ({ hidden: l.hidden, rect: l.rect })),
      }));
    } catch {
      /* 没有 localStorage 就算了，不影响使用 */
    }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || data.count !== lanes.length) return false;
      lanes.forEach((l, i) => {
        const saved = data.panes?.[i];
        if (!saved) return;
        l.hidden = !!saved.hidden;
        if (saved.rect) l.rect = saved.rect;
      });
      layoutMode = data.mode || 'split-v';
      recompute();
      return true;
    } catch {
      return false;
    }
  }

  function resetLayout() {
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* ignore */
    }
    lanes.forEach((l) => {
      l.hidden = false;
    });
    layoutMode = 'split-v';
    recompute();
  }

  function area() {
    return {
      x: 0,
      y: topInset,
      w: Math.max(MIN_W, size.w),
      h: Math.max(MIN_H * 2, size.h - topInset - bottomInset),
    };
  }

  function clampRect(r) {
    const a = area();
    const w = Math.max(MIN_W, Math.min(r.w, a.w));
    const h = Math.max(MIN_H, Math.min(r.h, a.h));
    const x = Math.max(a.x, Math.min(r.x, a.x + a.w - w));
    const y = Math.max(a.y, Math.min(r.y, a.y + a.h - h));
    return { x, y, w, h };
  }

  function setScore(score) {
    disposeLanes();
    const specs = score.lanes?.length
      ? score.lanes
      : [{ kind: 'piano', name: score.name || '钢琴', notes: score.notes }];

    specs.forEach((spec, index) => {
      let lane;
      if (spec.kind === 'strings') {
        lane = createStringsLane({ family: familyFromSpec(spec), laneName: spec.name });
        lane.setScore(spec);
      } else {
        lane = createPianoLane(null, { mode: mode2d ? '2d' : '3d', headless: true });
        lane.setScore({ notes: spec.notes, measures: score.measures ?? [], beats: score.beats ?? [] });
      }
      lanes.push({
        lane,
        spec,
        weight: spec.kind === 'piano' ? 1.3 : 1,
        hidden: false,
        index,
        z: ++zTop,
        rect: null,
      });
    });

    // 先按默认分栏算一遍，再看有没有用户存好的布局；载入期间不写盘
    layoutMode = 'split-v';
    persistEnabled = false;
    if (!restore()) recompute();
    persistEnabled = true;
  }

  function familyFromSpec(spec) {
    const names = spec.stringNames ?? ['G', 'D', 'A', 'E'];
    const opens = spec.stringOpens ?? [55, 62, 69, 76];
    return { name: spec.familyName || spec.name, strings: names.map((n, i) => ({ name: n, open: opens[i] })) };
  }

  /** 按当前预设重算所有窗格矩形 */
  function recompute() {
    size = { w: container.clientWidth || window.innerWidth, h: container.clientHeight || window.innerHeight };
    renderer.setSize(size.w, size.h);
    const a = area();
    const visible = lanes.filter((l) => !l.hidden);
    if (!visible.length) return;

    if (layoutMode === 'free') {
      for (const item of visible) item.rect = clampRect(item.rect ?? a);
    } else if (layoutMode === 'split-v' || layoutMode === 'split-h') {
      const total = visible.reduce((s, l) => s + l.weight, 0) || 1;
      let p = 0;
      for (const item of visible) {
        const frac = item.weight / total;
        if (layoutMode === 'split-v') {
          const h = Math.max(MIN_H, a.h * frac);
          item.rect = { x: a.x, y: a.y + p, w: a.w, h };
          p += h;
        } else {
          const w = Math.max(MIN_W, a.w * frac);
          item.rect = { x: a.x + p, y: a.y, w, h: a.h };
          p += w;
        }
      }
    } else {
      // 网格
      const n = visible.length;
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const cw = a.w / cols;
      const ch = a.h / rows;
      visible.forEach((item, i) => {
        const c = i % cols;
        const r = Math.floor(i / cols);
        item.rect = { x: a.x + c * cw, y: a.y + r * ch, w: cw, h: ch };
      });
    }

    // 内容矩形要让出标题栏，否则瀑布被标题栏压住
    for (const item of visible) item.lane.setRect({ x: item.rect.x, y: item.rect.y + HEAD_H, w: item.rect.w, h: Math.max(60, item.rect.h - HEAD_H) });
    persist();
  }

  function setLayout(next) {
    layoutMode = next;
    recompute();
  }

  /** 手动改一个窗格的矩形（拖动/缩放），自动进入自由模式 */
  function setPaneRect(index, rect) {
    const item = lanes.find((l) => l.index === index);
    if (!item) return;
    item.rect = clampRect(rect);
    layoutMode = 'free';
    item.lane.setRect({ x: item.rect.x, y: item.rect.y + HEAD_H, w: item.rect.w, h: Math.max(60, item.rect.h - HEAD_H) });
    persist();
  }

  function setWeights(weights) {
    lanes.forEach((item, i) => {
      if (typeof weights[i] === 'number') item.weight = Math.max(0.15, weights[i]);
    });
    if (layoutMode === 'free') layoutMode = 'split-v';
    recompute();
  }

  function bringToFront(index) {
    const item = lanes.find((l) => l.index === index);
    if (item) item.z = ++zTop;
  }

  function showLane(index, visible) {
    const item = lanes.find((l) => l.index === index);
    if (!item) return;
    item.hidden = !visible;
    if (visible) item.z = ++zTop;
    recompute();
    persist();
  }

  function getPanes() {
    return lanes.map((item) => ({
      index: item.index,
      name: item.spec.name,
      kind: item.spec.kind,
      family: item.spec.familyName || '',
      hidden: item.hidden,
      rect: item.rect,
      z: item.z,
      weight: item.weight,
      layout: layoutMode,
    }));
  }

  function setMode(next) {
    mode2d = next !== '3d';
    for (const item of lanes) item.lane.setMode?.(mode2d ? '2d' : '3d');
    recompute();
  }

  function setMeasureVisible(on) {
    for (const item of lanes) item.lane.setMeasureVisible?.(on);
  }

  /** 只对钢琴（键盘）窗格有意义：显示/隐藏某只手 */
  function setHandVisible(hand, visible) {
    for (const item of lanes) item.lane.setHandVisible?.(hand, visible);
  }

  /** 键盘高度（占窗格高度比例），拖键盘上沿时调用 */
  function setKeyFrac(f) {
    for (const item of lanes) item.lane.setKeyFrac?.(f);
  }

  function getKeyFrac() {
    const item = lanes.find((l) => l.lane.setKeyFrac);
    return item?.lane.getKeyFrac?.() ?? 0.28;
  }

  /** 舞台上下留白：底部控制栏收起时把它变小，窗格就能往下长 */
  function setInsets(top, bottom) {
    if (Number.isFinite(top)) topInset = top;
    if (Number.isFinite(bottom)) bottomInset = bottom;
    recompute();
  }

  function getInsets() {
    return { top: topInset, bottom: bottomInset };
  }

  function update(scoreTime, fallDuration) {
    for (const item of lanes) {
      if (item.hidden || !item.rect) continue;
      item.lane.update(scoreTime, fallDuration);
    }
  }

  function draw() {
    renderer.setScissorTest(false);
    renderer.setClearColor(PANE_BG, 1);
    renderer.clear();
    renderer.setScissorTest(true);
    const H = size.h;
    // 按 z 从小到大画，后画的盖住先画的
    const ordered = lanes.filter((l) => !l.hidden && l.rect).sort((a, b) => a.z - b.z);
    for (const item of ordered) {
      const { x, y, w, h } = item.rect;
      const glY = H - y - h;
      renderer.setViewport(x, glY, w, h);
      renderer.setScissor(x, glY, w, h);
      renderer.clear(); // 每个窗格先铺自己的底色，重叠时才像"窗口"
      renderer.render(item.lane.getScene(), item.lane.getCamera());
    }
    renderer.setScissorTest(false);
  }

  renderer.setSize(size.w, size.h);

  return {
    setScore,
    setMode,
    getMode: () => (mode2d ? '2d' : '3d'),
    setMeasureVisible,
    setHandVisible,
    setKeyFrac,
    getKeyFrac,
    setInsets,
    getInsets,
    setLayout,
    resetLayout,
    getLayout: () => layoutMode,
    setPaneRect,
    setWeights,
    bringToFront,
    showLane,
    getPanes,
    resize: recompute,
    update,
    draw,
    renderer,
    getArea: area,
    minSize: { w: MIN_W, h: MIN_H },
    dispose: disposeLanes,
    debug: () =>
      lanes.map((item) => ({
        kind: item.spec.kind,
        name: item.spec.name,
        hidden: item.hidden,
        rect: item.rect,
        z: item.z,
        ...(item.lane.debug?.() ?? {}),
      })),
  };
}