// Node 里跑浏览器模块：先装一点点浏览器全局，再把 'three' 指到打桩
import { register } from 'node:module';

globalThis.window ??= { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900 };

register('./loader.mjs', import.meta.url);