/**
 * SGF 读写（最小可用实现，够用且不依赖第三方库）
 *
 * 支持：单局棋谱、SZ / KM / HA / AB / AW / PL、B/W 着法、注释、结果
 * 不支持：分支变化（variations）——遇到分支时只走主分支
 */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** SGF 坐标 → {x, y}；空字符串代表 pass */
export function sgfToPoint(value, size) {
  const v = String(value).trim().toLowerCase();
  if (!v) return null; // pass
  const x = v.charCodeAt(0) - 97;
  const y = v.charCodeAt(1) - 97;
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  return { x, y };
}

export function pointToSgf(x, y) {
  return LETTERS[x] + LETTERS[y];
}

/** 解析 SGF 文本，返回第一局棋谱的结构化数据 */
export function parseSgf(text) {
  const src = String(text);
  let i = 0;

  const skipSpace = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };

  /** 解析一个节点（从 ';' 开始） */
  function parseNode() {
    const props = {};
    if (src[i] === ';') i++;
    while (i < src.length) {
      skipSpace();
      const ch = src[i];
      if (ch === ';' || ch === '(' || ch === ')' || ch === '[' || i >= src.length) break;
      let name = '';
      while (i < src.length && /[A-Za-z]/.test(src[i])) name += src[i++];
      if (!name) {
        i++; // 防御：跳过未知字符
        continue;
      }
      const values = [];
      while (src[i] === '[') {
        i++;
        let v = '';
        while (i < src.length && src[i] !== ']') {
          if (src[i] === '\\' && i + 1 < src.length) {
            v += src[i + 1];
            i += 2;
          } else {
            v += src[i++];
          }
        }
        i++; // 跳过 ']'
        values.push(v);
      }
      props[name.toUpperCase()] = values;
    }
    return props;
  }

  // 找到根节点
  skipSpace();
  while (i < src.length && src[i] !== ';') i++;
  if (i >= src.length) throw new Error('不是合法的 SGF：找不到节点');

  const root = parseNode();
  const nodes = [root];

  // 主分支：一直读到 ')' 或 '('
  while (i < src.length) {
    skipSpace();
    if (src[i] === '(' || src[i] === ')') {
      i++;
      continue;
    }
    if (src[i] === ';') {
      nodes.push(parseNode());
      continue;
    }
    // 未知内容，前进一格避免死循环
    i++;
  }

  const first = nodes[0] ?? {};
  const num = (v, d) => {
    const n = Number(Array.isArray(v) ? v[0] : v);
    return Number.isFinite(n) ? n : d;
  };

  const size = num(first.SZ, 19) || 19;
  const komi = num(first.KM, 7.5);
  const handicap = num(first.HA, 0);

  const setupBlack = [];
  const setupWhite = [];
  for (const v of first.AB ?? []) {
    const p = sgfToPoint(v, size);
    if (p) setupBlack.push(p);
  }
  for (const v of first.AW ?? []) {
    const p = sgfToPoint(v, size);
    if (p) setupWhite.push(p);
  }

  const moves = [];
  for (const node of nodes) {
    for (const color of ['B', 'W']) {
      if (!node[color]) continue;
      const raw = node[color][0] ?? '';
      const point = sgfToPoint(raw, size);
      moves.push({
        color: color === 'B' ? 'B' : 'W',
        x: point?.x ?? null,
        y: point?.y ?? null,
        pass: point === null,
        comment: node.C?.[0] ?? '',
      });
    }
  }
  // 保持 SGF 里 B/W 的原始顺序（同一节点内少见，但保险起来按出现顺序重排）
  const ordered = [];
  for (const node of nodes.slice(0, nodes.length)) {
    if (node.B) ordered.push({ color: 'B', raw: node.B[0] ?? '', comment: node.C?.[0] ?? '' });
    if (node.W) ordered.push({ color: 'W', raw: node.W[0] ?? '', comment: node.C?.[0] ?? '' });
  }
  const finalMoves = ordered.map((m) => {
    const p = sgfToPoint(m.raw, size);
    return { color: m.color, x: p?.x ?? null, y: p?.y ?? null, pass: p === null, comment: m.comment };
  });

  return {
    size,
    komi,
    handicap,
    setupBlack,
    setupWhite,
    moves: finalMoves.length ? finalMoves : moves,
    playerBlack: first.PB?.[0] ?? '',
    playerWhite: first.PW?.[0] ?? '',
    result: first.RE?.[0] ?? '',
    rules: first.RU?.[0] ?? '',
    date: first.DT?.[0] ?? '',
  };
}

/**
 * 生成 SGF 文本
 * @param {object} opts
 * @param {number} opts.size
 * @param {number} opts.komi
 * @param {Array<{color:'B'|'W', x:number|null, y:number|null, pass?:boolean}>} opts.moves
 * @param {Array<{x:number,y:number}>} [opts.handicapStones]
 */
export function buildSgf({ size, komi, moves = [], handicapStones = [], playerBlack = 'Black', playerWhite = 'White' }) {
  const parts = ['(;GM[1]FF[4]CA[UTF-8]AP[围棋·KataGo:0.1]'];
  parts.push(`SZ[${size}]`);
  parts.push(`KM[${komi}]`);
  parts.push(`RU[Chinese]`);
  if (handicapStones.length) {
    parts.push(`HA[${handicapStones.length}]`);
    parts.push('AB' + handicapStones.map((p) => `[${pointToSgf(p.x, p.y)}]`).join(''));
  }
  parts.push(`PB[${playerBlack}]`);
  parts.push(`PW[${playerWhite}]`);
  for (const m of moves) {
    const coord = m.pass || m.x == null ? '' : pointToSgf(m.x, m.y);
    parts.push(`;${m.color}[${coord}]`);
  }
  parts.push(')');
  return parts.join('');
}

/** 从 SGF 的根节点里读出让子坐标（供本地棋盘初始化） */
export function handicapPointsFromSgf(game) {
  return game.setupBlack ?? [];
}
