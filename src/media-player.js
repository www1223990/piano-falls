// 基于 <audio> 元素的播放器：变速时**由浏览器做时域伸缩、保持音高**
// （HTMLMediaElement.preservesPitch，YouTube 那种变速不变调）。
//
// 为什么不用 AudioBufferSourceNode：它只有 playbackRate（变速同时变调），
// 要做不变调就得自己写 phase vocoder / 引 soundtouch 之类，属于重复造轮子。
//
// 多轨同步（重要，踩过坑）：
//   换分轨那一刻两条 <audio> 的起播时刻可能差 60~80ms（解码/调度抖动）。
//   以前的做法是每秒检查一次、跑偏就 `el.currentTime = master` —— 这是错的：
//   实测**对正在播放的 <audio> 写 currentTime 会让它停顿 56~68ms**
//   （等于偏差量），于是"修好"的下一秒偏差又回来 → 每秒卡一下、永远修不好。
//   现在的做法：只测一次偏差，然后用 WebAudio 的 DelayNode 把"早的那条"延后
//   同一个量（改 delayTime 不会让媒体元素停顿，实测 300ms 内时钟照常走 0.302s）。
//   静音仍然是 `el.volume`（经过 MediaElementSource 后依然生效，已实测）。
//
// 接口和 AudioPlayer / StemPlayer 保持一致，main.js 可以无缝替换。

const ALIGN_MIN = 0.02; // 差 20ms 以内就不碰音频通路（已经听不出先后）

export class MediaPlayer {
  constructor() {
    this.tracks = new Map(); // key -> { el, url, muted }
    this.rate = 1;
    this.volumeDb = -6;
    this.duration = 0;
    this.startOffset = 0;
    this.playing = false;
    this.pendingUntil = 0; // 预备段（延迟起播）结束的 wall clock 时间
    this.pendingFrom = 0;
    this.alignTimers = [];
    this.watchTimer = null;
    this.graph = null; // 多轨对齐用的 WebAudio 链路（只有真的跑偏了才建）
    this.masterKey = null;
    this.masterDelay = 0;

    // main.js 里有 `player.ctx.state === 'suspended'` 之类的判断，给个等价物。
    // <audio> 被浏览器拦下自动播放时，把 state 置为 suspended，界面就会提示"点一下播放"。
    this.ctx = {
      state: 'running',
      resume: async () => {
        this.ctx.state = 'running';
        for (const t of this.tracks.values()) {
          const p = t.el.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      },
      currentTime: 0,
    };
  }

  static supported() {
    return typeof Audio !== 'undefined';
  }

  get ready() {
    return this.tracks.size > 0;
  }

  get keys() {
    return [...this.tracks.keys()];
  }

  /** @param {Uint8Array|Array<{key:string|number, bytes:Uint8Array}>} input */
  async load(input) {
    this.dispose();
    const stems = Array.isArray(input) ? input : [{ key: 'mix', bytes: input }];
    for (const stem of stems) {
      const url = URL.createObjectURL(new Blob([stem.bytes], { type: 'audio/mpeg' }));
      const el = new Audio();
      el.preload = 'auto';
      el.preservesPitch = true; // 变速不变调：交给浏览器
      el.src = url;
      el.load();
      // 元数据可能比兜底超时来得晚：一到就更新总时长，别把 duration 锁死在 0
      el.addEventListener('loadedmetadata', () => {
        const d = Number.isFinite(el.duration) ? el.duration : 0;
        if (d > this.duration) this.duration = d;
      });
      await new Promise((resolve) => {
        const done = () => resolve();
        el.addEventListener('loadedmetadata', done, { once: true });
        el.addEventListener('error', done, { once: true });
        setTimeout(done, 4000); // 兜底：元数据迟迟不来也别卡死
      });
      this.tracks.set(String(stem.key), { el, url, muted: false });
      // mp3 的 duration 是浏览器按码率估的，可能比真实长度短几秒；
      // 真结尾以 ended 事件为准，别用 duration 判断"播完了"。
      el.addEventListener('ended', () => {
        this.finished = true;
      });
      const d = Number.isFinite(el.duration) ? el.duration : 0;
      if (d > this.duration) this.duration = d;
    }
    this.setVolumeDb(this.volumeDb);
    this.setRate(this.rate);
    this.startOffset = 0;
    return this.duration;
  }

  /**
   * 等所有轨"能立刻出声"（canplaythrough）。
   * load() 只等元数据；带着"还没缓冲好"的状态起播，几条轨的起播时刻就会差几十毫秒。
   */
  async ready(timeout = 2500) {
    const els = this._els();
    if (!els.length) return false;
    await Promise.all(
      els.map(
        (el) =>
          new Promise((resolve) => {
            if (el.readyState >= 3) return resolve();
            const done = () => resolve();
            el.addEventListener('canplaythrough', done, { once: true });
            setTimeout(done, timeout);
          }),
      ),
    );
    return els.every((el) => el.readyState >= 3);
  }

  /** 某个声部静音（0 = 静音，1 = 正常） */
  setMute(key, muted) {
    const t = this.tracks.get(String(key));
    if (!t) return;
    t.muted = !!muted;
    t.el.volume = t.muted ? 0 : this._linear();
  }

  setVolumeDb(db) {
    this.volumeDb = db;
    const v = this._linear();
    for (const t of this.tracks.values()) t.el.volume = t.muted ? 0 : v;
  }

  _linear() {
    return Math.max(0, Math.min(1, Math.pow(10, this.volumeDb / 20)));
  }

  /** 变速（1 = 原速）。preservesPitch 保证音高不变 */
  setRate(rate) {
    const r = Math.max(0.25, Math.min(2, Number(rate) || 1));
    this.rate = r;
    // 原速时把时间伸缩彻底关掉：走原生直通，避免浏览器内部重采样带来的
    // 微小速度偏差（实测开启时 0.9985×，播久了画面和声音会慢慢分开）
    const stretch = Math.abs(r - 1) > 1e-3;
    for (const t of this.tracks.values()) {
      t.el.preservesPitch = stretch;
      t.el.playbackRate = r;
    }
    return r;
  }

  time() {
    if (!this.duration) return 0;
    if (this.pendingUntil > performance.now()) {
      // 预备段：从 from 往回倒数的负时间，画面才能看到音符从顶端落下
      const left = (this.pendingUntil - performance.now()) / 1000;
      return this.pendingFrom - left * this.rate;
    }
    if (!this.playing) return this.startOffset;
    const master = this.tracks.get(this.masterKey) ?? this.tracks.values().next().value;
    const raw = master?.el.currentTime ?? this.startOffset;
    // 主轨可能被 delay 链延后过：画面要跟"听到的"那一刻，而不是元素的媒体时间
    return raw - (this.graph ? this.masterDelay : 0);
  }

  play({ delay = 0, from = null } = {}) {
    if (!this.duration) {
      // 兜底：元数据晚到时也从元素里再取一次时长
      for (const t of this.tracks.values()) {
        const d = Number.isFinite(t.el.duration) ? t.el.duration : 0;
        if (d > this.duration) this.duration = d;
      }
    }
    if (!this.duration) return;
    if (from !== null) this.startOffset = Math.max(0, Math.min(this.duration - 0.02, from));
    if (this.playing) return;

    this.finished = false;
    const startAll = () => {
      for (const t of this.tracks.values()) {
        try {
          t.el.currentTime = this.startOffset;
        } catch {
          /* ignore */
        }
        const p = t.el.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => {
            // 没有用户手势时浏览器会拒绝播放：标记出来，界面提示"点一下播放"
            this.ctx.state = 'suspended';
          });
        }
      }
      this.playing = true;
      // 起播后再量一次偏差并纠正（只改 WebAudio delay，不 seek）
      this._scheduleAlign(400);
      this._scheduleAlign(2500);
      this._startWatch();
    };

    if (delay > 0.02) {
      this.pendingFrom = this.startOffset;
      this.pendingUntil = performance.now() + delay * 1000;
      this.playing = true; // 逻辑上已经在"播放"，只是还在预备段
      setTimeout(() => {
        if (!this.playing) return;
        this.pendingUntil = 0;
        startAll();
      }, delay * 1000);
    } else {
      this.pendingUntil = 0;
      startAll();
    }
  }

  pause() {
    this.pendingUntil = 0;
    if (!this.playing) return;
    this.startOffset = Math.max(0, Math.min(this.duration, this.time()));
    for (const t of this.tracks.values()) t.el.pause();
    this.playing = false;
    this._clearAlign();
    this._stopWatch();
  }

  seek(t) {
    const was = this.playing;
    this.pendingUntil = 0;
    this._clearAlign();
    this._stopWatch();
    for (const el of this._els()) el.pause();
    this.playing = false;
    this.startOffset = Math.max(0, Math.min(this.duration, t));
    for (const el of this._els()) {
      try {
        el.currentTime = this.startOffset;
      } catch {
        /* ignore */
      }
    }
    if (was) this.play({ delay: 0 });
  }

  stop() {
    this.pendingUntil = 0;
    this._clearAlign();
    this._stopWatch();
    for (const t of this.tracks.values()) {
      t.el.pause();
      try {
        t.el.currentTime = 0;
      } catch {
        /* ignore */
      }
    }
    this.playing = false;
    this.startOffset = 0;
  }

  _els() {
    return [...this.tracks.values()].map((t) => t.el);
  }

  /** 各轨"正在发声的媒体时间"（媒体时钟 - 已加的延迟）*/
  _soundTimes() {
    return [...this.tracks.entries()].map(([key, t]) => {
      const node = this.graph?.nodes.get(key);
      return { key, el: t.el, delay: node?.sec ?? 0, sound: t.el.currentTime - (node?.sec ?? 0) };
    });
  }

  /** 现在各轨之间的最大偏差（秒）；单轨/未接线时返回 0 */
  syncSpread() {
    const items = this._soundTimes();
    if (items.length < 2) return 0;
    const ss = items.map((i) => i.sound);
    return Math.max(...ss) - Math.min(...ss);
  }

  /**
   * 只在真的跑偏时才建 WebAudio 链路：每个 <audio> → DelayNode → destination。
   * 走得开就不碰音频通路（少一层风险）。
   */
  _ensureGraph() {
    if (this.graph) return this.graph;
    if (this.tracks.size < 2) return null;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    const ctx = new AC({ latencyHint: 'interactive' });
    const nodes = new Map();
    for (const [key, t] of this.tracks) {
      try {
        const src = ctx.createMediaElementSource(t.el);
        const delay = ctx.createDelay(0.5);
        src.connect(delay).connect(ctx.destination);
        nodes.set(key, { src, delay, sec: 0 });
      } catch {
        // 一个元素一生只能接一次 WebAudio；接不上就退回"不对齐"，千万别 seek
      }
    }
    if (!nodes.size) {
      ctx.close?.().catch?.(() => {});
      return null;
    }
    ctx.resume?.().catch?.(() => {});
    this.graph = { ctx, nodes };
    this.masterKey = [...nodes.keys()][0];
    this.masterDelay = 0;
    return this.graph;
  }

  /**
   * 对齐一次：以最慢的一轨为基准，给其它轨加 delay。
   * 注意这里**只写 delayTime**，不写 currentTime（写 currentTime 会让元素停顿）。
   */
  _alignTracks() {
    if (!this.playing) return;
    if (this.tracks.size < 2) return;
    const items = this._soundTimes();
    const spread = Math.max(...items.map((i) => i.sound)) - Math.min(...items.map((i) => i.sound));
    if (spread <= ALIGN_MIN) return; // 已经齐了，别动

    const g = this._ensureGraph();
    if (!g) return;
    const wired = this._soundTimes();
    if (wired.some((i) => !g.nodes.has(i.key))) return;
    const target = Math.min(...wired.map((i) => i.sound));
    let laggard = wired[0];
    for (const it of wired) if (it.sound < laggard.sound) laggard = it;
    for (const it of wired) {
      const want = Math.max(0, Math.min(0.5, it.sound - target));
      const node = g.nodes.get(it.key);
      if (Math.abs(want - node.sec) > 0.004) {
        node.delay.delayTime.setTargetAtTime(want, g.ctx.currentTime, 0.03);
        node.sec = want;
      }
    }
    this.masterKey = laggard.key; // 用最慢的一轨当时钟：它的 delay 恒为 0
    this.masterDelay = 0;
  }

  _scheduleAlign(ms) {
    const timer = setTimeout(() => {
      this.alignTimers = this.alignTimers.filter((t) => t !== timer);
      this._alignTracks();
    }, ms);
    this.alignTimers.push(timer);
  }

  _clearAlign() {
    for (const timer of this.alignTimers ?? []) clearTimeout(timer);
    this.alignTimers = [];
  }

  /**
   * 低频复查（8 秒一次）：只在明显跑偏时才动手，而且动的是 delay，不是 seek。
   * 正常播放时 spread 恒为 0，这里什么都不会做。
   */
  _startWatch() {
    this._stopWatch();
    this.watchTimer = setInterval(() => {
      if (!this.playing) return;
      if (this.syncSpread() > 0.04) this._alignTracks();
    }, 8000);
  }

  _stopWatch() {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  latency() {
    return 0;
  }

  dispose() {
    this._clearAlign();
    this._stopWatch();
    if (this.graph) {
      try {
        for (const node of this.graph.nodes.values()) node.src.disconnect?.();
        this.graph.ctx.close?.().catch?.(() => {});
      } catch {
        /* ignore */
      }
      this.graph = null;
    }
    this.masterKey = null;
    this.masterDelay = 0;
    for (const t of this.tracks.values()) {
      try {
        t.el.pause();
      } catch {
        /* ignore */
      }
      t.el.removeAttribute('src');
      try {
        t.el.load();
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(t.url);
    }
    this.tracks.clear();
    this.playing = false;
    this.finished = false;
    this.duration = 0;
  }
}