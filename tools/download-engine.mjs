// 下载引擎与权重到 engine/（仓库里不提交二进制，首次开发时跑一次）
//   node tools/download-engine.mjs            # 权重 + DirectML + OpenCL（约 220 MB）
//   node tools/download-engine.mjs --cuda     # 额外下载 CUDA 加速包（NVIDIA，约 1.2 GB）
//   node tools/download-engine.mjs --mirror china   # 走国内镜像
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installSelected, cleanDownloadCache, componentById, COMPONENTS } from '../src/main/components.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'engine');

const args = process.argv.slice(2);
const withCuda = args.includes('--cuda');
const mirrorArg = args[args.indexOf('--mirror') + 1];
const mirror = mirrorArg === 'china' || args.includes('--mirror=china') ? 'china' : 'direct';

const ids = ['weights-main', 'weights-human', 'directml', 'opencl'];
if (withCuda) ids.push('cuda');

await mkdir(ENGINE, { recursive: true });

console.log(`下载目标目录：${ENGINE}`);
console.log(`下载源：${mirror === 'china' ? '国内镜像' : '官方直连'}`);
console.log(`组件：${ids.map((id) => componentById(id)?.label ?? id).join('、')}\n`);

const started = Date.now();
let lastWrite = 0;

for (const id of ids) {
  const comp = componentById(id);
  if (!comp) {
    console.warn(`跳过未知组件：${id}`);
    continue;
  }
  console.log(`▸ ${comp.label}（约 ${(comp.bytes / 1048576).toFixed(0)} MB）`);
  await installSelected([id], ENGINE, (p) => {
    if (p.phase === 'download' && p.total) {
      const pct = Math.floor((p.received / p.total) * 100);
      if (Date.now() - lastWrite > 400) {
        lastWrite = Date.now();
        process.stdout.write(`\r  ${pct}%  ${(p.received / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB   `);
      }
    }
  }, { mirror });
  process.stdout.write('\n');
}

await cleanDownloadCache(ENGINE);

console.log(`\n完成，用时 ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log('现在可以 npm start 了（引擎目录：engine/）');
console.log('\n可用的后端：');
for (const c of COMPONENTS) {
  const probeMap = {
    'weights-main': 'weights/b18c384nbt.bin.gz',
    'weights-human': 'weights/b18c384nbt-humanv0.bin.gz',
    directml: 'directml/katago.exe',
    opencl: 'opencl/katago.exe',
    cuda: 'katago.exe',
  };
  const p = probeMap[c.id];
  if (!p) continue;
  const { existsSync } = await import('node:fs');
  console.log(`  ${existsSync(path.join(ENGINE, p)) ? '✓' : '×'} ${c.label}`);
}
