// 验证组件按需下载：真下载一个 zip（OpenCL 5.7MB）+ 一个文件（主力权重 93MB），
// 其余用本地拷贝补齐，最后从"下载目录"启动引擎跑一手，确认可用。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, cp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  COMPONENTS,
  componentById,
  missingComponents,
  installComponent,
  cleanDownloadCache,
} from '../src/main/components.js';
import { GtpEngine, parseGenmoveAnalyze } from '../src/main/gtp.js';
import { levelById, generateCfg } from '../src/main/difficulty.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, '.tmp', 'engine-dl');
const REPO_ENGINE = path.join(ROOT, 'engine');
const CFG = path.join(ROOT, 'config', 'generated', 'dl-probe.cfg');

await mkdir(ENGINE, { recursive: true });

console.log('### 初始缺失组件');
let missing = await missingComponents(ENGINE);
for (const c of missing) console.log(`  - ${c.label}  ${(c.bytes / 1048576).toFixed(1)} MB  ${c.required ? '(必须)' : '(可选)'}`);

const progress = (p) => {
  if (p.phase === 'download') {
    const pct = p.total ? Math.floor((p.received / p.total) * 100) : 0;
    if (pct % 25 === 0) process.stdout.write(`\r  ${p.id} 下载 ${pct}% (${(p.received / 1048576).toFixed(0)}MB)   `);
  }
};

// 1) 真下载一个 zip 组件（OpenCL）
console.log('\n### 真下载 OpenCL（zip，5.7MB）');
const t0 = Date.now();
await installComponent(componentById('opencl'), ENGINE, progress);
console.log(`\n  完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('  katago.exe 存在:', existsSync(path.join(ENGINE, 'opencl', 'katago.exe')));

// 2) 真下载一个文件组件（主力权重 93MB）
console.log('\n### 真下载主力权重（file，93MB）');
const t1 = Date.now();
await installComponent(componentById('weights-main'), ENGINE, progress);
const wsize = (await stat(path.join(ENGINE, 'weights', 'b18c384nbt.bin.gz'))).size;
console.log(`\n  完成，用时 ${((Date.now() - t1) / 1000).toFixed(1)}s，文件 ${(wsize / 1048576).toFixed(1)} MB`);

// 3) 重复安装应跳过
console.log('\n### 重复安装应跳过');
const again = await installComponent(componentById('weights-main'), ENGINE, () => {});
console.log('  skipped =', again.skipped);

// 4) 剩下的组件用本地拷贝补齐（避免重复下载）
console.log('\n### 用本地文件补齐其余组件');
for (const c of await missingComponents(ENGINE)) {
  const src = path.join(REPO_ENGINE, c.dest);
  const dst = path.join(ENGINE, c.dest);
  if (!existsSync(src)) {
    console.log(`  ! 本地也没有 ${c.dest}，跳过`);
    continue;
  }
  await mkdir(path.dirname(dst), { recursive: true });
  await cp(src, dst, { recursive: true });
  console.log(`  补齐 ${c.label}`);
}

missing = await missingComponents(ENGINE);
console.log('  剩余缺失:', missing.length === 0 ? '无' : missing.map((c) => c.id).join(', '));

// 5) 从下载目录启动引擎并跑一手
console.log('\n### 从"用户目录"启动 DirectML 引擎');
const cfgContent = [...generateCfg(levelById('lv8'), { threads: 4 }), 'onnxProvider = directml'].join('\n') + '\n';
await (await import('node:fs/promises')).writeFile(CFG, cfgContent, 'utf8');

const engine = new GtpEngine({
  exe: path.join(ENGINE, 'directml', 'katago.exe'),
  configPath: CFG,
  modelPath: path.join(ENGINE, 'weights', 'b18c384nbt.bin.gz'),
  humanModelPath: path.join(ENGINE, 'weights', 'b18c384nbt-humanv0.bin.gz'),
  cwd: path.join(ENGINE, 'directml'),
  startupTimeoutMs: 300000,
});
const hs = await engine.start();
console.log('  启动成功:', JSON.stringify(hs));
await engine.command('kata-set-param maxVisits 60', 20000);
await engine.commands(['boardsize 9', 'komi 7', 'clear_board', 'play B E5'], 30000);
const t2 = Date.now();
const { move, infos } = parseGenmoveAnalyze(await engine.command('kata-genmove_analyze W interval 100', 120000));
console.log(`  着法=${move} 候选=${infos.length} 用时=${Date.now() - t2}ms`);
await engine.stop();

// 6) OpenCL 组件也验证一下能启动（用同一个权重）
console.log('\n### 顺带验证 OpenCL 组件');
const ocl = new GtpEngine({
  exe: path.join(ENGINE, 'opencl', 'katago.exe'),
  configPath: path.join(ROOT, 'config', 'generated', 'dl-probe-opencl.cfg'),
  modelPath: path.join(ENGINE, 'weights', 'b18c384nbt.bin.gz'),
  cwd: path.join(ENGINE, 'opencl'),
  startupTimeoutMs: 420000,
});
await (await import('node:fs/promises')).writeFile(
  path.join(ROOT, 'config', 'generated', 'dl-probe-opencl.cfg'),
  generateCfg(levelById('lv8'), { threads: 4 }).join('\n') + '\n',
  'utf8',
);
const hs2 = await ocl.start();
await ocl.commands(['boardsize 9', 'komi 7', 'clear_board'], 30000);
console.log('  OpenCL 启动成功:', JSON.stringify(hs2));
await ocl.stop();

await cleanDownloadCache(ENGINE);
console.log('\n### 全部通过');
