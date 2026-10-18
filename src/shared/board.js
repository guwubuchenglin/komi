/**
 * 围棋规则引擎（纯 JS，主进程与渲染进程共用，不依赖 Node/Electron）
 * 规则：中国规则（数子），简单劫，禁止自杀，禁止落子于已有棋子处。
 *
 * 坐标：内部一律用 idx = y * size + x，y 从上往下、x 从左往右，与 UI 一致。
 */

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

/** GTP 列字母：跳过 I */
const GTP_LETTERS = "ABCDEFGHJKLMNOPQRSTUVWXYZ";

export const opponent = (color) => (color === BLACK ? WHITE : BLACK);

export function createState(size = 19, { komi = 7.5 } = {}) {
  const board = new Int8Array(size * size);
  return {
    size,
    komi,
    board,
    turn: BLACK,
    koPoint: -1,
    passCount: 0,
    moveNumber: 0,
    captures: { [BLACK]: 0, [WHITE]: 0 },
    history: [], // {type:'move'|'pass', x, y, color, captured:[], prevState}
  };
}

export function cloneState(state) {
  return {
    ...state,
    board: Int8Array.from(state.board),
    captures: { ...state.captures },
    history: state.history,
  };
}

export const idxOf = (x, y, size) => y * size + x;
export const xOf = (idx, size) => idx % size;
export const yOf = (idx, size) => Math.floor(idx / size);

export function neighbors(idx, size) {
  const x = xOf(idx, size);
  const y = yOf(idx, size);
  const out = [];
  if (x > 0) out.push(idx - 1);
  if (x < size - 1) out.push(idx + 1);
  if (y > 0) out.push(idx - size);
  if (y < size - 1) out.push(idx + size);
  return out;
}

/** 取某点所属棋块的棋子与气 */
export function group(board, size, idx) {
  const color = board[idx];
  if (color === EMPTY) return { stones: [], liberties: new Set() };
  const stones = [];
  const liberties = new Set();
  const seen = new Uint8Array(board.length);
  const stack = [idx];
  seen[idx] = 1;
  while (stack.length) {
    const cur = stack.pop();
    stones.push(cur);
    for (const n of neighbors(cur, size)) {
      const v = board[n];
      if (v === EMPTY) liberties.add(n);
      else if (v === color && !seen[n]) {
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
  return { stones, liberties };
}

/**
 * 试下并返回结果，不修改输入 state。
 * @returns {{ok:boolean, reason?:string, state?:object, captured?:number[]}}
 */
export function playMove(state, x, y) {
  const { size, board, turn, koPoint } = state;
  if (x < 0 || y < 0 || x >= size || y >= size) return { ok: false, reason: "超出棋盘" };
  const idx = idxOf(x, y, size);
  if (board[idx] !== EMPTY) return { ok: false, reason: "该点已有棋子" };
  if (idx === koPoint) return { ok: false, reason: "劫争：不能立即回提" };

  const next = Int8Array.from(board);
  next[idx] = turn;

  // 提子
  const captured = [];
  for (const n of neighbors(idx, size)) {
    if (next[n] === opponent(turn)) {
      const g = group(next, size, n);
      if (g.liberties.size === 0) captured.push(...g.stones);
    }
  }
  for (const c of captured) next[c] = EMPTY;

  // 自杀判定
  if (captured.length === 0) {
    const own = group(next, size, idx);
    if (own.liberties.size === 0) return { ok: false, reason: "自杀" };
  }

  // 劫的判定：只有当「提掉的是一子」且「提子方这枚棋子自己只剩一口气（即刚被提的那点）」时才是劫。
  // 之前错误地把所有单子提吃都当劫，会导致引擎合法着法被本地规则判为非法。
  let nextKo = -1;
  if (captured.length === 1) {
    const own = group(next, size, idx);
    if (own.stones.length === 1 && own.liberties.size === 1) {
      nextKo = captured[0];
    }
  }

  const newCaptures = { ...state.captures };
  newCaptures[turn] += captured.length;

  const newState = {
    ...state,
    board: next,
    turn: opponent(turn),
    koPoint: nextKo,
    passCount: 0,
    moveNumber: state.moveNumber + 1,
    captures: newCaptures,
    history: [...state.history, { type: "move", x, y, color: turn, captured }],
  };
  return { ok: true, state: newState, captured };
}

/** 直接摆放棋子（让子用），不改变行棋方 */
export function placeStones(state, color, points) {
  const board = Int8Array.from(state.board);
  for (const p of points) board[idxOf(p.x, p.y, state.size)] = color === BLACK || color === 'B' ? BLACK : WHITE;
  return { ...state, board };
}

export function playPass(state) {
  return {
    ok: true,
    state: {
      ...state,
      turn: opponent(state.turn),
      koPoint: -1,
      passCount: state.passCount + 1,
      moveNumber: state.moveNumber + 1,
      history: [...state.history, { type: "pass", color: state.turn }],
    },
  };
}

export function resign(state) {
  return {
    ok: true,
    state: { ...state, history: [...state.history, { type: "resign", color: state.turn }] },
  };
}

/** 悔棋：撤销最后两手（人机对战一次退回自己的回合） */
export function undo(state, plies = 1) {
  let s = state;
  for (let i = 0; i < plies && s.history.length > 0; i++) s = undoOne(s);
  return s;
}

function undoOne(state) {
  const last = state.history[state.history.length - 1];
  if (!last) return state;
  const board = Int8Array.from(state.board);
  const captures = { ...state.captures };
  let koPoint = -1;

  if (last.type === "move") {
    board[idxOf(last.x, last.y, state.size)] = EMPTY;
    for (const c of last.captured) board[c] = last.color === BLACK ? WHITE : BLACK;
    captures[last.color] -= last.captured.length;
    // 劫点状态无法完美回滚，简化处理：清空
    koPoint = -1;
  }

  return {
    ...state,
    board,
    turn: last.color,
    captures,
    koPoint,
    passCount: 0,
    moveNumber: Math.max(0, state.moveNumber - 1),
    history: state.history.slice(0, -1),
  };
}

/** 全部合法着点（用于提示/分析） */
export function legalMoves(state) {
  const out = [];
  for (let idx = 0; idx < state.board.length; idx++) {
    if (state.board[idx] !== EMPTY) continue;
    const r = playMove(state, xOf(idx, state.size), yOf(idx, state.size));
    if (r.ok) out.push(idx);
  }
  return out;
}

/**
 * 中国规则数子（面积法）
 * @param {object} state
 * @param {Set<number>} deadIdxs 已被判定为死子的点
 * @returns {{black:number, white:number, komi:number, territory:{black:number,white:number}, stones:{black:number,white:number}}}
 */
export function scoreArea(state, deadIdxs = new Set()) {
  const { size } = state;
  const board = Int8Array.from(state.board);
  for (const d of deadIdxs) board[d] = EMPTY;

  let blackStones = 0;
  let whiteStones = 0;
  for (let i = 0; i < board.length; i++) {
    if (board[i] === BLACK) blackStones++;
    else if (board[i] === WHITE) whiteStones++;
  }

  let blackTerr = 0;
  let whiteTerr = 0;
  const seen = new Uint8Array(board.length);
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== EMPTY || seen[i]) continue;
    // 洪水填充空区，统计边界颜色
    const region = [];
    const stack = [i];
    seen[i] = 1;
    let touchBlack = false;
    let touchWhite = false;
    while (stack.length) {
      const cur = stack.pop();
      region.push(cur);
      for (const n of neighbors(cur, size)) {
        const v = board[n];
        if (v === EMPTY) {
          if (!seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        } else if (v === BLACK) touchBlack = true;
        else touchWhite = true;
      }
    }
    if (touchBlack && !touchWhite) blackTerr += region.length;
    else if (touchWhite && !touchBlack) whiteTerr += region.length;
    // 双方都接触 = 单官，不计
  }

  return {
    black: blackStones + blackTerr,
    white: whiteStones + whiteTerr + state.komi,
    komi: state.komi,
    stones: { black: blackStones, white: whiteStones },
    territory: { black: blackTerr, white: whiteTerr },
  };
}

/** 依据 KataGo ownership 建议死子（ownership < -0.5 视作死子） */
export function deadFromOwnership(state, ownership) {
  const dead = new Set();
  if (!ownership || ownership.length !== state.board.length) return dead;
  for (let i = 0; i < ownership.length; i++) {
    const v = ownership[i];
    if (state.board[i] === BLACK && v < -0.5) dead.add(i);
    if (state.board[i] === WHITE && v > 0.5) dead.add(i);
  }
  return dead;
}

// ------------------------------------------------------------------ GTP 坐标

export function idxToGtp(idx, size) {
  const x = xOf(idx, size);
  const y = yOf(idx, size);
  return `${GTP_LETTERS[x]}${size - y}`;
}

export function gtpToIdx(str, size) {
  const m = /^([A-Za-z])(\d+)$/.exec(str.trim());
  if (!m) return -1;
  const x = GTP_LETTERS.indexOf(m[1].toUpperCase());
  const row = Number(m[2]);
  if (x < 0 || row < 1 || row > size) return -1;
  return idxOf(x, size - row, size);
}
