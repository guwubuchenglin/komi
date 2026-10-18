// 交叉验证：同一局面分别用「拟人档」和「标准档」评估，确认胜率视角没搞反
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GtpEngine, parseGenmoveAnalyze } from '../src/main/gtp.js';
import { levelById, generateCfg } from '../src/main/difficulty.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.join(ROOT, 'engine', 'katago.exe');
const MODEL = path.join(ROOT, 'engine', 'weights', 'b18c384nbt.bin.gz');
const HUMAN = path.join(ROOT, 'engine', 'weights', 'b18c384nbt-humanv0.bin.gz');
const CFG = path.join(ROOT, 'config', 'generated');

// 黑方随手三手（模拟 UI 里的点击）
const MOVES = ['B E5', 'W D4', 'B C3', 'W C6', 'B G7'];

async function run(label, level, { humanModel = null, visits = null } = {}) {
  const cfgFile = path.join(CFG, `eval-${level.id}.cfg`);
  await mkdir(CFG, { recursive: true });
  await writeFile(cfgFile, generateCfg(level, { threads: 4 }).join('\n') + '\n');

  const e = new GtpEngine({
    exe: EXE,
    configPath: cfgFile,
    modelPath: MODEL,
    humanModelPath: humanModel,
    cwd: path.join(ROOT, 'engine'),
  });
  await e.start();
  await e.commands(['boardsize 9', 'komi 7.5', 'clear_board'], 30000);
  if (visits) await e.command('kata-set-param maxVisits ' + visits, 20000);
  for (const m of MOVES) await e.command('play ' + m, 30000);

  // 轮到白（AI 一方）落子，取根节点胜率
  const raw = await e.command('kata-genmove_analyze W interval 100', 120000);
  const { move, infos } = parseGenmoveAnalyze(raw);
  const bestW = infos[0];
  console.log(
    `${label}: 着法=${move}  白胜率=${(bestW.winrate * 100).toFixed(1)}%  ` +
      `黑胜率=${((1 - bestW.winrate) * 100).toFixed(1)}%  目差(白)=${bestW.scoreLead?.toFixed(1)}`,
  );
  // 再用 final_score 交叉印证谁领先
  console.log(`   终局判分参考: ${String(await e.command('final_score', 30000)).trim()}`);
  await e.stop();
}

// 造一个“黑明显亏”的局面：白连下三手压制
async function runHopeless() {
  const cfgFile = path.join(CFG, 'eval-hopeless.cfg');
  const level = levelById('lv8');
  await writeFile(cfgFile, generateCfg(level, { threads: 4 }).join('\n') + '\n');
  const e = new GtpEngine({
    exe: EXE,
    configPath: cfgFile,
    modelPath: MODEL,
    cwd: path.join(ROOT, 'engine'),
  });
  await e.start();
  await e.commands(['boardsize 9', 'komi 7.5', 'clear_board'], 30000);
  // 黑只走一路废棋，白在角上连下三手
  for (const m of ['B A1', 'W C3', 'B A2', 'W D3', 'B A3', 'W D4']) await e.command('play ' + m, 30000);
  const raw = await e.command('kata-genmove_analyze B interval 100', 120000);
  const { infos } = parseGenmoveAnalyze(raw);
  const b = infos[0];
  console.log(
    `黑被压制的局面（黑走）: 黑胜率=${(b.winrate * 100).toFixed(1)}%  白胜率=${((1 - b.winrate) * 100).toFixed(1)}%`,
  );
  await e.stop();
}

console.log('局面：', MOVES.join(' '), '\n');
await run('拟人 5 级（lv4, 40 访问）', levelById('lv4'), { humanModel: HUMAN });
await run('拟人 5 级 + 2000 访问', levelById('lv4'), { humanModel: HUMAN, visits: 2000 });
await run('标准 5 段（lv8, 500 访问）', levelById('lv8'));
await run('标准 5 段 + 3000 访问', levelById('lv8'), { visits: 3000 });
console.log('');
await runHopeless();
