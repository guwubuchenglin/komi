// 把 ESM 版规则引擎转成渲染进程可用的经典脚本。
// 主进程启动时也会调用（文件缺失/过期时自动重建），所以打包后不会因为忘记 build 而白屏。
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const RULE_EXPORTS = [
  'EMPTY',
  'BLACK',
  'WHITE',
  'opponent',
  'createState',
  'cloneState',
  'idxOf',
  'xOf',
  'yOf',
  'neighbors',
  'group',
  'playMove',
  'placeStones',
  'playPass',
  'resign',
  'undo',
  'legalMoves',
  'scoreArea',
  'deadFromOwnership',
  'idxToGtp',
  'gtpToIdx',
];

/**
 * @param {{rootDir: string, force?: boolean}} opts
 * @returns {Promise<{path: string, rebuilt: boolean, bytes: number}>}
 */
export async function buildRulesGlobal({ rootDir, force = false }) {
  const src = path.join(rootDir, 'src', 'shared', 'board.js');
  const out = path.join(rootDir, 'src', 'renderer', 'rules.global.js');

  if (!force) {
    try {
      const [s, o] = await Promise.all([stat(src), stat(out)]);
      if (o.mtimeMs >= s.mtimeMs) return { path: out, rebuilt: false, bytes: o.size };
    } catch {
      /* 文件不存在 → 继续重建 */
    }
  }

  let code = await readFile(src, 'utf8');
  code = code.replace(/^export\s+(const|function)\s/gm, '$1 ');

  const wrapper = `/* 自动生成，请勿编辑。源文件：src/shared/board.js */
(function () {
  "use strict";
${code
  .split('\n')
  .map((l) => (l ? '  ' + l : l))
  .join('\n')}

  window.GoRules = { ${RULE_EXPORTS.join(', ')} };
})();
`;

  await writeFile(out, wrapper, 'utf8');
  return { path: out, rebuilt: true, bytes: Buffer.byteLength(wrapper) };
}
