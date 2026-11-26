// 音频层：只暴露四个语义 —— 加载、按「绝对音频时间」触发一个音、全停、输出延迟。
// 关键约定：所有时间都是 AudioContext.currentTime 域内的绝对时间，
// 这样视觉和音频用的是同一个时钟，落地误差不来自"两套计时器"。

import * as Tone from 'tone';
import { noteName } from './score.js';

// Salamander Grand Piano（CC-BY 3.0, Alexander Holm）每小三度一个样本，
// 21..108 里只有 A / C / D# / F# 四类音级有文件，中间的音由 Sampler 变调播放。
//
// 采样来源按顺序尝试：
//  1) jsDelivr 代理同一个 GitHub 仓库 —— 国内网络通常只能走这条
//  2) 原始 GitHub Pages 站点
// 两条都不通就降级成 PolySynth（时间轴照样能验证）。
const SAMPLE_BASES = [
  'https://cdn.jsdelivr.net/gh/Tonejs/audio@master/salamander/',
  'https://tonejs.github.io/audio/salamander/',
];
const SAMPLED_PCS = new Set([9, 0, 3, 6]); // A C D# F#

/** D#1 这种音名在 Salamander 里叫 Ds1.mp3；『#』不能直接进 URL（会被当锚点截断） */
function sampleFile(noteNameStr) {
  return `${noteNameStr.replace('#', 's')}.mp3`;
}

function sampleMap() {
  const urls = {};
  for (let m = 21; m <= 108; m++) {
    if (SAMPLED_PCS.has(m % 12)) {
      const name = noteName(m);
      urls[name] = sampleFile(name);
    }
  }
  return urls;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

export class Piano {
  constructor() {
    this.instrument = null;
    this.kind = 'none';
    this.ready = false;
    this.source = '';
    this.attempts = 0;
    this.out = null;
    this.input = null; // 乐器应该连到这里（= 混响，或直连 out）
  }

  /** 降级成合成音色后还值得再试几次采样（冷缓存首载常常一次超时） */
  get shouldRetrySamples() {
    return this.ready && this.kind !== 'salamander' && this.attempts < 2;
  }

  /** 必须在用户手势里调用（浏览器 autoplay 策略） */
  async init({ timeoutMs = 25000 } = {}) {
    if (this.ready && !this.shouldRetrySamples) return this.kind;
    await Tone.start();
    this.attempts++;

    if (!this.out) {
      this.out = new Tone.Gain(1).toDestination();
      Tone.getDestination().volume.value = -6;
      // 一点点板混响：干声直接听采样会显得"贴脸"。Freeverb 是纯算法、不需要外部
      // impulse 文件，离线也不会失败；拿不到就直连。
      this.input = this.out;
      try {
        if (typeof Tone.Freeverb === 'function') {
          this.input = new Tone.Freeverb({ roomSize: 0.66, dampening: 4200, wet: 0.16 }).connect(this.out);
        }
      } catch (err) {
        console.warn('[audio] 混响不可用，直连输出：', err?.message ?? err);
        this.input = this.out;
      }
    }

    for (const base of SAMPLE_BASES) {
      try {
        const sampler = await this.loadSampler(base, timeoutMs);
        if (this.kind !== 'salamander') {
          try { this.instrument?.dispose?.(); } catch { /* 丢掉之前的合成音色 */ }
        }
        this.instrument = sampler;
        this.kind = 'salamander';
        this.source = base;
        this.ready = true;
        return this.kind;
      } catch (err) {
        console.warn('[audio] 采样源不可用：', base, err?.message ?? err);
      }
    }

    if (this.kind !== 'polysynth' || !this.instrument) {
      const poly = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.003, decay: 0.55, sustain: 0.14, release: 0.9 },
      }).connect(this.input);
      poly.maxPolyphony = 48;
      this.instrument = poly;
    }
    this.kind = 'polysynth';
    this.source = 'synth';
    this.ready = true;
    return this.kind;
  }

  /** 从某个 base 加载整套采样；任何一个文件失败就整体失败并清理 */
  async loadSampler(base, timeoutMs) {
    let sampler = null;
    const loaded = new Promise((resolve, reject) => {
      sampler = new Tone.Sampler({
        urls: sampleMap(),
        baseUrl: base,
        attack: 0,
        release: 1.4,
        curve: 'exponential',
        onload: () => resolve(true),
        onerror: (err) => reject(err instanceof Error ? err : new Error(String(err))),
      });
    });
    sampler.connect(this.input);
    try {
      await withTimeout(loaded, timeoutMs);
      return sampler;
    } catch (err) {
      try { sampler.dispose(); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * @param {{midi:number, dur:number, soundDur?:number, vel:number}} note
   * @param {number} when 绝对音频时间
   */
  trigger(note, when) {
    const inst = this.instrument;
    if (!inst) return;
    const len = Math.max(0.05, note.soundDur ?? note.dur);
    // 采样音源对 velocity 很敏感，压一下动态避免弱奏听不见
    const vel = Math.max(0.06, Math.min(1, note.vel)) ** 0.7;
    inst.triggerAttackRelease(noteName(note.midi), len, when, vel);
  }

  releaseAll() {
    try { this.instrument?.releaseAll?.(); } catch { /* ignore */ }
  }

  setVolume(db) {
    try { Tone.getDestination().volume.rampTo(db, 0.05); } catch { /* ignore */ }
  }

  /**
   * 声卡/耳机输出延迟（秒）。蓝牙耳机经常 0.1~0.3s，视觉要跟着往后推，
   * 否则你看到"落地"的时候声音还没出来。
   */
  outputLatency() {
    try {
      const ctx = Tone.getContext();
      const raw = ctx.rawContext || ctx._context || ctx;
      const l = raw && typeof raw.outputLatency === 'number' ? raw.outputLatency : 0;
      return Number.isFinite(l) ? l : 0;
    } catch {
      return 0;
    }
  }
}