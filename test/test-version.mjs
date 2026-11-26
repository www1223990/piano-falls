// 版本号一致性：src/version.js 和 package.json 必须是同一个版本。
// 作用不是"检查有没有写错"，而是逼着发布时两处一起改（以前漏改过一次，页面显示旧版本号）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

let fails = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { fails++; console.log(`  ✗ ${msg}`); }
};

check(/^\d+\.\d+\.\d+$/.test(VERSION), `version.js 里是合法版本号（${VERSION}）`);
check(pkg.version === VERSION, `package.json 的 version（${pkg.version}）与 version.js（${VERSION}）一致`);
check(typeof pkg.name === 'string' && pkg.name.length > 0, 'package.json 有 name');

console.log(fails ? `\n${fails} 条失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
