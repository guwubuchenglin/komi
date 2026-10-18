/**
 * 系统占用采样
 * - CPU：os.cpus() 时间差（全系统）
 * - GPU：优先 nvidia-smi（NVIDIA，精确）；没有则用 Windows WDDM 的 GPU Engine 计数器
 *   （typeperf 流式读取，覆盖 AMD / Intel / NVIDIA 任意显卡）
 * - 显存：NVIDIA 走 nvidia-smi；其它显卡只能报利用率
 */
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

function cpuSnapshot() {
  const cpus = os.cpus() ?? [];
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function queryNvidiaSmi() {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 1500, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const line = stdout.trim().split(/\r?\n/)[0];
        const [util, memUsed, memTotal] = line.split(',').map((s) => Number(String(s).trim()));
        if (!Number.isFinite(util)) return resolve(null);
        resolve({
          util,
          memUsed: Number.isFinite(memUsed) ? memUsed : null,
          memTotal: Number.isFinite(memTotal) ? memTotal : null,
          source: 'nvidia-smi',
        });
      },
    );
  });
}

/**
 * Windows WDDM GPU 计数器采样（任意厂商）
 * 通过一个常驻的 typeperf 进程读 "\GPU Engine(*)\Utilization Percentage"，
 * 汇总 3D / Compute 引擎实例的占用。
 */
class WddmGpuSampler extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.buffer = '';
    this.indices = null;
    this.latest = null;
    this.failed = false;
    this.enabled = false;
  }

  start() {
    if (this.proc || this.failed) return;
    try {
      this.proc = spawn(
        'typeperf',
        ['\\GPU Engine(*)\\Utilization Percentage', '-si', '2'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      this.failed = true;
      return;
    }

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.on('error', () => {
      this.failed = true;
    });
    this.proc.on('exit', () => {
      this.proc = null;
      // 若从没成功过就放弃，否则允许下次 tick 重启
      if (!this.latest) this.failed = true;
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      if (!this.indices) {
        this.parseHeader(line);
        continue;
      }
      this.parseSample(line);
    }
  }

  parseHeader(line) {
    const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
    const idx = [];
    cols.forEach((name, i) => {
      if (i === 0) return; // 时间戳列
      if (/engtype_(3D|Compute_0|Compute_1|Cuda)\b/i.test(name)) idx.push(i);
    });
    if (!idx.length) {
      // 没有可用实例，降级失败
      this.failed = true;
      this.stop();
      return;
    }
    this.indices = idx;
    this.enabled = true;
  }

  parseSample(line) {
    const parts = line.split('","');
    if (parts.length <= 1) return;
    let sum = 0;
    for (const i of this.indices) {
      const v = Number(String(parts[i] ?? '').replace(/"/g, '').trim());
      if (Number.isFinite(v)) sum += v;
    }
    this.latest = {
      util: Math.min(100, Math.round(sum)),
      memUsed: null,
      memTotal: null,
      source: 'wddm',
    };
    this.emit('sample', this.latest);
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }
}

export class SystemMetrics extends EventEmitter {
  constructor({ intervalMs = 1500 } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.timer = null;
    this.prev = cpuSnapshot();
    this.useNvidia = true;
    this.wddm = null;
    this.last = { cpu: 0, gpu: null, mem: null, at: 0 };
    this.forceWddm = process.env.GO_FORCE_WDDM_GPU === '1';
  }

  get running() {
    return Boolean(this.timer);
  }

  ensureWddm() {
    if (this.wddm) return this.wddm;
    this.wddm = new WddmGpuSampler();
    this.wddm.start();
    return this.wddm;
  }

  async sampleGpu() {
    if (this.useNvidia && !this.forceWddm) {
      const gpu = await queryNvidiaSmi();
      if (gpu) return gpu;
      this.useNvidia = false;
    }
    const sampler = this.ensureWddm();
    return sampler.latest ?? null;
  }

  start() {
    if (this.timer) return;
    this.prev = cpuSnapshot();
    const tick = async () => {
      if (!this.timer) return;
      const cur = cpuSnapshot();
      const dIdle = cur.idle - this.prev.idle;
      const dTotal = cur.total - this.prev.total;
      this.prev = cur;
      const cpu = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;

      const gpu = await this.sampleGpu();

      const total = os.totalmem();
      const free = os.freemem();
      const mem = {
        usedGB: Number(((total - free) / 1073741824).toFixed(1)),
        totalGB: Number((total / 1073741824).toFixed(1)),
        percent: total > 0 ? Math.round(((total - free) / total) * 100) : 0,
      };

      this.last = { cpu, gpu, mem, at: Date.now() };
      this.emit('sample', this.last);
    };
    this.timer = setInterval(tick, this.intervalMs);
    tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.wddm?.stop();
  }
}
