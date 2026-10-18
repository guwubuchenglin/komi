// 性能模式（线程 / 批次 / NN server 线程）回归测试：node scripts/test-perf.mjs
import assert from 'node:assert/strict';
import {
  PERF,
  tuningFor,
  generateCfg,
  engineProfileKey,
  normalizePerfMode,
  levelById,
  LEVELS,
} from '../src/main/difficulty.js';

let pass = 0;
const check = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
};

const cfgMap = (level, opts) => {
  const out = new Map();
  for (const line of generateCfg(level, opts)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    assert.equal(out.has(key), false, `配置键重复: ${key}`);
    out.set(key, value);
  }
  return out;
};

console.log('性能模式参数');

check('省电模式保持原参数（6 线程 / batch 8 / NN server 1）', () => {
  const t = tuningFor({ mode: PERF.BALANCED, threads: 6, engines: 1, cores: 16, backendId: 'cuda' });
  assert.equal(t.numSearchThreads, 6);
  assert.equal(t.nnMaxBatchSize, 8);
  assert.equal(t.numNNServerThreadsPerModel, 1);
});

check('高吞吐模式按核数放大线程（16 核单引擎 → 15 线程）', () => {
  const t = tuningFor({ mode: PERF.PERFORMANCE, threads: 6, engines: 1, cores: 16, backendId: 'cuda' });
  assert.equal(t.numSearchThreads, 15);
  assert.equal(t.nnMaxBatchSize, 24);
  assert.equal(t.numNNServerThreadsPerModel, 2);
});

check('观战双引擎平分 CPU（16 核 → 各 7 线程）', () => {
  const t = tuningFor({ mode: PERF.PERFORMANCE, threads: 4, engines: 2, cores: 16, backendId: 'cuda' });
  assert.equal(t.numSearchThreads, 7);
});

check('小机器不会超配线程（4 核单引擎 → 3 线程）', () => {
  const t = tuningFor({ mode: PERF.PERFORMANCE, threads: 6, engines: 1, cores: 4, backendId: 'cuda' });
  assert.equal(t.numSearchThreads, 3);
  assert.ok(t.nnMaxBatchSize >= 8);
});

check('极小的机器也至少给 2 线程', () => {
  const t = tuningFor({ mode: PERF.PERFORMANCE, threads: 6, engines: 1, cores: 2, backendId: 'cuda' });
  assert.equal(t.numSearchThreads, 2);
});

check('线程上限 16（再多收益很小）', () => {
  const t = tuningFor({ mode: PERF.PERFORMANCE, threads: 6, engines: 1, cores: 64, backendId: 'cuda' });
  assert.equal(t.numSearchThreads, 16);
});

check('非 CUDA 后端不放大批次、不开多 NN server 线程', () => {
  const t = tuningFor({ mode: PERF.PERFORMANCE, threads: 6, engines: 1, cores: 16, backendId: 'opencl' });
  assert.equal(t.nnMaxBatchSize, 16);
  assert.equal(t.numNNServerThreadsPerModel, 1);
});

check('normalizePerfMode 兜底为省电', () => {
  assert.equal(normalizePerfMode('whatever'), PERF.BALANCED);
  assert.equal(normalizePerfMode(PERF.PERFORMANCE), PERF.PERFORMANCE);
});

console.log('生成的 cfg 内容');

check('高吞吐 + 标准网络：线程与批次写进 cfg', () => {
  const m = cfgMap(levelById('lv10'), { perfMode: PERF.PERFORMANCE, perfEngines: 1, backendId: 'cuda' });
  assert.equal(m.get('numSearchThreads'), '15');
  assert.equal(m.get('nnMaxBatchSize'), '24');
  assert.equal(m.get('numNNServerThreadsPerModel'), '2');
  assert.equal(m.get('maxVisits'), '12000');
});

check('省电 + 标准网络：回到 6 线程 / batch 8', () => {
  const m = cfgMap(levelById('lv10'), { threads: 6, perfMode: PERF.BALANCED, backendId: 'cuda' });
  assert.equal(m.get('numSearchThreads'), '6');
  assert.equal(m.get('nnMaxBatchSize'), '8');
});

check('拟人档（纯策略）即使高吞吐也只跑 1 线程', () => {
  const m = cfgMap(levelById('lv4'), { perfMode: PERF.PERFORMANCE, backendId: 'cuda' });
  assert.equal(m.get('numSearchThreads'), '1');
  assert.equal(m.get('humanSLProfile'), 'preaz_5k');
});

check('拟人档（带搜索）用放大后的线程数，并保留人类参数', () => {
  const m = cfgMap(levelById('lv6'), { perfMode: PERF.PERFORMANCE, backendId: 'cuda' });
  assert.equal(m.get('numSearchThreads'), '15');
  assert.equal(m.get('humanSLChosenMovePiklLambda'), '0.15');
});

check('所有档位生成的 cfg 都不含重复键', () => {
  for (const lv of LEVELS) {
    for (const mode of [PERF.BALANCED, PERF.PERFORMANCE]) {
      cfgMap(lv, { perfMode: mode, backendId: 'cuda' });
    }
  }
});

console.log('配置指纹');

check('只有高吞吐模式才带 :perf 后缀（触发引擎重启）', () => {
  const lv = levelById('lv8');
  assert.ok(!engineProfileKey(lv, false, PERF.BALANCED).includes(':perf'));
  assert.ok(engineProfileKey(lv, false, PERF.PERFORMANCE).includes(':perf'));
  assert.notEqual(
    engineProfileKey(lv, false, PERF.BALANCED),
    engineProfileKey(lv, false, PERF.PERFORMANCE),
  );
});

check('快速模式后缀仍然保留', () => {
  assert.ok(engineProfileKey(levelById('lv8'), true, PERF.PERFORMANCE).endsWith(':perf:fast'));
});

console.log(`\n通过 ${pass} 项`);
