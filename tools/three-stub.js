// 极小 three 打桩：只为在 Node 里跑 src/waterfall.js 的时间轴逻辑。
// 不实现渲染，只记录每个实例的矩阵/颜色，供断言读取。

export const DynamicDrawUsage = 35048;
export const SRGBColorSpace = 'srgb';
export const MathUtils = { degToRad: (d) => (d * Math.PI) / 180 };

/** 所有 InstancedMesh 都会登记在这里 */
export const registry = [];

function makeVec(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    v: [x, y, z],
    set(a, b, c) { this.x = a; this.y = b; this.z = c; this.v = [a, b, c]; return this; },
  };
}

export class Color {
  constructor(hex) { this.r = 1; this.g = 1; this.b = 1; this.set(hex); }
  set(hex) {
    if (typeof hex === 'number') {
      this.r = ((hex >> 16) & 255) / 255;
      this.g = ((hex >> 8) & 255) / 255;
      this.b = (hex & 255) / 255;
    } else if (typeof hex === 'string' && hex[0] === '#' && hex.length === 7) {
      this.r = parseInt(hex.slice(1, 3), 16) / 255;
      this.g = parseInt(hex.slice(3, 5), 16) / 255;
      this.b = parseInt(hex.slice(5, 7), 16) / 255;
    }
    return this;
  }
  copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
  multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; }
  lerp(c, t) {
    this.r += (c.r - this.r) * t;
    this.g += (c.g - this.g) * t;
    this.b += (c.b - this.b) * t;
    return this;
  }
}

export class Object3D {
  constructor() {
    this.position = makeVec();
    this.scale = makeVec(1, 1, 1);
    this.matrix = { p: [0, 0, 0], s: [1, 1, 1] };
  }
  updateMatrix() {
    this.matrix = { p: this.position.v.slice(), s: this.scale.v.slice() };
  }
}

export class InstancedBufferAttribute {
  constructor(array) { this.array = array; this.needsUpdate = false; }
}

export class InstancedMesh extends Object3D {
  constructor(geometry, material, count) {
    super();
    this.geometry = geometry;
    this.material = material;
    this.capacity = count;
    this.count = count;
    this.instanceMatrix = { setUsage() {}, needsUpdate: false };
    this.instanceColor = null;
    this.matrixRows = [];
    registry.push(this);
  }
  setMatrixAt(i, m) { this.matrixRows[i] = { p: m.p.slice(), s: m.s.slice() }; }
  setColorAt(i, color) {
    if (!this.instanceColor) throw new Error('setColorAt 前必须先给 instanceColor 赋值');
    const k = i * 3;
    this.instanceColor.array[k] = color.r;
    this.instanceColor.array[k + 1] = color.g;
    this.instanceColor.array[k + 2] = color.b;
  }
}

export class BoxGeometry { constructor(w, h, d) { this.w = w; this.h = h; this.d = d; } }
export class MeshStandardMaterial { constructor(o = {}) { Object.assign(this, o); } }
export class MeshBasicMaterial { constructor(o = {}) { Object.assign(this, o); } }
export class Mesh {
  constructor(geo, mat) {
    this.geometry = geo;
    this.material = mat;
    this.position = makeVec();
    this.scale = makeVec(1, 1, 1);
    this.visible = true;
  }
}
export class Scene {
  constructor() { this.children = []; }
  add(...objs) { this.children.push(...objs); }
  remove(obj) {
    const i = this.children.indexOf(obj);
    if (i >= 0) this.children.splice(i, 1);
  }
  traverse(fn) { for (const c of this.children) { fn(c); c.traverse?.(fn); } }
}
export class PerspectiveCamera {
  constructor(fov, aspect, near, far) {
    this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
    this.position = makeVec();
    this.target = null;
  }
  updateProjectionMatrix() {}
  updateMatrixWorld() {}
  lookAt(x, y, z) { this.target = [x, y, z]; }
}

export class OrthographicCamera {
  constructor(left, right, top, bottom, near, far) {
    this.left = left; this.right = right; this.top = top; this.bottom = bottom;
    this.near = near; this.far = far;
    this.position = makeVec();
    this.target = null;
  }
  updateProjectionMatrix() {}
  updateMatrixWorld() {}
  lookAt(x, y, z) { this.target = [x, y, z]; }
}

export class CanvasTexture {
  constructor(image) { this.image = image; this.needsUpdate = false; }
}

export class SpriteMaterial {
  constructor(opts = {}) { Object.assign(this, opts); }
}

export class Sprite {
  constructor(material) {
    this.material = material;
    this.position = makeVec();
    this.scale = makeVec(1, 1, 1);
    this.visible = true;
  }
}

export const AdditiveBlending = 2;
export class HemisphereLight { constructor(a, b, i) { this.intensity = i; this.position = makeVec(); } }
export class DirectionalLight extends HemisphereLight {}
export class WebGLRenderer {
  constructor() { this.domElement = { tagName: 'CANVAS' }; this.outputColorSpace = ''; this.size = [0, 0]; }
  setPixelRatio() {}
  setSize(w, h) { this.size = [w, h]; }
  render() {}
}