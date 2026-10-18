// 实测 cuDNN 各 DLL 的必要性：逐个移除后用真实 GTP 搜索验证
// 用法: node scripts/test-cudnn-deps.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { GtpEngine, parseGenmoveAnalyze } from '../src/main/gtp.js';
import { levelById, generateCfg } from '../src/main/difficulty.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'engine');
const WORK = path.join(ROOT, '.tmp', 'cudnn-probe');
const CFG = path.join(ROOT, 'config', 'generated', 'cudnn-probe.cfg');
const MODEL = path.join(ENGINE, 'weights', 'b18c384nbt.bin.gz');

const CUDNN = ['cudnn64_9.dll', 'cudnn_adv64_9.dll', 'cudnn_cnn64_9.dll', 'cudnn_engines_precompiled64_9.dll', 'cudnn_engines_runtime_compiled64_9.dll', 'cudnn_engines_tensor_ir64_9.dll', 'cudnn_ext64_9.dll', 'cudnn_graph64_9.dll', 'cudnn_heuristic64_9.dll', 'cudnn_ops64_9.dll'];
const RUNTIME = ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcruntime140_threads.dll', 'z.dll', 'zip.dll', 'bz2.dll', 'libcrypto-3-x64.dll', 'libssl-3-x64.dll'];

/** 准备一份独立可运行的引擎副本（只受测文件影响） */
async function prepareDir(dir, keepCudnn) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(path.join(ENGINE, 'katago.exe'), path.join(dir, 'katago.exe'));
  for (const f of RUNTIME) {
    const src = path.join(ENGINE, f);
    if (existsSync(src)) await cp(src, path.join(dir, f));
  }
  for (const f of keepCudnn) {
    const src = path.join(ENGINE, f);
    if (existsSync(src)) await cp(src, path.join(dir, f));
  }
}

async function tryRun(dir, label) {
  const exe = path.join(dir, 'katago.exe');
  const engine = new GtpEngine({
    exe,
    configPath: CFG,
    modelPath: MODEL,
    cwd: dir,
    startupTimeoutMs: 120000,
  });
  const errLines = [];
  engine.on('stderr', (l) => errLines.push(l));
  try {
    const hs = await engine.start();
    await engine.command('kata-set-param maxVisits 40', 20000);
    await engine.commands(['boardsize 9', 'komi 7', 'clear_board', 'play B E5'], 30000);
    const raw = await engine.command('kata-genmove_analyze W interval 100', 120000);
    const { move, infos } = parseGenmoveAnalyze(raw);
    await engine.stop();
    if (!move) throw new Error('未返回着法');
    return { ok: true, note: `着法=${move} 候选=${infos.length}`, hs };
  } catch (err) {
    try {
      await engine.stop();
    } catch {
      /* ignore */
    }
    const fatal = /0xc0000135|STATUS_DLL_NOT_FOUND|not found|error loading/i.test(errLines.join('\n'));
    return { ok: false, note: err.message.slice(0, 120), fatal, stderr: errLines.slice(-3) };
  }
}

const sizeOf = async (files) => {
  const { stat } = await import('node:fs/promises');
  let sum = 0;
  for (const f of files) {
    const p = path.join(ENGINE, f);
    if (existsSync(p)) sum += (await stat(p)).size;
  }
  return Math.round(sum / 1048576);
};

// 待测的“可移除”候选（去掉后是否还能正常推理）
const DROPS = [
  ['cudnn_adv64_9.dll'],
  ['cudnn_engines_runtime_compiled64_9.dll'],
  ['cudnn_heuristic64_9.dll'],
  ['cudnn_engines_tensor_ir64_9.dll', 'cudnn_ext64_9.dll'],
  ['cudnn_adv64_9.dll', 'cudnn_engines_runtime_compiled64_9.dll'],
  ['cudnn_adv64_9.dll', 'cudnn_engines_runtime_compiled64_9.dll', 'cudnn_heuristic64_9.dll'],
  ['cudnn_adv64_9.dll', 'cudnn_engines_runtime_compiled64_9.dll', 'cudnn_heuristic64_9.dll', 'cudnn_engines_tensor_ir64_9.dll'],
];

const genCfg = generateCfg(levelById('lv8'), { threads: 4 }).join('\n') + '\n';
await mkdir(path.dirname(CFG), { recursive: true });
await (await import('node:fs/promises')).writeFile(CFG, genCfg, 'utf8');

console.log('基线（全部保留）…');
await prepareDir(WORK, CUDNN);
const base = await tryRun(WORK, 'baseline');
console.log(`  ${base.ok ? '可运行' : '失败'}: ${base.note}`);

for (const drop of DROPS) {
  const keep = CUDNN.filter((f) => !drop.includes(f));
  await prepareDir(WORK, keep);
  const saved = await sizeOf(drop);
  const res = await tryRun(WORK, keep.join('+'));
  const label = drop.join(' + ');
  if (res.ok) {
    console.log(`  ✅ 可移除 ${label}  → 省 ${saved} MB  (${res.note})`);
  } else {
    console.log(`  ❌ 需要 ${label}  (${res.note})${res.fatal ? ' [DLL 缺失]' : ''}`);
  }
}

await rm(WORK, { recursive: true, force: true });
