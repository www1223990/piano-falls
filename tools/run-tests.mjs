// 跑全部测试：tools/ 和 test/ 下所有 *.mjs / *.js（按文件名排序），逐个起子进程。
// 新加测试文件不用改 package.json，丢进 test/ 就会被执行。
// 跑法：node tools/run-tests.mjs        只跑名字里含某词的：node tools/run-tests.mjs ottava
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filter = process.argv[2] ?? '';
const REGISTER = pathToFileURL(path.join(ROOT, 'tools', 'register.mjs')).href;

function collect(dir) {
  const full = path.join(ROOT, dir);
  return fs
    .readdirSync(full)
    // 只跑测试文件：test-*.mjs / verify-*.js。新的测试文件按这个名字丢进去就会被跑到
    .filter((f) => /^((test|verify)[-_.].*\.(mjs|js))$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

// 在 Electron 里跑（本仓库的开发环境）时要告诉子进程"把自己当 node 用"
const childEnv = { ...process.env };
if (process.versions.electron && !childEnv.ELECTRON_RUN_AS_NODE) childEnv.ELECTRON_RUN_AS_NODE = '1';

const files = [...collect('tools'), ...collect('test')].filter((f) => !filter || f.includes(filter));

let bad = 0;
const results = [];
for (const rel of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--import', REGISTER, path.join(ROOT, rel)], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 120000,
    env: childEnv,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0;
  if (!ok) bad++;
  // 只打印每个测试的最后一行 + 失败时的尾部输出，避免刷屏
  const tail = out.trim().split('\n').filter(Boolean);
  results.push({ rel, ok, ms: Date.now() - t0, last: tail[tail.length - 1] ?? '(no output)' });
  if (!ok) {
    console.log(`\n✗ ${rel}\n${tail.slice(-25).join('\n')}`);
  }
}

console.log('\n=== 汇总 ===');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.rel.padEnd(34)} ${String(r.ms).padStart(5)}ms  ${r.last}`);
}
console.log(bad ? `\n${bad}/${results.length} 个测试失败` : `\n全部通过（${results.length} 个测试文件）`);
process.exit(bad ? 1 : 0);
