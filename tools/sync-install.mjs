// 把"运行时要用的文件"同步到安装目录（比如 D:\音乐\Piano Falls）。
// 只复制文件，不碰 .git / .tmp / test / tools —— 安装目录是给用户跑的，不是仓库。
//
//   node tools/sync-install.mjs "D:/音乐/Piano Falls"
//   PF_INSTALL_DIR="D:/音乐/Piano Falls" node tools/sync-install.mjs
//
// 开发流程（本项目约定）：改代码 → npm test → 本脚本同步 → 刷新页面；
// 提交/推送不在日常流程里，由用户统一发起。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] || process.env.PF_INSTALL_DIR;

if (!target) {
  console.error('用法: node tools/sync-install.mjs "<安装目录>"（或设 PF_INSTALL_DIR）');
  process.exit(1);
}
const dest = path.resolve(target);
if (!fs.existsSync(dest)) {
  console.error(`安装目录不存在：${dest}`);
  process.exit(1);
}
if (dest === ROOT) {
  console.error('安装目录不能是仓库自己');
  process.exit(1);
}

const FILES = ['index.html', 'package.json', 'README.md', 'LICENSE', 'serve.ps1', 'serve.mjs', 'launch.vbs'];
const DIRS = ['src', 'docs'];

let copied = 0;
const copyFile = (rel) => {
  const from = path.join(ROOT, rel);
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
  fs.copyFileSync(from, path.join(dest, rel));
  copied++;
  return true;
};

for (const f of FILES) if (!copyFile(f)) console.log(`  跳过（仓库里没有）${f}`);
for (const d of DIRS) {
  const full = path.join(ROOT, d);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) {
    const rel = path.join(d, name);
    if (fs.statSync(path.join(ROOT, rel)).isFile()) copyFile(rel);
  }
}
// 启动脚本（中文文件名，单独列出来，避免被上面的固定列表漏掉）
for (const name of fs.readdirSync(ROOT)) {
  if (/\.cmd$/i.test(name)) copyFile(name);
}

console.log(`同步完成：${copied} 个文件 → ${dest}`);
console.log('刷新页面即可（页面开着的话会提示按 Ctrl+F5）。');
