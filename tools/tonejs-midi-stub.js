// 只提供 normalizeMidi 需要的形状；用来在 Node 里验证音符归一化逻辑
// （真实解析仍由浏览器里的 @tonejs/midi 完成）
export class Midi {
  constructor() {
    this.name = '';
    this.tracks = [];
  }
}