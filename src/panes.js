// 窗格外壳（像桌面窗口）：标题栏拖动移动、右下角拖动缩放、× 关闭、z 序。
// 真正的内容是 WebGL 画在画布上，这里只放 DOM 外框和交互。
//
// 布局预设（分栏 / 并排 / 网格）在 stage 里算矩形，这里只负责把 DOM 跟上去。

const MIN_W = 260;
const MIN_H = 110;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createPanes(container, { stage }) {
  const root = document.createElement('div');
  root.id = 'panes';
  container.appendChild(root);

  const list = document.createElement('div');
  list.id = 'paneList';
  list.hidden = true;
  document.body.appendChild(list);

  const els = new Map(); // index -> { el, head, resize }

  function build() {
    const panes = stage.getPanes();
    // 清掉已不存在的
    for (const [index, entry] of [...els]) {
      if (!panes.some((p) => p.index === index)) {
        entry.el.remove();
        els.delete(index);
      }
    }
    for (const p of panes) {
      if (els.has(p.index)) continue;
      const el = document.createElement('div');
      el.className = 'pane';

      const head = document.createElement('div');
      head.className = 'pane-head';
      head.innerHTML =
        `<span class="pane-name">${esc(p.name)}</span>` +
        `<span class="pane-kind">${p.kind === 'strings' ? '指板' : '键盘'}</span>` +
        `<span class="pane-close" title="关闭这个窗格">×</span>`;

      const resize = document.createElement('div');
      resize.className = 'pane-resize';
      resize.title = '拖动改变大小';

      el.append(head, resize);
      root.appendChild(el);

      els.set(p.index, { el, head, resize });
      bindDrag(p.index, head);
      bindResize(p.index, resize);
      head.querySelector('.pane-close').addEventListener('click', (ev) => {
        ev.stopPropagation();
        stage.showLane(p.index, false);
        refresh();
      });
    }
    position();
    buildList();
  }

  function position() {
    const panes = stage.getPanes();
    let minZ = Infinity;
    for (const p of panes) if (!p.hidden) minZ = Math.min(minZ, p.z);
    for (const p of panes) {
      const entry = els.get(p.index);
      if (!entry) continue;
      if (p.hidden || !p.rect) {
        entry.el.style.display = 'none';
        continue;
      }
      entry.el.style.display = 'block';
      entry.el.style.left = `${p.rect.x}px`;
      entry.el.style.top = `${p.rect.y}px`;
      entry.el.style.width = `${p.rect.w}px`;
      entry.el.style.height = `${p.rect.h}px`;
      // DOM 的 z 跟着舞台的 z，重叠时才和 WebGL 绘制顺序一致
      entry.el.style.zIndex = String(10 + (p.z - (Number.isFinite(minZ) ? minZ : 0)));
    }
  }

  function paneOf(index) {
    return stage.getPanes().find((p) => p.index === index);
  }

  function bindDrag(index, head) {
    head.addEventListener('pointerdown', (ev) => {
      if (ev.target.classList?.contains('pane-close')) return;
      const pane = paneOf(index);
      if (!pane || !pane.rect) return;
      ev.preventDefault();
      stage.bringToFront(index);
      position();
      const sx = ev.clientX;
      const sy = ev.clientY;
      const start = { ...pane.rect };
      try {
        head.setPointerCapture?.(ev.pointerId);
      } catch {
        /* ignore */
      }
      const move = (e) => {
        stage.setPaneRect(index, {
          x: start.x + (e.clientX - sx),
          y: start.y + (e.clientY - sy),
          w: start.w,
          h: start.h,
        });
        position();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function bindResize(index, handle) {
    handle.addEventListener('pointerdown', (ev) => {
      const pane = paneOf(index);
      if (!pane || !pane.rect) return;
      ev.preventDefault();
      ev.stopPropagation();
      stage.bringToFront(index);
      const sx = ev.clientX;
      const sy = ev.clientY;
      const start = { ...pane.rect };
      try {
        handle.setPointerCapture?.(ev.pointerId);
      } catch {
        /* ignore */
      }
      const move = (e) => {
        stage.setPaneRect(index, {
          x: start.x,
          y: start.y,
          w: Math.max(MIN_W, start.w + (e.clientX - sx)),
          h: Math.max(MIN_H, start.h + (e.clientY - sy)),
        });
        position();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function buildList() {
    const panes = stage.getPanes();
    list.innerHTML =
      '<h3>窗格</h3>' +
      panes
        .map(
          (p) =>
            `<label class="pane-item"><input type="checkbox" data-index="${p.index}" ${p.hidden ? '' : 'checked'}/>` +
            `<span>${esc(p.name)}</span><span class="pane-item-kind">${p.kind === 'strings' ? '指板' : '键盘'}</span></label>`,
        )
        .join('') +
      '<button id="resetLayout" class="pane-reset">重置布局</button>';

    list.querySelector('#resetLayout')?.addEventListener('click', () => {
      stage.resetLayout();
      refresh();
    });
    for (const cb of list.querySelectorAll('input[type=checkbox]')) {
      cb.addEventListener('change', (e) => {
        stage.showLane(Number(e.target.dataset.index), e.target.checked);
        refresh();
      });
    }
  }

  function setLayout(kind) {
    stage.setLayout(kind);
    position();
    buildList();
  }

  function refresh() {
    // 换谱子后窗格的名字/数量都可能变，DOM 不能按 index 复用，整批重建
    for (const [, entry] of els) entry.el.remove();
    els.clear();
    build();
  }

  function relayout() {
    position();
  }

  function toggleList(force) {
    const next = force ?? list.hidden;
    list.hidden = !next;
    if (next) buildList();
  }

  build();
  return { refresh, relayout, setLayout, toggleList, position };
}