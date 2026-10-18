/**
 * 组件按需下载安装（可选 + 环境校验）
 *
 * 安装包只装"壳"：程序本体 ~96 MB。真正占地方的东西按需下载：
 *   必需：两套神经网络、DirectML 后端（AMD / Intel / NVIDIA 通用）
 *   可选：OpenCL（老显卡）、OpenVINO（Intel）、ROCm（AMD 原生）、CUDA + cuDNN（NVIDIA 满速）
 *
 * 每个组件带 `requires` 条件，安装向导会结合环境检测结果决定"是否适用/是否推荐"。
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, readdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { candidateUrls, resolvePypiViaMirror } from './mirrors.js';

const KATAGO_V = 'v1.18.1';
const GH = `https://github.com/lightvector/KataGo/releases/download/${KATAGO_V}`;
const NETS = 'https://media.katagotraining.org/uploaded/networks';
const MB = 1048576;

const pypiCache = new Map();

/**
 * 解析指定包的最新 win_amd64 wheel 地址
 * @param {string} pkg
 * @param {'direct'|'china'} mirror
 */
async function resolvePypi(pkg, mirror = 'direct') {
  const key = pkg + '|' + mirror;
  if (pypiCache.has(key)) return pypiCache.get(key);

  // 国内镜像：走清华 simple 索引（pypi.org 的 JSON 接口在墙内常不可达）
  if (mirror === 'china') {
    try {
      const hit = await resolvePypiViaMirror(pkg);
      if (hit?.url) {
        pypiCache.set(key, hit);
        return hit;
      }
    } catch {
      /* 落回官方 */
    }
  }

  const res = await fetch(`https://pypi.org/pypi/${pkg}/json`, {
    headers: { 'User-Agent': 'go-game-installer/1.0' },
  });
  if (!res.ok) throw new Error(`无法解析 ${pkg}: HTTP ${res.status}`);
  const json = await res.json();
  const wins = (json.urls ?? []).filter((u) => u.filename.includes('win_amd64'));
  if (!wins.length) throw new Error(`${pkg} 没有 Windows wheel`);
  const pick = wins.sort((a, b) => a.filename.localeCompare(b.filename)).pop();
  const info = { url: pick.url, bytes: pick.size };
  pypiCache.set(key, info);
  return info;
}

/**
 * @typedef {object} Source
 * @property {string} [url]        直接地址
 * @property {string} [pypi]       从 PyPI 解析（与 url 二选一）
 * @property {'file'|'zip'|'zip-dlls'} kind
 * @property {string} dest         相对 engine 根目录
 * @property {number} bytes        预估体积（UI 用）
 * @property {(resolvedUrl:string)=>void} [onResolve]
 */

/**
 * @typedef {object} Component
 * @property {string} id
 * @property {string} label
 * @property {string} detail
 * @property {boolean} required
 * @property {string|null} requires  'nvidia'|'amd'|'intel'|'opencl'|null
 * @property {string} [archHint]
 * @property {string} probe
 * @property {Source[]} sources
 * @property {(hw:object)=>boolean} [recommendedWhen]
 * @property {number} bytes
 */

/** @type {Component[]} */
export const COMPONENTS = [
  {
    id: 'weights-main',
    label: '主力神经网络 b18c384nbt',
    detail: '对弈强度基础',
    required: true,
    requires: null,
    probe: 'weights/b18c384nbt.bin.gz',
    sources: [
      {
        url: `${NETS}/models/kata1/kata1-b18c384nbt-s9996604416-d4316597426.bin.gz`,
        kind: 'file',
        dest: 'weights/b18c384nbt.bin.gz',
        bytes: 93.4,
      },
    ],
    bytes: 93.4 * MB,
  },
  {
    id: 'weights-human',
    label: '拟人神经网络 humanv0',
    detail: '「拟人」难度档位使用',
    required: true,
    requires: null,
    probe: 'weights/b18c384nbt-humanv0.bin.gz',
    sources: [
      {
        url: `${NETS}/models_extra/b18c384nbt-humanv0.bin.gz`,
        kind: 'file',
        dest: 'weights/b18c384nbt-humanv0.bin.gz',
        bytes: 94.5,
      },
    ],
    bytes: 94.5 * MB,
  },
  {
    id: 'directml',
    label: 'DirectML 计算后端',
    detail: 'AMD / Intel / NVIDIA 通用 GPU 加速（DX12）',
    required: true,
    requires: null,
    probe: 'directml/katago.exe',
    sources: [
      {
        url: `${GH}/katago-v1.18.1-onnx1.24.4-directml-windows-x64.zip`,
        kind: 'zip',
        dest: 'directml',
        bytes: 22.5,
      },
    ],
    bytes: 22.5 * MB,
  },
  {
    id: 'opencl',
    label: 'OpenCL 计算后端',
    detail: '兼容不支持 DX12 的老显卡 / 核显',
    required: false,
    requires: 'opencl',
    probe: 'opencl/katago.exe',
    recommendedWhen: (hw) => hw.hasAmd || hw.hasIntel,
    sources: [
      { url: `${GH}/katago-v1.18.1-opencl-windows-x64.zip`, kind: 'zip', dest: 'opencl', bytes: 5.7 },
    ],
    bytes: 5.7 * MB,
  },
  {
    id: 'openvino',
    label: 'OpenVINO 后端',
    detail: 'Intel 显卡 / NPU 专用，通常比 DirectML 快',
    required: false,
    requires: 'intel',
    probe: 'openvino/katago.exe',
    recommendedWhen: (hw) => hw.hasIntel,
    sources: [
      {
        url: `${GH}/katago-v1.18.1-onnx-openvino2026.2.1-windows-x64.zip`,
        kind: 'zip',
        dest: 'openvino',
        bytes: 82.7,
      },
    ],
    bytes: 82.7 * MB,
  },
  {
    id: 'rocm-gfx110X',
    label: 'ROCm 后端（RX 7000 系）',
    detail: 'AMD 原生后端，gfx110X 架构（RX 7xxx / 9xxx）',
    required: false,
    requires: 'amd',
    archHint: 'gfx110X',
    probe: 'rocm/katago.exe',
    sources: [
      {
        url: `${GH}/katago-v1.18.1-rocm7.13-gfx110X-windows-x64.zip`,
        kind: 'zip',
        dest: 'rocm',
        bytes: 211.2,
      },
    ],
    bytes: 211.2 * MB,
  },
  {
    id: 'rocm-gfx103X',
    label: 'ROCm 后端（RX 6000 系）',
    detail: 'AMD 原生后端，gfx103X 架构（RX 6xxx）',
    required: false,
    requires: 'amd',
    archHint: 'gfx103X',
    probe: 'rocm/katago.exe',
    sources: [
      {
        url: `${GH}/katago-v1.18.1-rocm7.13-gfx103X-windows-x64.zip`,
        kind: 'zip',
        dest: 'rocm',
        bytes: 207.3,
      },
    ],
    bytes: 207.3 * MB,
  },
  {
    id: 'cuda',
    label: 'CUDA 加速包（NVIDIA 满速）',
    detail: 'KataGo CUDA 版 + cuDNN + CUDA 运行库，约 1.1 GB，速度约为 DirectML 的 2 倍',
    required: false,
    requires: 'nvidia',
    probe: 'katago.exe',
    recommendedWhen: (hw) => hw.hasNvidia && hw.nvidiaSmi,
    sources: [
      {
        url: 'https://github.com/lightvector/KataGo/releases/download/v1.18.2/katago-v1.18.2-cuda12.8-cudnn9.8.0-windows-x64.zip',
        kind: 'zip',
        dest: '.',
        bytes: 9.7,
      },
      { pypi: 'nvidia-cudnn-cu12', kind: 'zip-dlls', dest: '.', bytes: 709 },
      { pypi: 'nvidia-cublas-cu12', kind: 'zip-dlls', dest: '.', bytes: 470 },
      { pypi: 'nvidia-cuda-runtime-cu12', kind: 'zip-dlls', dest: '.', bytes: 1 },
    ],
    bytes: (9.7 + 709 + 470 + 1) * MB,
  },
];

export function componentById(id) {
  return COMPONENTS.find((c) => c.id === id) ?? null;
}

export function totalBytes(list) {
  return list.reduce((s, c) => s + (c.bytes || 0), 0);
}

export async function isInstalled(component, engineRoot) {
  try {
    const st = await stat(path.join(engineRoot, component.probe));
    return st.size > 1024;
  } catch {
    return false;
  }
}

export async function missingComponents(engineRoot) {
  const out = [];
  for (const c of COMPONENTS) {
    if (!(await isInstalled(c, engineRoot))) out.push(c);
  }
  return out;
}

function execTar(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('tar', args, { cwd, windowsHide: true, timeout: 300000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`解包失败：${String(stderr || err.message).slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

/** 递归找目录下所有 dll */
async function findDlls(dir) {
  const out = [];
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.dll$/i.test(entry.name)) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

/**
 * 安装单个组件（可多来源）
 * @param {Component} comp
 * @param {string} engineRoot
 * @param {(p:{id:string,phase:string,received:number,total:number,index:number,count:number,sourceIndex:number,sourceCount:number})=>void} [onProgress]
 */
export async function installComponent(comp, engineRoot, onProgress, options = {}) {
  const sources = comp.sources;
  const total = totalBytes([comp]);
  if (await isInstalled(comp, engineRoot)) {
    onProgress?.({ id: comp.id, phase: 'done', received: total, total, sourceIndex: sources.length, sourceCount: sources.length });
    return { installed: false, skipped: true };
  }

  const tmpDir = path.join(engineRoot, '.download');
  await mkdir(tmpDir, { recursive: true });
  let doneBytes = 0;

  for (let si = 0; si < sources.length; si++) {
    const src = sources[si];
    let url = src.url;
    if (src.pypi) {
      const info = await resolvePypi(src.pypi, options.mirror === 'china' ? 'china' : 'direct');
      url = info.url;
    }
    if (!url) throw new Error(`${comp.label} 缺少下载地址`);

    // 生成候选地址（国内镜像时先走代理/镜像，最后回退直连）
    const urls = candidateUrls(url, options.mirror === 'china' ? 'china' : 'direct');

    const archivePath = path.join(tmpDir, `${comp.id}-${si}.part`);
    await rm(archivePath, { force: true });

    let res = null;
    let usedUrl = null;
    const failures = [];
    for (const cand of urls) {
      try {
        const r = await fetch(cand, { redirect: 'follow', headers: { 'User-Agent': 'go-game-installer/1.0' } });
        if (!r.ok) {
          failures.push(`${cand} → HTTP ${r.status}`);
          continue;
        }
        res = r;
        usedUrl = cand;
        break;
      } catch (err) {
        failures.push(`${cand} → ${err.message}`);
      }
    }
    if (!res) throw new Error(`下载失败（已尝试 ${urls.length} 个源）：\n  ` + failures.join('\n  '));
    if (usedUrl !== url) onProgress?.({ id: comp.id, phase: 'mirror', received: doneBytes, total, sourceIndex: si + 1, sourceCount: sources.length, label: comp.label });

    const expected = Number(res.headers.get('content-length') || 0);
    let received = 0;

    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      received += chunk.length;
      onProgress?.({
        id: comp.id,
        phase: 'download',
        received: doneBytes + received,
        total,
        sourceIndex: si + 1,
        sourceCount: sources.length,
      });
    });
    await pipeline(body, createWriteStream(archivePath));

    const st = await stat(archivePath);
    if (expected && Math.abs(st.size - expected) > 4096) {
      await rm(archivePath, { force: true });
      throw new Error(`下载不完整：${st.size}/${expected} 字节`);
    }

    const destPath = path.join(engineRoot, src.dest);
    onProgress?.({ id: comp.id, phase: 'extract', received: doneBytes + st.size, total, sourceIndex: si + 1, sourceCount: sources.length });

    if (src.kind === 'file') {
      await mkdir(path.dirname(destPath), { recursive: true });
      await rm(destPath, { force: true });
      await rename(archivePath, destPath);
    } else {
      const extractDir = path.join(tmpDir, `${comp.id}-${si}-x`);
      await rm(extractDir, { recursive: true, force: true });
      await mkdir(extractDir, { recursive: true });
      await execTar(['-xf', archivePath, '-C', extractDir], tmpDir);

      if (src.kind === 'zip-dlls') {
        // 只取 DLL，铺平到目标目录（cuDNN / cuBLAS wheel 结构很深）
        await mkdir(destPath, { recursive: true });
        const dlls = await findDlls(extractDir);
        for (const dll of dlls) await copyFile(dll, path.join(destPath, path.basename(dll)));
      } else {
        // 普通 zip：去掉可能的单层顶层目录后落地
        const entries = await readdir(extractDir);
        const single = entries.length === 1 ? path.join(extractDir, entries[0]) : null;
        const isDir = single ? (await stat(single)).isDirectory() : false;
        const from = isDir ? single : extractDir;
        const isEngineRoot = path.resolve(destPath) === path.resolve(engineRoot);

        if (isEngineRoot) {
          // 落地到 engine 根目录（如 CUDA 包）：逐个文件覆盖，绝不能删根目录
          for (const f of await readdir(from)) {
            const target = path.join(destPath, f);
            await rm(target, { recursive: true, force: true });
            await rename(path.join(from, f), target);
          }
        } else {
          await rm(destPath, { recursive: true, force: true });
          await mkdir(path.dirname(destPath), { recursive: true });
          await rename(from, destPath);
        }
      }
      await rm(extractDir, { recursive: true, force: true });
      await rm(archivePath, { force: true });
    }

    doneBytes += st.size;
  }

  if (!(await isInstalled(comp, engineRoot))) throw new Error(`${comp.label} 安装后校验失败`);
  onProgress?.({ id: comp.id, phase: 'done', received: total, total, sourceIndex: sources.length, sourceCount: sources.length });
  return { installed: true, skipped: false };
}

/** 只安装指定 id 列表（安装向导用） */
export async function installSelected(ids, engineRoot, onProgress, options = {}) {
  const list = ids.map((id) => componentById(id)).filter(Boolean);
  const done = [];
  for (const comp of list) {
    await installComponent(comp, engineRoot, onProgress, options);
    done.push(comp.id);
  }
  return done;
}

export async function cleanDownloadCache(engineRoot) {
  await rm(path.join(engineRoot, '.download'), { recursive: true, force: true });
}

export { existsSync };
