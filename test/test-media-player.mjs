// 多轨对齐的回归测试（Node 里用假的 <audio> / AudioContext 跑）。
//
// 锁死两条规矩：
//   1) **绝不用写 currentTime 的方式修同步**（实测会让 <audio> 停顿 56~68ms，
//      每秒一次的"修正"就会变成每秒卡一下、永远修不好）
//   2) 真的跑偏时，用 DelayNode 把"早的那条"延后，主轨换成最慢的一条（它的 delay 恒为 0）

let currentTimeWrites = 0;

class FakeAudio {
  constructor() {
    this._t = 0;
    this.duration = 100;
    this.readyState = 4;
    this.volume = 1;
    this.paused = true;
    this.playbackRate = 1;
    this.preservesPitch = true;
    this.src = '';
    this._listeners = new Map();
  }
  get currentTime() { return this._t; }
  set currentTime(v) { currentTimeWrites++; this._t = v; }
  addEventListener(name, fn) {
    if (!this._listeners.has(name)) this._listeners.set(name, []);
    this._listeners.get(name).push(fn);
  }
  _fire(name) { for (const fn of this._listeners.get(name) ?? []) fn(); }
  load() { setTimeout(() => { this._fire('loadedmetadata'); this._fire('canplaythrough'); }, 0); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute() {}
}

const delays = [];
const resets = []; // 硬对齐时把 delay 归零的次数
class FakeDelay {
  constructor() {
    this.delayTime = {
      setTargetAtTime: (v) => delays.push(+v.toFixed(4)),
      setValueAtTime: (v) => resets.push(+v.toFixed(4)),
      cancelScheduledValues: () => {},
    };
  }
  connect(node) { return node; }
  disconnect() {}
}
class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
    this.nodes = 0;
  }
  createMediaElementSource() { this.nodes++; return { connect: (n) => n, disconnect() {} }; }
  createDelay() { return new FakeDelay(); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

globalThis.Audio = FakeAudio;
globalThis.window = { AudioContext: FakeAudioContext };
globalThis.performance ??= { now: () => Date.now() };
globalThis.URL.createObjectURL = () => 'blob:fake';
globalThis.URL.revokeObjectURL = () => {};

const { MediaPlayer } = await import('../src/media-player.js');

let fails = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { fails++; console.log(`  ✗ ${msg}`); }
};

const bytes = new Uint8Array([1, 2, 3]);
const stems = [{ key: '1', bytes }, { key: '2', bytes }];

// ---- 1) 已经在 20ms 以内：不建音频链路，音频通路一点不碰 ----
{
  const p = new MediaPlayer();
  await p.load(stems);
  await p.play({ delay: 0 });
  p._clearAlign();
  const els = p._els();
  els[0].currentTime = 10.0;
  els[1].currentTime = 9.99;
  currentTimeWrites = 0; // 上面两行是"造偏差"，从这之后才算账
  p._alignTracks();
  check(p.graph === null, '偏差 10ms → 不建 WebAudio 链路');
  check(currentTimeWrites === 0, '偏差 10ms → 没有写 currentTime');
  check(p.syncSpread() < 0.02, '偏差 10ms → spread 仍在 20ms 内');
  p.dispose();
}

// ---- 2) 真的跑偏 70ms：用 delay 修，不 seek ----
{
  const p = new MediaPlayer();
  await p.load(stems);
  await p.play({ delay: 0 });
  p._clearAlign();
  delays.length = 0;
  const els = p._els();
  els[0].currentTime = 10.0;
  els[1].currentTime = 9.93; // 第 2 条落后 70ms
  currentTimeWrites = 0; // 上面几行是"造偏差"，从这之后才算账
  p._alignTracks();
  check(!!p.graph, '偏差 70ms → 建了 WebAudio 链路');
  check(currentTimeWrites === 0, '偏差 70ms → 依然没有写 currentTime（不 seek）');
  check(delays.length > 0 && Math.abs(delays[0] - 0.07) < 0.005, `给"早的那条"加了 70ms 延迟（实测 ${delays[0]}）`);
  const secs = [...p.graph.nodes.values()].map((n) => n.sec);
  check(Math.abs(secs[0] - 0.07) < 0.005 && secs[1] < 1e-6, '延迟只加在早的那条上（另一条 0）');
  check(p.masterKey === '2', '主轨换成最慢的那条（它的延迟恒为 0，画面不平移）');
  check(p.syncSpread() < 0.005, `对齐后 spread ${p.syncSpread().toFixed(4)}s < 5ms`);
  check(Math.abs(p.time() - 9.93) < 0.005, 'time() 返回的是"听到的"那一刻');
  p.dispose();
}

// ---- 3) 偏差大到几百毫秒：不能加 delay（会滑音/激光），改一次性硬对齐 ----
{
  const p = new MediaPlayer();
  await p.load(stems);
  await p.play({ delay: 0 });
  p._clearAlign();
  const els = p._els();
  // 先来一个小偏差，把 WebAudio 链路建起来（正常路径）
  els[0].currentTime = 10.0;
  els[1].currentTime = 9.93;
  p._alignTracks();
  check(!!p.graph, '小偏差 → 建了链路');
  // 再来一次大偏差（模拟起播抖动）：应该走硬对齐，而不是把 delay 拉到几百毫秒
  delays.length = 0;
  resets.length = 0;
  els[1].currentTime = els[0].currentTime - 0.35;
  p._alignTracks();
  check(delays.length === 0, '偏差 350ms → 不再加 delay（否则就是那声"激光"）');
  check(p.lastHardAlignSpread > 0.2, `记录了硬对齐偏差 ${p.lastHardAlignSpread}`);
  check(els[0].currentTime === els[1].currentTime, '硬对齐后两条轨回到同一位置');
  check(resets.length >= 2, 'delay 被归零（每轨一次）');
  check(p.syncSpread() < 0.001, '对齐后 spread ≈ 0');
  p.dispose();
}

// ---- 4) 单轨（没分轨）时不做任何对齐动作 ----
{
  const p = new MediaPlayer();
  await p.load([{ key: 'mix', bytes }]);
  await p.play({ delay: 0 });
  p._clearAlign();
  p._alignTracks();
  check(p.graph === null, '单轨 → 不建链路');
  check(p.syncSpread() === 0, '单轨 → spread 为 0');
  p.dispose();
}

console.log(fails ? `\n${fails} 条失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
