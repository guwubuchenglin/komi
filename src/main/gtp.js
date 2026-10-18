/**
 * KataGo GTP 客户端
 * - 进程生命周期管理（启动 / 崩溃重启 / 退出）
 * - GTP 命令串行队列 + 超时保护
 * - 解析 `id status body` 响应，以及 kata-analyze / kata-genmove_analyze 的流式输出
 *
 * 纯 Node 实现，不依赖 Electron，脚本里可直接使用。
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';

const RESPONSE_START = /^([=?])(\d*)[ \t]?([\s\S]*)$/;

export class GtpEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.exe
   * @param {string} opts.configPath
   * @param {string} opts.modelPath
   * @param {string} [opts.humanModelPath]
   * @param {string[]} [opts.extraArgs]
   * @param {string} [opts.cwd]
   * @param {number} [opts.commandTimeoutMs]
   * @param {number} [opts.startupTimeoutMs]
   */
  constructor(opts) {
    super();
    this.opts = {
      cwd: undefined,
      humanModelPath: null,
      extraArgs: [],
      commandTimeoutMs: 120_000,
      startupTimeoutMs: 180_000,
      ...opts,
    };
    this.proc = null;
    this.queue = [];
    this.busy = false;
    this.counter = 1;
    this.pending = new Map();
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.current = null;
    this.ready = false;
    this.stoppedByUs = false;
    this.handshake = null;
    this.lastStderr = [];
  }

  get running() {
    return Boolean(this.proc) && this.proc.exitCode === null;
  }

  /** 启动进程并完成 GTP 握手 */
  async start() {
    if (this.running) return this.handshake;
    this.stoppedByUs = false;

    const args = ['gtp', '-config', this.opts.configPath, '-model', this.opts.modelPath];
    if (this.opts.humanModelPath) args.push('-human-model', this.opts.humanModelPath);
    if (this.opts.extraArgs?.length) args.push(...this.opts.extraArgs);

    this.proc = spawn(this.opts.exe, args, {
      cwd: this.opts.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const text = this.decoder.write(chunk);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.lastStderr.push(line);
        if (this.lastStderr.length > 200) this.lastStderr.shift();
        this.emit('stderr', line);
      }
    });
    this.proc.on('exit', (code, signal) => {
      const wasRunning = this.ready;
      this.ready = false;
      this._rejectAll(new Error(`KataGo 进程退出 code=${code} signal=${signal}`));
      this.proc = null;
      this.emit('exit', { code, signal, unexpected: wasRunning && !this.stoppedByUs });
    });
    this.proc.on('error', (err) => {
      this.ready = false;
      this._rejectAll(err);
      this.emit('engine-error', err);
    });

    const name = await this.command('name', this.opts.startupTimeoutMs);
    const version = await this.command('version', this.opts.startupTimeoutMs).catch(() => 'unknown');
    const protocol = await this.command('protocol_version').catch(() => '?');
    this.ready = true;
    this.handshake = { name, version, protocol };
    this.emit('ready', this.handshake);
    return this.handshake;
  }

  /** 发送一条 GTP 命令，返回响应正文 */
  command(cmd, timeoutMs = this.opts.commandTimeoutMs) {
    if (!this.proc) return Promise.reject(new Error('引擎未启动'));
    return new Promise((resolve, reject) => {
      const id = this.counter++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`GTP 命令超时 (${timeoutMs}ms): ${cmd}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, cmd });
      this.queue.push({ id, cmd });
      this._pump();
    });
  }

  /** 顺序执行多条命令 */
  async commands(cmds, timeoutMs) {
    const out = [];
    for (const c of cmds) out.push(await this.command(c, timeoutMs));
    return out;
  }

  /**
   * 流式分析。返回 {stop, start}
   * 分析行通过 'analyze' 事件发出。
   */
  analyze({ intervalMs = 100, ownership = true } = {}) {
    if (!this.proc) return { stop() {} };
    const flags = ownership ? ' ownership true' : '';
    this.proc.stdin.write(`kata-analyze interval ${intervalMs}${flags}\n`);
    return {
      stop: () => {
        if (this.proc) this.proc.stdin.write('\n');
      },
    };
  }

  /**
   * 评估当前位置（不落子、不改变棋盘）
   *
   * 实测：kata-analyze 的输出是**命令响应正文**（多行，每行一次完整更新），
   * 没有 rootInfo 行；根节点的胜率取该行 order 0 的候选点。
   * 因此这里持续监听正文行，累计访问数达标后写空行结束分析。
   */
  // 注意：KataGo 的 `kata-analyze interval N` 里 N 的单位是**厘秒**（1/100 秒），
  // 不是毫秒。旧参数名 intervalMs 有误导性，这里改为 intervalCs；
  // 并且强制它不超过评估预算的 1/5，否则可能出现「一次更新都等不到就被停掉」→ 胜率全空。
  async analyzePosition({ minVisits = 200, maxMs = 600, timeoutMs = 30000, intervalCs = 20 } = {}) {
    if (!this.proc) throw new Error('引擎未启动');
    const cs = Math.max(1, Math.min(Math.round(intervalCs), Math.max(1, Math.floor(maxMs / 5))));

    let bestInfos = null;
    let latestVisits = 0;
    let stopRequested = false;

    const stopAnalyze = () => {
      if (stopRequested) return;
      stopRequested = true;
      try {
        this.proc?.stdin.write('\n');
      } catch {
        /* ignore */
      }
    };

    const onLine = (line) => {
      if (!line.startsWith('info ')) return;
      const infos = parseAnalyzeInfo(line);
      if (!infos || !infos.length) return;
      bestInfos = infos;
      const visits = Math.max(...infos.map((i) => i.visits ?? 0));
      latestVisits = Math.max(latestVisits, visits);
      if (latestVisits >= minVisits) stopAnalyze();
    };

    this.on('response-line', onLine);
    const softTimer = setTimeout(stopAnalyze, maxMs);
    const timer = setTimeout(stopAnalyze, timeoutMs);

    try {
      const body = await this.command(`kata-analyze interval ${cs}`, timeoutMs + 20000);
      // 正文最后一条更新是最新数据，作为兜底
      const lines = String(body).split('\n').filter((l) => l.trim().startsWith('info '));
      const last = lines[lines.length - 1];
      if (last) {
        const infos = parseAnalyzeInfo(last);
        if (infos && infos.length) {
          bestInfos = infos;
          latestVisits = Math.max(latestVisits, ...infos.map((i) => i.visits ?? 0));
        }
      }
    } catch {
      // 超时也返回已有数据
    } finally {
      clearTimeout(timer);
      clearTimeout(softTimer);
      this.off('response-line', onLine);
    }

    if (!bestInfos) return { rootInfo: null, moves: [], visits: 0 };
    const top = bestInfos[0];
    return {
      rootInfo: { winrate: top.winrate, scoreLead: top.scoreLead, visits: top.visits ?? latestVisits },
      moves: bestInfos,
      visits: top.visits ?? latestVisits,
    };
  }

  async stop() {
    this.stoppedByUs = true;
    if (!this.proc) return;
    try {
      this.proc.stdin.write('quit\n');
    } catch {
      /* ignore */
    }
    const proc = this.proc;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 4000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.proc = null;
    this.ready = false;
  }

  // ---------------------------------------------------------------- 内部

  _pump() {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) return;
    this.busy = true;
    const entry = this.pending.get(next.id);
    // 注意：不要在这里预先创建响应槽，响应槽由实际的 `= / ?` 行创建，
    // 否则首行会被当成“空响应”提前结掉。
    this.inFlightId = next.id;
    try {
      this.proc.stdin.write(`${next.cmd}\n`);
    } catch (err) {
      this.busy = false;
      this.current = null;
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(next.id);
        entry.reject(err);
      }
      this._pump();
    }
  }

  _onStdout(chunk) {
    this.buffer += this.decoder.write(chunk);
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const rawLine = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      this._onLine(rawLine);
    }
  }

  _onLine(line) {
    // 空行 = 当前响应结束
    if (line.trim() === '') {
      if (this.current) {
        const { id, lines } = this.current;
        this.current = null;
        this.busy = false;
        this._finish(id, lines);
        this._pump();
      } else {
        this.busy = false;
      }
      return;
    }

    const m = RESPONSE_START.exec(line);
    if (m) {
      // 新的响应开始（同一行可能既是结束又是开始）
      if (this.current) {
        const { id, lines } = this.current;
        this.current = null;
        this._finish(id, lines);
      }
      const idNum = m[2] ? Number(m[2]) : (this.inFlightId ?? this._pendingIdGuess());
      this.current = { id: idNum, lines: [line] };
      return;
    }

    if (this.current) {
      this.current.lines.push(line);
      this.emit('response-line', line);
      return;
    }

    // 无人认领的输出：分析流或引擎自发消息
    if (/^(info|rootInfo|ownership|warning)\b/.test(line)) this.emit('analyze', line);
    else this.emit('noise', line);
  }

  _finish(id, lines) {
    this.inFlightId = null;
    const entry = this.pending.get(id);
    if (!entry) {
      // 无人认领的响应（如 kata-analyze 停止后返回的 "="），通知等待者
      this.emit('unsolicited-response', lines);
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(id);
    const first = lines[0] ?? '';
    const isError = first.startsWith('?');
    const body = lines
      .map((l, i) => (i === 0 ? l.replace(RESPONSE_START, '$3') : l))
      .join('\n')
      .trim();
    if (isError) entry.reject(new Error(`GTP 错误: ${body || 'unknown'} (cmd: ${entry.cmd})`));
    else entry.resolve(body);
  }

  _pendingIdGuess() {
    const ids = [...this.pending.keys()];
    return ids.length ? Math.min(...ids) : 0;
  }

  _rejectAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    this.queue.length = 0;
    this.busy = false;
    this.current = null;
  }
}

/**
 * 解析 kata-analyze / kata-genmove_analyze 的输出。
 *
 * 实测格式（KataGo 1.18）：一条响应正文里可能只有 1 行，但该行内含多个
 * "info move ..." 段；pv 与 ownership 都是空格分隔的列表，不是逗号。
 *
 *   info move F7 visits 53 winrate 0.4787 scoreLead 0.21 prior 0.30 pv F7 G6 D6
 *   info move E7 visits 22 ... pv E7 F3 F4
 *   play F7
 */
const MOVE_RE = /^move\s+(\S+)/;

function parseInfoSegments(line) {
  // 以 " info move" 为边界切分
  const segs = line.split(/\s*info\s+(?=move\s)/);
  const out = [];
  for (const segRaw of segs) {
    const seg = segRaw.replace(/^\s*info\s+/, "").trim();
    const m = MOVE_RE.exec(seg);
    if (!m) continue;
    out.push(parseSegment(seg, m));
  }
  return out;
}

function parseSegment(seg, moveMatch) {
  const out = { move: moveMatch[1] };
  let rest = seg.slice(moveMatch[0].length);

  // 拆出 pv / ownership 尾部
  let pvPart = "";
  let ownPart = "";
  const pvIdx = rest.search(/\bpv\s/);
  if (pvIdx >= 0) {
    const afterPv = rest.slice(pvIdx + 3);
    rest = rest.slice(0, pvIdx);
    const ownIdx = afterPv.search(/\bownership\s/);
    if (ownIdx >= 0) {
      pvPart = afterPv.slice(0, ownIdx);
      ownPart = afterPv.slice(ownIdx + "ownership ".length);
    } else {
      pvPart = afterPv;
    }
  } else {
    const ownIdx = rest.search(/\bownership\s/);
    if (ownIdx >= 0) {
      ownPart = rest.slice(ownIdx + "ownership ".length);
      rest = rest.slice(0, ownIdx);
    }
  }

  // 数值字段：key value
  const kv = /([A-Za-z][A-Za-z0-9_]*)\s+(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = kv.exec(rest)) !== null) out[m[1]] = Number(m[2]);

  if (pvPart) out.pv = pvPart.split(/[\s,]+/).filter(Boolean);
  if (ownPart) {
    out.ownership = ownPart
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
  }
  return out;
}

/** 解析任意一行分析输出，返回候选数组 */
export function parseAnalyzeInfo(line) {
  if (!line.includes("info move") && !line.startsWith("info ")) return null;
  const infos = parseInfoSegments(line);
  return infos.length ? infos : null;
}

/** 解析 rootInfo 行（当前局面整体胜率/目差） */
export function parseRootInfo(line) {
  if (!line.startsWith("rootInfo ")) return null;
  const out = {};
  const re = /([A-Za-z][A-Za-z0-9_]*)\s+(-?[\d.]+(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(line)) !== null) out[m[1]] = Number(m[2]);
  return out;
}

/**
 * 解析 kata-genmove_analyze 的完整响应正文。
 * @returns {{move: string|null, infos: object[], ownership: number[]|null}}
 */
export function parseGenmoveAnalyze(body) {
  const lines = String(body)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const infos = [];
  let move = null;
  let ownership = null;

  for (const line of lines) {
    if (line.startsWith("info ")) {
      const parsed = parseAnalyzeInfo(line) ?? [];
      for (const info of parsed) {
        if (info.ownership) ownership = info.ownership;
        delete info.ownership;
        infos.push(info);
      }
    } else if (line.startsWith("play ")) {
      move = line.slice(5).trim();
    } else if (/^(pass|resign)$/i.test(line) || /^[A-Za-z]\d{1,2}$/.test(line)) {
      move = line;
    }
  }

  infos.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return { move, infos, ownership };
}
