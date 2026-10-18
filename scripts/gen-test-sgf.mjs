// 用两个引擎对下一局并导出 SGF（同时验证观战与 SGF 生成）
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SpectateRunner } from '../src/main/spectate.js';
import { buildSgf } from '../src/shared/sgf.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.tmp', 'test-game.sgf');

const runner = new SpectateRunner({ rootDir: ROOT, threads: 4 });
runner.on('log', (l) => console.log('[spec]', l));

const size = 9;
const komi = 7;
const r = await runner.playGame({ size, komi, levelBlack: 'lv4', levelWhite: 'lv6', paceMs: 0, maxMoves: 120 });
console.log(`\n对局结果: ${r.result}  胜方: ${r.winner ?? '—'}  手数: ${r.moves.length}`);

const sgf = buildSgf({
  size,
  komi,
  moves: r.moves.map((m) => ({ color: m.color, x: m.x, y: m.y, pass: m.pass })),
  playerBlack: 'KataGo lv4',
  playerWhite: 'KataGo lv6',
});
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, sgf, 'utf8');
console.log(`SGF 已写入 ${OUT}（${sgf.length} 字节）`);
console.log(sgf.slice(0, 160) + '…');

await runner.shutdown();
