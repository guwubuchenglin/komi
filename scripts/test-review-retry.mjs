// 复盘自愈测试：模拟评估中途引擎卡死（GTP 超时），验证会自动重启并续跑
//   node scripts/test-review-retry.mjs
import assert from 'node:assert/strict';
import { EngineManager } from '../src/main/engineManager.js';

const SIZE = 9;
const moves = [];
let n = 0;
for (let y = 1; y <= 7 && moves.length < 20; y += 2) {
  for (let x = 1; x <= 7 && moves.length < 20; x += 2) {
    moves.push({ color: n % 2 === 0 ? 'B' : 'W', x, y });
    n++;
  }
}

const mgr = new EngineManager({ rootDir: process.cwd(), threads: 4 });
const logs = [];
mgr.on('log', (l) => {
  logs.push(l);
  if (/复盘|恢复|重启/.test(l)) console.log('  [engine]', l);
});

// --- 1) 第 3 次评估时模拟超时，应自动重试 ---
const originalEval = mgr.evaluatePosition.bind(mgr);
let calls = 0;
let injected = false;
mgr.evaluatePosition = async (opts) => {
  calls += 1;
  if (!injected && calls === 3) {
    injected = true;
    throw new Error('GTP 命令超时 (20000ms): kata-analyze interval 50');
  }
  return originalEval(opts);
};

console.log('\n### 1) 评估中途超时 → 自动重启并续跑');
const r = await mgr.reviewGame({ size: SIZE, komi: 7, moves, visits: 60, perMoveMs: 300 });
assert.equal(r.timeline.length, moves.length + 1, '复盘应覆盖全部局面');
assert.equal(r.retries, 1, '应记录 1 次重试');
assert.ok(logs.some((l) => l.includes('复盘中断')), '应记录中断日志');
const lastIdx = r.timeline[r.timeline.length - 1].index;
assert.equal(lastIdx, moves.length, '最后一个局面的 index 应等于手数');
// 回归保护：kata-analyze 的 interval 单位是厘秒，若间隔超过评估预算就会一条数据都收不到
const wins = r.timeline.filter((t) => t.blackWin != null);
assert.ok(wins.length >= r.timeline.length - 1, `胜率应几乎全部有效（有效 ${wins.length}/${r.timeline.length}）`);
console.log(`  ✓ 完成 ${r.timeline.length} 个局面，重试 ${r.retries} 次，胜率有效 ${wins.length} 条`);

// --- 2) 非重试类错误（如非法着法）应立即失败，不再重试 ---
console.log('\n### 2) 非超时错误不重试，直接报错');
const before = logs.length;
const badErr = new Error('GTP 错误: illegal move (cmd: play B A1)');
mgr.evaluatePosition = async () => originalEval({ visits: 60, maxMs: 300 });
let threw = null;
// 用一手与自己同色的重复着法制造非法着法
const badMoves = [...moves.slice(0, 4), { color: 'B', x: moves[0].x, y: moves[0].y }];
try {
  await mgr.reviewGame({ size: SIZE, komi: 7, moves: badMoves, visits: 30, perMoveMs: 200 });
} catch (err) {
  threw = err;
}
assert.ok(threw, '非法着法应抛出错误');
assert.match(threw.message, /illegal|非法/i);
const retryLogs = logs.slice(before).filter((l) => l.includes('复盘中断'));
assert.equal(retryLogs.length, 0, '非法着法不应触发重试');
console.log('  ✓ 立即失败：', threw.message.split('\n')[0]);

mgr.evaluatePosition = originalEval;
await mgr.shutdown();
console.log('\n通过');
