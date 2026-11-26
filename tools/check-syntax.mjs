// 语法检查：src/*.js + 入口脚本。新加文件不用再改 package.json。
// 跑法：node tools/check-syntax.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  ...fs
    .readdirSync(path.join(ROOT, 'src'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join('src', f)),
  'serve.mjs',
  ...fs
    .readdirSync(path.join(ROOT, 'test'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => path.join('test', f)),
];

let bad = 0;
// 在 Electron 里跑时要告诉子进程"把自己当 node 用"
const childEnv = { ...process.env };
if (process.versions.electron && !childEnv.ELECTRON_RUN_AS_NODE) childEnv.ELECTRON_RUN_AS_NODE = '1';
for (const rel of targets) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8', env: childEnv });
  if (r.status === 0) {
    console.log(`  ✓ ${rel}`);
  } else {
    bad++;
    console.log(`  ✗ ${rel}\n${(r.stderr || '').split('\n').slice(0, 6).join('\n')}`);
  }
}
console.log(bad ? `\n${bad} 个文件语法错误` : `\n${targets.length} 个文件语法正常`);
process.exit(bad ? 1 : 0);
