/**
 * 引擎管理器：对上层暴露“对局语义”，隐藏 GTP 细节
 * - 按难度档位惰性启动 / 重启引擎（拟人档需要 -human-model 且 profile 在配置里）
 * - 运行时热切换 maxVisits / maxTime / playoutDoublingAdvantage
 * - 把 genmove 的搜索结果（候选点、胜率、ownership）结构化返回
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GtpEngine, parseGenmoveAnalyze } from './gtp.js';
import {
  levelById,
  engineProfileKey,
  generateCfg,
  runtimeParamsFor,
  tuningFor,
  normalizePerfMode,
  normalizeBackendMode,
  PERF,
  BACKEND,
} from './difficulty.js';
import { idxOf, idxToGtp } from '../shared/board.js';
import { execFile } from 'node:child_process';

/**
 * 后端注册表（按优先级排序）
 * - CUDA：NVIDIA，最快
 * - ROCm：AMD 原生（需自行放置构建）
 * - OpenVINO：Intel GPU/NPU（需自行放置构建）
 * - DirectML：任意支持 DX12 的显卡（AMD / Intel / NVIDIA）
 * - OpenCL：任意带 OpenCL 运行时的显卡（AMD / Intel / NVIDIA）
 * - CPU：兜底
 */
const BACKEND_DEFS = [
  { id: 'cuda', label: 'CUDA', sub: '', params: [], startupTimeoutMs: 180000 },
  { id: 'rocm', label: 'ROCm', sub: 'rocm', params: [], startupTimeoutMs: 180000 },
  {
    id: 'openvino',
    label: 'OpenVINO',
    sub: 'openvino',
    params: ['onnxProvider = openvino'],
    startupTimeoutMs: 600000,
  },
  {
    id: 'directml',
    label: 'DirectML',
    sub: 'directml',
    params: ['onnxProvider = directml'],
    startupTimeoutMs: 600000,
  },
  // OpenCL 首次运行要调优 GPU 内核，可能需要 1~3 分钟
  { id: 'opencl', label: 'OpenCL', sub: 'opencl', params: [], startupTimeoutMs: 420000 },
  { id: 'cpu', label: 'CPU', sub: 'cpu', params: [], startupTimeoutMs: 120000 },
];

function probeBackendLabel(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      const text = String(stdout || '') + String(stderr || '');
      const m = /Using\s+([^\n]+?)\s+backend/i.exec(text);
      resolve(m ? m[1].trim() : null);
    });
  });
}

export class EngineManager extends EventEmitter {
  constructor({
    rootDir,
    dataDir,
    engineRoot,
    threads = 6,
    perfMode = PERF.BALANCED,
    perfEngines = 1,
    trackHistory = true,
    backendMode = 'auto',
    // 指定调参（跑分用）：给了就完全覆盖按 perfMode 推导出来的线程/批次
    tuneOverride = null,
  }) {
    super();
    this.rootDir = rootDir;
    this.dataDir = dataDir ?? rootDir;
    this.threads = threads;
    this.perfMode = normalizePerfMode(perfMode);
    this.perfEngines = Math.max(1, perfEngines);
    this.trackHistory = trackHistory;
    // 后台计算方式：auto = 有 GPU 就用 GPU；gpu = 只用 GPU；cpu = 只用 CPU
    this.backendMode = normalizeBackendMode(backendMode);
    this.tuneOverride = tuneOverride ?? null;
    this.tune = this.tuneOverride ?? tuningFor({ mode: this.perfMode, threads, engines: this.perfEngines });
    // engine 目录可能是随包内置的（离线版），也可能是首次运行下载到用户目录的（精简安装）
    this.engineDir = engineRoot ?? path.join(rootDir, 'engine');
    this.cfgDir = path.join(this.dataDir, 'config', 'generated');
    this.models = {
      main: path.join(this.engineDir, 'weights', 'b18c384nbt.bin.gz'),
      human: path.join(this.engineDir, 'weights', 'b18c384nbt-humanv0.bin.gz'),
    };
    this.backends = BACKEND_DEFS.map((def) => ({
      ...def,
      exe: def.sub ? path.join(this.engineDir, def.sub, 'katago.exe') : path.join(this.engineDir, 'katago.exe'),
    })).filter((b) => existsSync(b.exe));
    this.backendId = null; // 当前使用的后端
    this.backendLabel = null;
    this.exeCandidates = this.backends.map((b) => b.exe);
    this.engine = null;
    this.exePath = null;
    this.activeKey = null;
    this.fast = false;
    this.level = levelById('lv4');
    this.size = 19;
    this.komi = 7.5;
    this.handicap = 0;
    // 引擎侧局面记录：引擎重启（换难度/切性能模式/崩溃）后据此恢复，避免棋盘失同步
    this.history = [];
    this.log = [];
  }

  _note(msg) {
    const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
    this.log.push(line);
    if (this.log.length > 300) this.log.shift();
    this.emit('log', line);
  }

  /** 探测可用的引擎可执行文件（CUDA 优先，失败回退 CPU） */
  async resolveExe() {
    if (this.exePath && existsSync(this.exePath)) return this.exePath;
    for (const exe of this.exeCandidates) {
      if (!existsSync(exe)) continue;
      this.exePath = exe;
      return exe;
    }
    throw new Error('找不到 katago 可执行文件，请检查 engine 目录');
  }

  /** 跑分调参带来的配置指纹后缀（两种 key 必须一致，否则每手都会重启引擎） */
  _benchSuffix() {
    return this.tuneOverride
      ? `-bench${this.tuneOverride.numSearchThreads}x${this.tuneOverride.nnMaxBatchSize}`
      : '';
  }

  /** 生成（或复用）某档位的配置文件，返回路径 */
  async ensureCfg(level, backendId = this.backendId ?? 'cuda') {
    await mkdir(this.cfgDir, { recursive: true });
    const backend = this.backends.find((b) => b.id === backendId);
    const backendParams = backend?.params ?? [];
    const baseKey = `${engineProfileKey(level, this.fast, this.perfMode)}@${backendId}${this._benchSuffix()}`;
    this.tune =
      this.tuneOverride ??
      tuningFor({
        mode: this.perfMode,
        threads: this.threads,
        engines: this.perfEngines,
        backendId,
      });
    const content =
      [
        ...generateCfg(level, {
          threads: this.threads,
          fast: this.fast,
          perfMode: this.perfMode,
          perfEngines: this.perfEngines,
          backendId,
          tune: this.tuneOverride,
        }),
        ...backendParams,
      ].join('\n') + '\n';
    // 用内容哈希命名：配置一改就自动失效，避免读到旧缓存
    const hash = createHash('sha1').update(content).digest('hex').slice(0, 8);
    const file = path.join(this.cfgDir, `${baseKey.replace(/[^a-z0-9]+/gi, '_')}-${hash}.cfg`);
    if (!existsSync(file)) {
      await writeFile(file, content, 'utf8');
    }
    return { file, key: baseKey };
  }

  /** 跑分专用配置：与当前档位、性能模式、计算方式都无关，固定按最大化参数生成 */
  async ensureBenchCfg(backendId, tune) {
    await mkdir(this.cfgDir, { recursive: true });
    const backend = this.backends.find((b) => b.id === backendId);
    const content =
      [
        ...generateCfg(levelById('lv8'), {
          threads: tune.numSearchThreads,
          perfMode: PERF.PERFORMANCE,
          perfEngines: 1,
          backendId,
          tune,
        }),
        ...(backend?.params ?? []),
      ].join('\n') + '\n';
    const hash = createHash('sha1').update(content).digest('hex').slice(0, 8);
    const file = path.join(this.cfgDir, `bench_${backendId}-${hash}.cfg`);
    if (!existsSync(file)) await writeFile(file, content, 'utf8');
    return { file, tune, params: backend?.params ?? [] };
  }

  /** 读取上次成功使用的后端（config/engine.json） */
  async loadCachedBackend() {
    try {
      const raw = await readFile(path.join(this.dataDir, 'config', 'engine.json'), 'utf8');
      const data = JSON.parse(raw);
      return data.backend ?? null;
    } catch {
      return null;
    }
  }

  async saveCachedBackend(id) {
    try {
      await mkdir(path.join(this.dataDir, 'config'), { recursive: true });
      await writeFile(
        path.join(this.dataDir, 'config', 'engine.json'),
        JSON.stringify({ backend: id, updatedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
    } catch {
      /* 缓存失败不影响使用 */
    }
  }

  /** 重新扫描 engine 目录下的可用后端（组件下载完成后调用） */
  refreshBackends() {
    this.backends = BACKEND_DEFS.map((def) => ({
      ...def,
      exe: def.sub ? path.join(this.engineDir, def.sub, 'katago.exe') : path.join(this.engineDir, 'katago.exe'),
    })).filter((b) => existsSync(b.exe));
    this.exeCandidates = this.backends.map((b) => b.exe);
    return this.backends;
  }

  /** 候选后端顺序：强制计算方式 > 环境变量覆盖 > 默认优先级 */
  preferredBackends() {
    if (!process.env.GO_BACKEND && this.backendMode === 'cpu') {
      const cpu = this.backends.filter((b) => b.id === 'cpu');
      if (cpu.length) return cpu;
      this._note('设置里选择「仅 CPU」，但没找到 CPU 版引擎，回退到自动选择');
    }
    if (!process.env.GO_BACKEND && this.backendMode === 'gpu') {
      const gpu = this.backends.filter((b) => b.id !== 'cpu');
      if (gpu.length) return gpu;
      this._note('设置里选择「仅 GPU」，但没找到 GPU 版引擎，回退到自动选择');
    }
    const forced =
      process.env.GO_BACKEND ||
      (process.argv.find((a) => a.startsWith('--backend=')) ?? '').split('=')[1] ||
      null;
    if (forced) {
      const hit = this.backends.filter((b) => b.id === forced.toLowerCase());
      if (hit.length) return [...hit, ...this.backends.filter((b) => b.id !== hit[0].id)];
      this._note(`指定的后端 ${forced} 不存在，回退到自动选择`);
    }
    // 顺序固定按优先级：总是优先尝试最好的后端，避免旧缓存把机器钉在次优后端上
    return [...this.backends];
  }

  /** 切换后台计算方式（auto / gpu / cpu）；改了要重启引擎才生效 */
  async setBackendMode(mode) {
    const next = normalizeBackendMode(mode);
    if (next === this.backendMode) return { changed: false, restarted: false, backendMode: next };
    this.backendMode = next;
    const wasRunning = Boolean(this.engine?.running);
    if (this.engine) {
      await this.engine.stop().catch(() => {});
      this.engine = null;
      this.activeKey = null;
    }
    const label = next === 'cpu' ? '仅 CPU' : next === 'gpu' ? '仅 GPU' : '自动';
    this._note(`后台计算方式 → ${label}（下次启动引擎时生效）`);
    return { changed: true, restarted: wasRunning, backendMode: next };
  }

  _cfgKey(level, backendId) {
    return `${engineProfileKey(level, this.fast, this.perfMode)}@${backendId}${this._benchSuffix()}`;
  }

  /** 确保引擎处于该档位所需状态（按后端优先级逐个尝试） */
  async ensureEngine(level = this.level) {
    if (this._cachedBackend === undefined) this._cachedBackend = await this.loadCachedBackend();

    const candidates = this.preferredBackends();
    if (!candidates.length) throw new Error('找不到任何可用的 katago 可执行文件');

    // 已经在用同样的后端 + 同样的配置，直接复用
    if (this.engine && this.engine.running && this.activeKey === this._cfgKey(level, this.backendId)) {
      return this.engine;
    }

    if (this.engine) {
      await this.engine.stop().catch(() => {});
      this.engine = null;
      this.activeKey = null;
    }

    const errors = [];
    for (const backend of candidates) {
      const { file, key } = await this.ensureCfg(level, backend.id);
      const engine = new GtpEngine({
        exe: backend.exe,
        configPath: file,
        modelPath: this.models.main,
        humanModelPath: level.backend === BACKEND.HUMAN ? this.models.human : null,
        cwd: path.dirname(backend.exe),
        startupTimeoutMs: backend.startupTimeoutMs ?? 180000,
      });
      if (['opencl', 'directml', 'openvino'].includes(backend.id)) {
        this.emit('initializing', { backend: backend.id, label: backend.label });
        this._note(`正在用 ${backend.label} 初始化 GPU（首次可能需要 1~3 分钟调优/编译）`);
      }
      engine.on('stderr', (l) => {
        if (/error|exception|unable|failed/i.test(l)) this._note(`[${backend.label}] ${l}`);
      });
      engine.on('exit', ({ code, unexpected }) => {
        if (unexpected) {
          this._note(`[引擎] 意外退出 code=${code}`);
          this.emit('crashed', { code });
        }
      });
      try {
        const hs = await engine.start();
        this.engine = engine;
        this.exePath = backend.exe;
        this.backendId = backend.id;
        this.backendLabel = backend.label;
        this.activeKey = key;
        // 用 exe 的 version 输出确认实际后端（如 CUDA / OpenCL / ONNX Runtime / Eigen(CPU)）
        this.backendDetail = await probeBackendLabel(backend.exe);
        this._note(
          `引擎启动成功 ${backend.label}${this.backendDetail ? `（${this.backendDetail}）` : ''}  ${hs.version}`,
        );
        this._note(
          `搜索参数：${this.tune.numSearchThreads} 线程 · batch ${this.tune.nnMaxBatchSize} · NN server ${
            this.tune.numNNServerThreadsPerModel
          }（${this.perfMode === PERF.PERFORMANCE ? '性能模式' : '省电模式'}）`,
        );
        this._cachedBackend = backend.id;
        if (!process.env.GO_BACKEND && !process.argv.some((a) => a.startsWith('--backend='))) {
          await this.saveCachedBackend(backend.id);
        }
        this.emit('ready', { ...hs, backend: backend.id });
        await this._restoreBoard();
        await this.applyRuntimeParams(level);
        return engine;
      } catch (err) {
        errors.push(`${backend.label}: ${err.message}`);
        this._note(`${backend.label} 启动失败：${err.message}`);
        try {
          await engine.stop();
        } catch {
          /* ignore */
        }
      }
    }
    throw new Error('引擎启动失败（已尝试所有后端）：\n' + errors.join('\n'));
  }

  async _applyBoardSettings() {
    const e = this.engine;
    if (!e) return;
    await e.command(`boardsize ${this.size}`, 30000);
    await e.command('kata-set-rules rules=chinese', 30000).catch(() => {});
    await e.command(`komi ${this.komi}`, 30000);
  }

  /**
   * 引擎（重新）启动后恢复局面。
   * 新进程是空盘，如果这时界面上已经有棋子，不重放就会「引擎不知道自己在哪」，
   * 表现为回错手、非法着法或胜率突然跳到 50%。
   */
  async _restoreBoard() {
    const e = this.engine;
    if (!e) return;
    await this._applyBoardSettings();
    if (!this.trackHistory || !this.history.length) return;

    await e.command('clear_board', 30000);
    if (this.handicap > 0) {
      await e.command(`fixed_handicap ${this.handicap}`, 30000).catch((err) => {
        this._note(`恢复让子失败：${err.message}`);
      });
    }
    for (const m of this.history) {
      await e.command(`play ${m.color} ${m.coord}`, 30000).catch((err) => {
        this._note(`恢复第 ${m.n} 手（${m.color} ${m.coord}）失败：${err.message}`);
      });
    }
    this._note(`引擎已恢复局面：${this.history.length} 手${this.handicap > 0 ? `（让 ${this.handicap} 子）` : ''}`);
  }

  /** 热切换搜索参数 */
  async applyRuntimeParams(level = this.level) {
    const e = this.engine;
    if (!e) return;
    const p = runtimeParamsFor(level);
    const cmds = [
      `kata-set-param maxVisits ${p.maxVisits}`,
      `kata-set-param maxTime ${p.maxTime}`,
      `kata-set-param playoutDoublingAdvantage ${p.playoutDoublingAdvantage}`,
    ];
    for (const c of cmds) {
      try {
        await e.command(c, 20000);
      } catch (err) {
        this._note(`参数设置失败 ${c}: ${err.message}`);
      }
    }
  }

  /** 快速模式：关闭拟人延迟（测速/自对弈用） */
  setFast(fast) {
    this.fast = Boolean(fast);
  }

  /**
   * 切换性能模式（省电 / 高吞吐）。
   * 线程数与批大小写在 cfg 里，属于「配置级」参数，必须重启引擎才生效；
   * 局面由 history 在重启后自动恢复。
   */
  async setPerfMode(mode) {
    const next = normalizePerfMode(mode);
    if (next === this.perfMode) {
      return { changed: false, restarted: false, tune: this.tune };
    }
    this.perfMode = next;
    this.tune = tuningFor({ mode: next, threads: this.threads, engines: this.perfEngines });
    const wasRunning = Boolean(this.engine?.running);
    if (this.engine) {
      await this.engine.stop().catch(() => {});
      this.engine = null;
      this.activeKey = null;
    }
    this._note(`性能模式 → ${next === PERF.PERFORMANCE ? '高吞吐' : '省电'}（下次落子/分析时重启引擎生效）`);
    return { changed: true, restarted: wasRunning, tune: this.tune };
  }

  /** 选择难度：必要时重启引擎，否则只改搜索参数 */
  async setLevel(levelId) {
    const level = levelById(levelId);
    this.level = level;
    // 只有配置指纹（含后端）真的变了才需要重启；同一后端下换档位走热切换
    const needRestart =
      !this.engine?.running || (this.backendId ? this.activeKey !== this._cfgKey(level, this.backendId) : false);
    await this.ensureEngine(level);
    if (!needRestart) await this.applyRuntimeParams(level);
    this._note(`难度切换为 ${level.label}（${level.rank}）${needRestart ? '（已重启引擎）' : '（热切换）'}`);
    return { level: level.id, restarted: needRestart };
  }

  async newGame({ size = this.size, komi = this.komi, levelId = this.level.id, handicap = 0 } = {}) {
    this.size = size;
    this.komi = komi;
    this.level = levelById(levelId);
    this.handicap = handicap;
    this.history = [];
    const e = await this.ensureEngine(this.level);
    // 顺序很重要：boardsize 会重建棋盘，必须放在 clear_board 之前，
    // 之后 clear_board 再兜一次底，最后才是 fixed_handicap（它要求空盘）
    await e.command(`boardsize ${size}`, 30000);
    await e.command('clear_board', 30000);
    await e.command(`komi ${komi}`, 30000);
    if (handicap > 0) {
      const stones = String(await e.command(`fixed_handicap ${handicap}`, 30000))
        .split(/\s+/)
        .filter(Boolean);
      this._note(`让 ${handicap} 子: ${stones.join(' ')}`);
      this.awaitingHandicap = true;
      return { handicapStones: stones };
    }
    this.awaitingHandicap = false;
    await this.applyRuntimeParams(this.level);
    return { handicapStones: [] };
  }

  async play(color, coord) {
    const e = await this.ensureEngine();
    await e.command(`play ${color} ${coord}`, 60000);
    if (this.trackHistory) this.history.push({ n: this.history.length + 1, color, coord });
  }

  async undo(times = 1) {
    const e = await this.ensureEngine();
    for (let i = 0; i < times; i++) {
      try {
        await e.command('undo', 30000);
        if (this.trackHistory) this.history.pop();
      } catch {
        /* 没有可悔的棋时忽略 */
      }
    }
  }

  /** AI 落子，同时返回这一手的完整搜索结果 */
  async genmove(color) {
    const e = await this.ensureEngine();
    const t0 = Date.now();
    const budget = Math.max(15000, this.level.maxTimeMs * 4);
    const raw = await e.command(`kata-genmove_analyze ${color} interval 100 ownership true`, budget);
    const { move, infos, ownership } = parseGenmoveAnalyze(raw);
    const elapsedMs = Date.now() - t0;
    if (this.trackHistory && move && !/^resign$/i.test(String(move).trim())) {
      this.history.push({ n: this.history.length + 1, color, coord: String(move).trim() });
    }
    this._note(`${color} genmove -> ${move} (${elapsedMs}ms, ${infos.length} 候选)`);
    return {
      move,
      elapsedMs,
      candidates: infos.slice(0, 8).map((i) => ({
        move: i.move,
        visits: i.visits,
        winrate: i.winrate,
        scoreLead: i.scoreLead,
        prior: i.prior,
        pv: i.pv ?? [],
      })),
      ownership: ownership ?? null,
      winrate: infos[0]?.winrate ?? null,
      scoreLead: infos[0]?.scoreLead ?? null,
    };
  }

  /** 终局判定：引擎规则下的最终比分 + 死子列表 */
  async finalScore() {
    const e = await this.ensureEngine();
    const score = await e.command('final_score', 60000);
    let dead = [];
    try {
      const list = await e.command('final_status_list dead', 30000);
      dead = String(list).split(/\s+/).filter(Boolean);
    } catch {
      /* 规则不支持时忽略 */
    }
    this._note(`终局判定 ${score}`);
    return { score: String(score).trim(), dead };
  }

  /** 供复盘使用的局面评估（不落子） */
  async evaluate() {
    const e = await this.ensureEngine();
    const raw = await e.command('kata-analyze interval 1 ownership true', 120000).catch(() => '');
    return raw;
  }

  /** 让子：由引擎给出标准星位坐标，返回 GTP 坐标列表 */
  async applyHandicap(count) {
    const e = await this.ensureEngine();
    if (!count || count <= 0) return [];
    const out = String(await e.command(`fixed_handicap ${count}`, 30000)).trim();
    const stones = out.split(/\s+/).filter(Boolean);
    this._note(`让 ${count} 子：${stones.join(' ')}`);
    return stones;
  }

  /** 评估当前局面（不落子）。intervalCs 是 KataGo 的更新间隔，单位厘秒 */
  async evaluatePosition({ visits = 200, maxMs = 600, timeoutMs = 20000, intervalCs = 20 } = {}) {
    const e = await this.ensureEngine();
    const snap = await e.analyzePosition({ minVisits: visits, maxMs, timeoutMs, intervalCs });
    const root = snap.rootInfo ?? {};
    return {
      winrate: typeof root.winrate === 'number' ? root.winrate : null,
      scoreLead: typeof root.scoreLead === 'number' ? root.scoreLead : null,
      visits: snap.visits ?? 0,
      candidates: (snap.moves ?? []).slice(0, 6),
    };
  }

  /** 强制重启引擎（复盘等长任务自愈时用） */
  async hardRestart() {
    if (this.engine) {
      await this.engine.stop().catch(() => {});
      this.engine = null;
      this.activeKey = null;
    }
    return this.ensureEngine();
  }

  /**
   * 复盘扫描：按棋谱顺序逐手评估，返回每一手的局面胜率
   * 采用「前进式」扫描（评估 → 落子 → 评估），比分步重放快得多。
   *
   * 自愈：GPU 驱动/内核调优有时会让引擎短时间不应答（表现为 GTP 超时），
   * 这时自动重启引擎、重放已完成的前缀，再从断点继续，而不是整盘作废。
   */
  async reviewGame({
    size,
    komi,
    handicap = 0,
    moves = [],
    visits = 200,
    perMoveMs = 600,
    onProgress,
    maxRetries = 2,
  } = {}) {
    const coordOf = (m) => (m.pass ? 'pass' : idxToGtp(idxOf(m.x, m.y, size), size));
    // 复盘期间每手要落子，给宽松些的超时：慢速 GPU（首次内核调优）也需要余量
    const cmdTimeout = 60000;

    const timeline = [];
    let handicapStones = [];

    const record = async (index, move, toPlay) => {
      const t0 = Date.now();
      const ev = await this.evaluatePosition({ visits, maxMs: perMoveMs, timeoutMs: 25000 });
      const costMs = Date.now() - t0;
      if (costMs > 2500) this._note(`复盘第 ${index} 手评估耗时 ${costMs}ms（访问 ${ev.visits}）`);
      const blackWin = ev.winrate == null ? null : toPlay === 'B' ? ev.winrate : 1 - ev.winrate;
      const scoreLeadBlack = ev.scoreLead == null ? null : toPlay === 'B' ? ev.scoreLead : -ev.scoreLead;
      timeline.push({
        index,
        costMs,
        move,
        toPlay,
        blackWin,
        scoreLeadBlack,
        visits: ev.visits,
        candidates: (ev.candidates ?? []).slice(0, 4).map((c) => ({
          move: c.move,
          visits: c.visits,
          winrate: c.winrate,
          pv: c.pv ?? [],
        })),
      });
    };

    /** 把引擎摆到「已落 n 手」的局面 */
    const seek = async (n) => {
      const e = await this.ensureEngine();
      await e.command(`boardsize ${size}`, cmdTimeout);
      await e.command('clear_board', cmdTimeout);
      await e.command(`komi ${komi}`, cmdTimeout);
      handicapStones = [];
      if (handicap > 0) handicapStones = await this.applyHandicap(handicap);
      for (let i = 0; i < n; i++) {
        const m = moves[i];
        await e.command(`play ${m.color} ${coordOf(m)}`, cmdTimeout);
      }
    };

    let attempt = 0;
    for (;;) {
      try {
        if (timeline.length === 0) {
          await seek(0);
          await record(0, null, handicapStones.length ? 'W' : 'B');
        }
        for (let i = timeline.length - 1; i < moves.length; i++) {
          const m = moves[i];
          const coord = coordOf(m);
          const e = await this.ensureEngine();
          await e.command(`play ${m.color} ${coord}`, cmdTimeout);
          await record(i + 1, { ...m, gtp: coord }, m.color === 'B' ? 'W' : 'B');
          onProgress?.({ done: i + 1, total: moves.length });
        }
        return { timeline, handicapStones, retries: attempt };
      } catch (err) {
        const retriable = /超时|timeout|退出|EPERM|not running|进程|关闭|socket/i.test(err.message);
        const doneMoves = Math.max(0, timeline.length - 1);
        if (!retriable || attempt >= maxRetries) {
          this._note(`复盘在第 ${doneMoves + 1}/${moves.length} 手失败：${err.message}`);
          throw err;
        }
        attempt += 1;
        this._note(
          `复盘中断（${err.message.slice(0, 90)}）→ 重启引擎，从第 ${doneMoves} 手后继续（第 ${attempt} 次重试）`,
        );
        await this.hardRestart().catch(() => {});
      }
    }
  }

  async shutdown() {
    if (this.engine) {
      await this.engine.stop().catch(() => {});
      this.engine = null;
      this.activeKey = null;
    }
  }

  status() {
    return {
      running: Boolean(this.engine?.running),
      exe: this.exePath,
      level: { id: this.level.id, label: this.level.label, rank: this.level.rank },
      size: this.size,
      komi: this.komi,
      profileKey: this.activeKey,
      backend: this.backendId,
      backendLabel: this.backendLabel,
      backendDetail: this.backendDetail ?? null,
      perfMode: this.perfMode,
      tune: this.tune,
      log: this.log.slice(-20),
    };
  }
}
