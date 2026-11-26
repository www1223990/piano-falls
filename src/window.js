// 一个通用的"窗口"行为：标题栏拖动、右下角缩放、× 关闭、双击标题栏最大化，
// 位置/大小/开关状态存 localStorage。
//
// 用法：DOM 里有 .win-head（标题栏，里面放 .win-close）和 .win-resize（右下角手柄），
// 内容放 .win-body 里。和乐器窗格不同，这个是纯 DOM 窗口，不涉及 WebGL。

const MIN_W = 220;
const MIN_H = 120;
const MARGIN = 8;

export function makeWindow(el, { key, defaultOpen = true, minW = MIN_W, minH = MIN_H, onChange = null } = {}) {
  const head = el.querySelector('.win-head');
  const closeBtn = el.querySelector('.win-close');
  const resize = el.querySelector('.win-resize');

  let rect = null; // { x, y, w, h }
  let open = defaultOpen;
  let prevRect = null; // 最大化前的位置
  let maximized = false;

  function viewport() {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  function load() {
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data?.rect && Number.isFinite(data.rect.x)) rect = data.rect;
      if (typeof data?.open === 'boolean') open = data.open;
    } catch {
      /* ignore */
    }
  }

  function save() {
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({ rect, open }));
    } catch {
      /* ignore */
    }
  }

  function clamp() {
    if (!rect) {
      const r = el.getBoundingClientRect();
      rect = { x: r.left, y: r.top, w: r.width || 330, h: r.height || 360 };
    }
    const vp = viewport();
    rect.w = Math.min(Math.max(minW, rect.w), vp.w - MARGIN * 2);
    rect.h = Math.min(Math.max(minH, rect.h), vp.h - MARGIN * 2);
    rect.x = Math.min(Math.max(MARGIN, rect.x), Math.max(MARGIN, vp.w - rect.w - MARGIN));
    rect.y = Math.min(Math.max(MARGIN, rect.y), Math.max(MARGIN, vp.h - rect.h - MARGIN));
  }

  function apply() {
    clamp();
    el.style.left = `${rect.x}px`;
    el.style.top = `${rect.y}px`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
  }

  function setOpen(next) {
    open = next;
    el.classList.toggle('on', open);
    if (open) apply();
    save();
    onChange?.(open);
  }

  function toggle() {
    setOpen(!open);
    return open;
  }

  function maximize() {
    if (maximized) {
      rect = prevRect ?? rect;
      maximized = false;
    } else {
      prevRect = { ...rect };
      const vp = viewport();
      rect = { x: MARGIN, y: MARGIN, w: vp.w - MARGIN * 2, h: vp.h - MARGIN * 2 };
      maximized = true;
    }
    apply();
    save();
  }

  // ---- 拖动标题栏 ----
  head?.addEventListener('pointerdown', (ev) => {
    if (ev.target.classList?.contains('win-close')) return;
    if (ev.detail === 2) return; // 双击交给 dblclick 处理
    ev.preventDefault();
    el.style.zIndex = String(Number(el.style.zIndex || 0) + 1);
    const sx = ev.clientX;
    const sy = ev.clientY;
    const start = { ...rect };
    try {
      head.setPointerCapture?.(ev.pointerId);
    } catch {
      /* ignore */
    }
    const move = (e) => {
      rect = { ...rect, x: start.x + (e.clientX - sx), y: start.y + (e.clientY - sy) };
      apply();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      save();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // 双击标题栏：最大化 / 还原（和 Windows 一致）
  head?.addEventListener('dblclick', (ev) => {
    if (ev.target.classList?.contains('win-close')) return;
    maximize();
  });

  // ---- 右下角缩放 ----
  resize?.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const sx = ev.clientX;
    const sy = ev.clientY;
    const start = { ...rect };
    try {
      resize.setPointerCapture?.(ev.pointerId);
    } catch {
      /* ignore */
    }
    const move = (e) => {
      rect = { ...rect, w: start.w + (e.clientX - sx), h: start.h + (e.clientY - sy) };
      apply();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      save();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  closeBtn?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    setOpen(false);
  });

  window.addEventListener('resize', () => {
    if (open) apply();
  });

  load();
  el.classList.toggle('on', open);
  if (open) apply();

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle,
    isOpen: () => open,
    maximize,
    save,
  };
}