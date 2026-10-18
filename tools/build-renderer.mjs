// 生成渲染进程规则文件：node tools/build-renderer.mjs [--force]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRulesGlobal } from '../src/shared/buildRulesGlobal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

const res = await buildRulesGlobal({ rootDir: ROOT, force });
const rel = path.relative(ROOT, res.path);
console.log(res.rebuilt ? `生成 ${rel}  (${res.bytes} 字节)` : `已是最新 ${rel}`);
