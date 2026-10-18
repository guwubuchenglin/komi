/**
 * 运行环境检测：显卡厂商、可用后端、可选加速包是否适用
 * 用 CIM/WMI 读显卡名称，配合 nvidia-smi、CUDA Toolkit、OpenCL 运行时等线索判断。
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

async function listGpus() {
  // 1) CIM（最稳，但某些受限环境会拒绝）
  const cim = await run('powershell', [
    '-NoProfile',
    '-Command',
    'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
  ]);
  if (cim && cim.trim()) {
    return cim
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // 2) wmic（老系统兜底）
  const wmic = await run('wmic', ['path', 'win32_VideoController', 'get', 'name']);
  if (wmic) {
    return wmic
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !/^Name$/i.test(s));
  }
  return [];
}

function classify(name) {
  const n = name.toLowerCase();
  if (/nvidia|geforce|quadro|rtx|gtx|tesla|a100|h100/.test(n)) return 'nvidia';
  if (/radeon|amd|rx\s?\d|vega|navi|instinct/.test(n)) return 'amd';
  if (/intel|arc\b|iris|uhd|hd graphics|xe graphics/.test(n)) return 'intel';
  if (/basic render|microsoft/.test(n)) return 'software';
  return 'unknown';
}

/** 从 AMD 显卡型号大致推断 ROCm 支持的关键字（gfx10xx / gfx11xx / gfx12xx） */
function amdArchHint(name) {
  const n = name.toLowerCase();
  // RX 6000 系 → gfx103x；RX 7000 系 → gfx110x；RX 9000 系 → gfx120x
  if (/rx\s?9\d{3}|9070|9060|9070xt/.test(n)) return 'gfx120X';
  if (/rx\s?7\d{3}|7800|7900|7700|7600|7500/.test(n)) return 'gfx110X';
  if (/rx\s?6\d{3}|6800|6900|6700|6600|6500|6400/.test(n)) return 'gfx103X';
  if (/instinct mi3|mi3\d\d|mi2\d\d/.test(n)) return 'gfx90a';
  return null;
}

/**
 * @returns {Promise<{
 *   gpus: {name:string, vendor:string, archHint:string|null}[],
 *   vendors: string[],
 *   hasNvidia: boolean, hasAmd: boolean, hasIntel: boolean,
 *   nvidiaSmi: boolean, cudaToolkit: boolean, openclRuntime: boolean,
 *   ramGB: number, cpuCount: number
 * }>}
 */
export async function detectHardware() {
  const names = await listGpus();
  const gpus = names.map((name) => ({
    name,
    vendor: classify(name),
    archHint: classify(name) === 'amd' ? amdArchHint(name) : null,
  }));
  const vendors = [...new Set(gpus.map((g) => g.vendor))];

  const nvidiaSmi = Boolean(await run('nvidia-smi', ['-L']));
  const cudaToolkit = Boolean(process.env.CUDA_PATH) || existsSync('C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA');
  const openclRuntime =
    existsSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenCL.dll')) ||
    existsSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'SysWOW64', 'OpenCL.dll'));

  return {
    gpus,
    vendors,
    hasNvidia: vendors.includes('nvidia') || nvidiaSmi,
    hasAmd: vendors.includes('amd'),
    hasIntel: vendors.includes('intel'),
    nvidiaSmi,
    cudaToolkit,
    openclRuntime,
    ramGB: Math.round(os.totalmem() / 1073741824),
    cpuCount: os.cpus()?.length ?? 0,
  };
}

/**
 * 给每个组件算"是否适用 / 是否推荐"，供安装向导展示
 * @param {object} hw detectHardware 的结果
 * @param {object} comp 组件定义
 */
export function evaluateComponent(hw, comp) {
  if (comp.requires === 'nvidia' && !hw.hasNvidia) {
    return { applicable: false, reason: '未检测到 NVIDIA 显卡' };
  }
  if (comp.requires === 'amd' && !hw.hasAmd) {
    return { applicable: false, reason: '未检测到 AMD 显卡' };
  }
  if (comp.requires === 'intel' && !hw.hasIntel) {
    return { applicable: false, reason: '未检测到 Intel 显卡' };
  }
  if (comp.requires === 'nvidia-cuda' && !(hw.hasNvidia && hw.cudaToolkit)) {
    return {
      applicable: false,
      reason: hw.hasNvidia ? '缺少 CUDA 12 运行库' : '未检测到 NVIDIA 显卡',
    };
  }
  if (comp.requires === 'opencl' && !hw.openclRuntime) {
    return { applicable: false, reason: '系统缺少 OpenCL 运行库' };
  }
  if (comp.archHint && !hw.gpus.some((g) => g.archHint === comp.archHint)) {
    return { applicable: false, reason: `未检测到 ${comp.archHint} 架构显卡` };
  }
  return {
    applicable: true,
    recommended: Boolean(comp.recommendedWhen?.(hw)),
  };
}

export function summarize(hw) {
  const gpuText = hw.gpus.length ? hw.gpus.map((g) => g.name).join(' / ') : '未检测到独立显卡';
  const parts = [`显卡：${gpuText}`];
  if (hw.nvidiaSmi) parts.push('nvidia-smi 可用');
  if (hw.cudaToolkit) parts.push('CUDA 12 运行库已安装');
  parts.push(hw.openclRuntime ? 'OpenCL 可用' : '无 OpenCL');
  parts.push(`${hw.cpuCount} 核 / ${hw.ramGB} GB 内存`);
  return parts.join('；');
}
