/**
 * AI 对 AI 观战 / 对战测速
 * - 双引擎实例（黑方、白方各一个进程，可分别设置难度）
 * - 单局观战：逐手推送事件给界面
 * - 批量对战：交替黑白跑 N 局，按胜率估算 ELO 差
 */
import { EventEmitter } from 'node:events';
import { EngineManager } from './engineManager.js';
import { createState, playMove, playPass, placeStones, gtpToIdx, xOf, yOf, BLACK, WHITE } from '../shared/board.js';

const RESIGN = 'resign';

export class SpectateRunner extends EventEmitter {
  constructor({ rootDir, dataDir, engineRoot, threads = 6 } = {}) {
    super();
    this.rootDir = rootDir;
    this.dataDir = dataDir ?? rootDir;
    this.engineRoot = engineRoot ?? null;
    this.threads = threads;
    this.engines = null;
    this.aborted = false;
    this.paused = false;
  }

  _ensureEngines() {
    if (this.engines) return this.engines;
    const make = (name) => {
      const mgr = new EngineManager({
        rootDir: this.rootDir,
        dataDir: this.dataDir,
        engineRoot: this.engineRoot ?? undefined,
        threads: this.threads,
      });
      mgr.on('log', (line) => this.emit('log', `[${name}] ${line}`));
      return mgr;
    };
    this.engines = { A: make('A'), B: make('B') };
    return this.engines;
  }

  async _setVisits(mgr, visits) {
    if (!visits) return;
    const e = await mgr.ensureEngine();
    await e.command(`kata-set-param maxVisits ${visits}`, 20000).catch(() => {});
  }

  async configure({ levelA, levelB, visitsA, visitsB, labelA = 'A', labelB = 'B' }) {
    const engines = this._ensureEngines();
    engines.A.setFast(true);
    engines.B.setFast(true);
    await engines.A.setLevel(levelA);
    await engines.B.setLevel(levelB);
    await this._setVisits(engines.A, visitsA);
    await this._setVisits(engines.B, visitsB);
    this.emit('log', `对局配置：${labelA}=${levelA}  ${labelB}=${levelB}`);
  }

  /** 观战模式：A 执黑、B 执白（单局） */
  async configureSides({ levelBlack, levelWhite, visitsBlack, visitsWhite }) {
    await this.configure({ levelA: levelBlack, levelB: levelWhite, visitsA: visitsBlack, visitsB: visitsWhite, labelA: '黑', labelB: '白' });
  }

  /** 让两个引擎都把棋盘清成同一个初始局面 */
  async _resetBoard({ size, komi, handicap, blackIsA = true }) {
    const engines = this._ensureEngines();
    for (const side of ['A', 'B']) {
      const e = await engines[side].ensureEngine();
      await e.command(`boardsize ${size}`, 30000);
      await e.command('clear_board', 30000);
      await e.command(`komi ${komi}`, 30000);
    }

    let stones = [];
    if (handicap > 0) {
      const blackMgr = blackIsA ? engines.A : engines.B;
      stones = await blackMgr.applyHandicap(handicap);
      const whiteEngine = await (blackIsA ? engines.B : engines.A).ensureEngine();
      for (const gtp of stones) await whiteEngine.command(`play B ${gtp}`, 30000);
    }
    return stones;
  }

  async _sleep(ms) {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  /**
   * 下一整局
   * @returns {Promise<{result:string, moves:Array, winner:'B'|'W'|null}>}
   */
  /** 开始前重置中止标记（由调用方在启动时调用，避免被 playGame 内部重置而丢掉停止请求） */
  reset() {
    this.aborted = false;
    this.paused = false;
  }

  async playGame({ size = 19, komi = 7.5, handicap = 0, maxMoves = 400, paceMs = 0, blackIsA = true, onMove } = {}) {
    if (this.aborted) return { result: 'aborted', moves: [], winner: null };
    const engines = this._ensureEngines();
    const stones = await this._resetBoard({ size, komi, handicap, blackIsA });
    if (this.aborted) return { result: 'aborted', moves: [], winner: null };

    this.emit('gameStart', { size, komi, handicap, stones });

    let state = createState(size, { komi });
    if (stones.length) {
      const pts = stones
        .map((g) => gtpToIdx(g, size))
        .filter((i) => i >= 0)
        .map((i) => ({ x: xOf(i, size), y: yOf(i, size) }));
      state = placeStones(state, 'B', pts);
      state = { ...state, turn: WHITE };
    }

    const moves = [];
    let passes = 0;

    for (let n = 0; n < maxMoves; n++) {
      if (this.aborted) return { result: 'aborted', moves, winner: null };
      while (this.paused && !this.aborted) await this._sleep(80);

      const color = state.turn === BLACK ? 'B' : 'W';
      const mgr = color === 'B' ? (blackIsA ? engines.A : engines.B) : blackIsA ? engines.B : engines.A;

      if (this.aborted) return { result: 'aborted', moves, winner: null };

      let res;
      try {
        res = await mgr.genmove(color);
      } catch (err) {
        this.emit('log', `引擎异常：${err.message}`);
        return { result: 'error', moves, winner: null, error: err.message };
      }

      const coord = String(res.move ?? '').trim();
      if (RESIGN === coord.toLowerCase()) {
        const winner = color === 'B' ? 'W' : 'B';
        this.emit('log', `${color === 'B' ? '黑' : '白'}棋认输`);
        return { result: 'resign', moves, winner };
      }

      if (coord.toLowerCase() === 'pass') {
        state = playPass(state).state;
        passes += 1;
        moves.push({ color, pass: true, elapsedMs: res.elapsedMs });
      } else {
        const idx = gtpToIdx(coord, size);
        if (idx < 0) {
          this.emit('log', `无法解析着法 ${coord}`);
          return { result: 'error', moves, winner: null };
        }
        const r = playMove(state, xOf(idx, size), yOf(idx, size));
        if (!r.ok) {
          this.emit('log', `引擎返回非法着法 ${coord}（${r.reason}）`);
          return { result: 'error', moves, winner: null };
        }
        state = r.state;
        passes = 0;
        moves.push({
          color,
          x: xOf(idx, size),
          y: yOf(idx, size),
          gtp: coord,
          elapsedMs: res.elapsedMs,
          winrate: res.winrate,
          scoreLead: res.scoreLead,
          candidates: (res.candidates ?? []).slice(0, 3),
        });

        // 同步给另一个引擎
        const other = color === 'B' ? (blackIsA ? engines.B : engines.A) : blackIsA ? engines.A : engines.B;
        const otherEngine = await other.ensureEngine();
        await otherEngine.command(`play ${color} ${coord}`, 30000).catch((err) => {
          this.emit('log', `同步着法失败：${err.message}`);
        });
      }

      this.emit('move', {
        color,
        move: moves[moves.length - 1],
        moveNumber: n + 1,
        passCount: passes,
      });
      onMove?.(moves[moves.length - 1]);
      if (paceMs) await this._sleep(paceMs);

      if (passes >= 2) {
        const score = await this._finalScore(blackIsA ? engines.A : engines.B);
        return { result: 'score', moves, winner: score.winner, score: score.text };
      }
    }
    return { result: 'maxmoves', moves, winner: null };
  }

  async _finalScore(mgr) {
    try {
      const e = await mgr.ensureEngine();
      const text = String(await e.command('final_score', 60000)).trim();
      const winner = text.startsWith('B') ? 'B' : text.startsWith('W') ? 'W' : null;
      return { text, winner };
    } catch {
      return { text: '', winner: null };
    }
  }

  /**
   * 批量对战并估算 ELO 差
   * 交替黑白以消除先手优势；elo = 400 * log10(P/(1-P))，P 用平滑后的胜率
   */
  async runMatch({
    games = 6,
    size = 9,
    komi = 7,
    handicap = 0,
    levelA = 'lv3',
    levelB = 'lv5',
    visitsA,
    visitsB,
    pausingBetweenGames = 0,
    onGameEnd,
    onProgress,
  } = {}) {
    this.aborted = false;
    const results = [];
    let winsA = 0;
    let winsB = 0;
    let draws = 0;

    this.reset();
    // 引擎与选手绑定，整场只配置一次；每局通过 blackIsA 换边，避免反复重启引擎
    await this.configure({ levelA, levelB, visitsA, visitsB });
    this.emit('log', `测速开始：A=${levelA} vs B=${levelB}，${games} 局`);

    for (let g = 0; g < games; g++) {
      if (this.aborted) break;
      const aIsBlack = g % 2 === 0;
      this.emit('log', `第 ${g + 1}/${games} 局：${aIsBlack ? 'A 执黑' : 'B 执黑'}`);
      const r = await this.playGame({ size, komi, handicap, maxMoves: 400, blackIsA: aIsBlack });
      let winnerSide = r.winner; // 'B' | 'W' | null
      let aWon = null;
      if (winnerSide === 'B') aWon = aIsBlack;
      else if (winnerSide === 'W') aWon = !aIsBlack;

      if (aWon === true) winsA++;
      else if (aWon === false) winsB++;
      else draws++;

      results.push({ game: g + 1, result: r.result, winner: winnerSide, aIsBlack, aWon });
      this.emit('gameEnd', { game: g + 1, games, aIsBlack, winner: winnerSide, result: r.result, winsA, winsB, draws });
      onGameEnd?.(results[results.length - 1]);
      onProgress?.({ done: g + 1, total: games, winsA, winsB, draws });
      if (pausingBetweenGames) await this._sleep(pausingBetweenGames);
    }

    const decided = winsA + winsB;
    const p = decided > 0 ? (winsA + 0.5) / (decided + 1) : 0.5;
    const elo = decided > 0 ? Math.round(-400 * Math.log10(1 / p - 1)) : 0;
    const summary = {
      games: winsA + winsB + draws,
      winsA,
      winsB,
      draws,
      winRateA: decided ? winsA / decided : 0.5,
      eloAminusB: elo,
      aborted: this.aborted,
    };
    this.emit('matchEnd', summary);
    return summary;
  }

  stop() {
    this.aborted = true;
    this.paused = false;
  }

  async shutdown() {
    this.aborted = true;
    if (!this.engines) return;
    for (const mgr of Object.values(this.engines)) await mgr.shutdown().catch(() => {});
    this.engines = null;
  }
}
