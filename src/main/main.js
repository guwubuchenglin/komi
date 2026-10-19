import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EngineManager } from './engineManager.js';
import { SpectateRunner } from './spectate.js';
import { parseSgf } from '../shared/sgf.js';
import { execFile, spawn } from 'node:child_process';
import { SystemMetrics } from './metrics.js';
import { COMPONENTS, missingComponents, installSelected, totalBytes, componentById, cleanDownloadCache, isInstalled } from './components.js';
import { detectHardware, evaluateComponent, summarize } from './hardware.js';
import { probeSources } from './mirrors.js';
import {
  LEVELS,
  levelById,
  describeLevel,
  tuningFor,
  benchmarkTuning,
  normalizePerfMode,
  normalizeBackendMode,
  normalizeLang,
  PERF,
  BACKEND_MODE,
  LANGS,
} from './difficulty.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..');

const ARGV = process.argv;
const IS_SHOT = ARGV.includes('--shot');
const IS_SELFTEST = ARGV.includes('--selftest');
const IS_PLAY = ARGV.includes('--play');

let win = null;
let manager = null;
let spectate = null;
let spectateBusy = false;
let uiTestMode = false;
let metrics = null;
// 用户偏好（config/settings.json）；默认开高吞吐，弱机可在界面里切回省电
let settings = { perfMode: PERF.PERFORMANCE, backendMode: BACKEND_MODE.AUTO, lang: 'zh' };
// 跑分互斥，避免两个 benchmark 同时抢 GPU
let benchRunning = false;

// 可写数据目录（安装版里程序目录是只读的）
const DATA_DIR = app.getPath('userData');
const INSTALL_DIR = app.isPackaged ? path.dirname(app.getPath('exe')) : APP_ROOT;
const BUNDLED_ENGINE = path.join(APP_ROOT, 'engine');
const USER_ENGINE = path.join(DATA_DIR, 'engine');
const INSTALL_ENGINE = path.join(INSTALL_DIR, 'engine');
const PATHS_CONFIG = path.join(DATA_DIR, 'config', 'paths.json');

function isWritableDir(dir) {
  try {
    if (!existsSync(dir)) return false;
    const probe = path.join(dir, '.write-probe');
    writeFileSync(probe, 'x');
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function hasEnginePayload(dir) {
  const probe = path.join(dir, 'weights', 'b18c384nbt.bin.gz');
  const hasBackend =
    existsSync(path.join(dir, 'katago.exe')) ||
    existsSync(path.join(dir, 'directml', 'katago.exe')) ||
    existsSync(path.join(dir, 'opencl', 'katago.exe')) ||
    existsSync(path.join(dir, 'cpu', 'katago.exe'));
  return existsSync(probe) && hasBackend;
}

/** 已保存的自定义组件目录 */
function readEngineDirSetting() {
  try {
    const cfg = JSON.parse(readFileSync(PATHS_CONFIG, 'utf8'));
    return cfg.engineDir || null;
  } catch {
    return null;
  }
}

function writeEngineDirSetting(dir) {
  try {
    mkdirSync(path.dirname(PATHS_CONFIG), { recursive: true });
    writeFileSync(PATHS_CONFIG, JSON.stringify({ engineDir: dir }, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

/**
 * 组件目录解析顺序：
 *   1. GO_ENGINE_DIR 环境变量
 *   2. 用户手动指定的目录（config/paths.json）
 *   3. 随包内置的完整体（离线包）
 *   4. 安装目录下的 engine\（可写时，让依赖跟着安装路径走）
 *   5. %APPDATA%\Komi\engine
 */
function resolveEngineRoot() {
  if (process.env.GO_ENGINE_DIR) return process.env.GO_ENGINE_DIR;
  if (process.env.GO_USE_USER_ENGINE === '1') return USER_ENGINE;

  const saved = readEngineDirSetting();
  if (saved) return saved;

  if (hasEnginePayload(BUNDLED_ENGINE)) return BUNDLED_ENGINE;
  if (app.isPackaged && isWritableDir(INSTALL_DIR)) return INSTALL_ENGINE;
  return USER_ENGINE;
}

let ENGINE_ROOT = USER_ENGINE;
const TEST_TMP = path.join(DATA_DIR, 'tmp');

/** 跑一次 <exe> version，能拿到后端名就说明该后端组件完整 */
function probeBackendLabelSafe(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['version'], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      const text = String(stdout || '') + String(stderr || '');
      const m = /Using\s+([^\n]+?)\s+backend/i.exec(text);
      resolve(err ? null : m ? m[1].trim() : 'ok');
    });
  });
}

const PROBE_JS = `(function(){
  const cv = document.getElementById('board');
  const ctx = cv.getContext('2d');
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let nonBlank = 0; const colors = new Set();
  for (let i = 0; i < d.length; i += 4 * 199) {
    if (d[i] || d[i+1] || d[i+2]) nonBlank++;
    colors.add(d[i] + ',' + d[i+1] + ',' + d[i+2]);
  }
  return {
    apiPresent: typeof window.go === 'object',
    rulesPresent: typeof window.GoRules === 'object',
    canvas: [cv.width, cv.height],
    nonBlankSamples: nonBlank,
    distinctColors: colors.size,
    size: document.getElementById('sizeSelect').value,
    level: document.getElementById('levelSelect').selectedOptions[0]?.textContent,
    turnText: document.getElementById('turnText').textContent,
    moveCount: Number(document.getElementById('moveCount').textContent),
    captures: document.getElementById('captureText').textContent,
    winrate: document.getElementById('winrateText').textContent,
    scoreLead: document.getElementById('scoreLeadText').textContent,
    candidates: document.getElementById('candidateList').children.length,
    candidateSample: [...document.querySelectorAll('#candidateList li')].slice(0,3).map(li => li.textContent.replace(/\\s+/g,' ').trim()),
    logTail: [...document.querySelectorAll('#logBox div')].slice(-8).map(el => el.textContent),
    perfMode: document.getElementById('perfSelect') ? document.getElementById('perfSelect').value : null,
    perfText: document.getElementById('perfText') ? document.getElementById('perfText').textContent : null,
    thinkingVisible: !document.getElementById('thinking').classList.contains('hidden'),
    modalVisible: !document.getElementById('resultModal').classList.contains('hidden'),
  };
})()`;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** 无界面自检：新局 → 人落子 → AI 应手 → 难度切换 → 数子 */
async function runSelfTest() {
  const mgr = new EngineManager({ rootDir: APP_ROOT, threads: 4 });
  mgr.on('log', (l) => console.log('[engine]', l));
  const t = (label) => console.log(`\n### ${label}`);
  try {
    t('新局 9 路 · 拟人中级（lv4）');
    await mgr.newGame({ size: 9, komi: 6.5, levelId: 'lv4' });

    t('人落子 E5');
    await mgr.play('B', 'E5');

    t('AI 应手');
    const r1 = await mgr.genmove('W');
    console.log(`  ${r1.move}  ${r1.elapsedMs}ms  候选=${r1.candidates.length}  胜率=${r1.winrate?.toFixed(3)}`);
    console.log(
      `  前 3: ${r1.candidates
        .slice(0, 3)
        .map((c) => `${c.move}(${c.visits}v ${(c.winrate * 100).toFixed(0)}%)`)
        .join('  ')}`,
    );

    t('难度 lv4 → lv8（需要重启引擎，换网络）');
    console.log('  restarted =', (await mgr.setLevel('lv8')).restarted);
    const r2 = await mgr.genmove('B');
    console.log(`  ${r2.move}  ${r2.elapsedMs}ms  候选=${r2.candidates.length}`);

    t('难度 lv8 → lv6（拟人 1 段，需换回 human 网络）');
    console.log('  restarted =', (await mgr.setLevel('lv6')).restarted);
    const r3 = await mgr.genmove('W');
    console.log(`  ${r3.move}  ${r3.elapsedMs}ms`);

    t('数子');
    const sc = await mgr.finalScore();
    console.log('  final_score =', sc.score);

    t('自检通过');
  } catch (err) {
    console.error('\n### 自检失败:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    await mgr.shutdown().catch(() => {});
    app.quit();
  }
}

/** UI 交互回放：切 9 路 → 模拟点击落子 → 检查 AI 是否应手 → 悔棋 */
async function runUiPlayThrough(target) {
  const js = (code) => target.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = (label) => console.log(`\n### ${label}`);

  try {
    step('等待引擎启动');
    await wait(11000);
    console.log('初始状态:', JSON.stringify(await js(PROBE_JS), null, 2));

    step('切换到 9 路');
    await js(`(function(){const s=document.getElementById('sizeSelect');s.value='9';s.dispatchEvent(new Event('change'));})()`);
    await wait(12000);

    step('模拟点击中心点（E5）');
    const clickAt = async (gx, gy) =>
      js(`(function(){
        const cv = document.getElementById('board');
        const rect = cv.getBoundingClientRect();
        const side = parseFloat(cv.style.width);
        const n = Number(document.getElementById('sizeSelect').value);
        const margin = Math.round(side * 0.055);
        const cell = (side - margin * 2) / (n - 1);
        const x = rect.left + margin + ${gx} * cell;
        const y = rect.top + margin + ${gy} * cell;
        cv.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
        cv.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
        return { gx: ${gx}, gy: ${gy} };
      })()`);
    console.log('  点击:', JSON.stringify(await clickAt(4, 4)));
    await wait(14000);

    step('再走两回合，累积胜率曲线');
    console.log('  点击:', JSON.stringify(await clickAt(2, 6)));
    await wait(12000);
    console.log('  点击:', JSON.stringify(await clickAt(6, 2)));
    await wait(12000);
    console.log('落子后状态:', JSON.stringify(await js(PROBE_JS), null, 2));

    step('胜率走势图：黑白面积占比是否与胜率一致');
    const chart = await js(`(function(){
      const cv = document.getElementById('winrateChart');
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      const w = cv.width, h = cv.height;
      const img = ctx.getImageData(0, 0, w, h).data;
      const brightAt = (x, y) => {
        const i = (y * w + x) * 4;
        return (img[i] + img[i+1] + img[i+2]) / 3;
      };
      // 逐列找黑白分界：从上往下第一处亮度骤降的位置
      const boundaryOf = (x) => {
        for (let y = 0; y < h; y++) if (brightAt(x, y) < 128) return y;
        return h;
      };
      const cols = 24;
      const fracs = [];
      for (let c = 0; c < cols; c++) {
        const x = Math.min(w - 1, Math.round((c / (cols - 1)) * (w - 1)));
        fracs.push(1 - boundaryOf(x) / h);   // 黑色面积占比
      }
      const avgBlack = fracs.reduce((a, b) => a + b, 0) / fracs.length;
      const lastBlack = fracs[fracs.length - 1];
      return {
        canvas: [w, h],
        blackAreaAvgPct: +(avgBlack * 100).toFixed(1),
        blackAreaTailPct: +(lastBlack * 100).toFixed(1),
        winrateText: document.getElementById('winrateText').textContent,
        hintBlack: document.getElementById('hintBlack').textContent,
        hintWhite: document.getElementById('hintWhite').textContent,
        note: document.querySelector('.chart-hint-note').textContent,
      };
    })()`);
    console.log('  走势图:', JSON.stringify(chart, null, 2));

    step('形势判断（点击按钮，检查弹窗）');
    await js(`document.getElementById('btnScore').click()`);
    await wait(6000);
    const scoreInfo = await js(`(function(){
      const m = document.getElementById('resultModal');
      return {
        visible: !m.classList.contains('hidden'),
        title: document.getElementById('resultTitle').textContent,
        detail: document.getElementById('resultDetail').textContent,
        thinking: !document.getElementById('thinking').classList.contains('hidden'),
      };
    })()`);
    console.log('  弹窗:', JSON.stringify(scoreInfo, null, 2));
    await js(`document.getElementById('btnResultClose').click()`);

    step('悔棋');
    await js(`document.getElementById('btnUndo').click()`);
    await wait(4000);
    const afterUndo = await js(PROBE_JS);
    console.log(
      '悔棋后:',
      JSON.stringify(
        { moveCount: afterUndo.moveCount, turnText: afterUndo.turnText, logTail: afterUndo.logTail.slice(-2) },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error('UI 回放失败:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    await manager?.shutdown().catch(() => {});
    app.quit();
  }
}

﻿/** UI 级验证：让子棋 → 观战 → 复盘，三个新功能各跑一遍 */
async function runUiFeatureTest(target) {
  const js = (code) => target.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = () => js('window.__state ? window.__state() : null');
  const step = (label) => console.log(`\n### ${label}`);

  try {
    await wait(13000);
    console.log("启动状态:", JSON.stringify(await state()));

    step("让子棋：9 路 + 让 2 子");
    await js(`(function(){
      const s = document.getElementById('sizeSelect'); s.value='9'; s.dispatchEvent(new Event('change'));
    })()`);
    await wait(9000);
    await js(`(function(){
      const h = document.getElementById('handicapSelect'); h.value='2'; h.dispatchEvent(new Event('change'));
    })()`);
    await wait(17000);
    const hc = await state();
    console.log("  让子局状态:", JSON.stringify(hc));

    step("AI 观战：黑 lv3 vs 白 lv7（观战速度预设）");
    await js(`(function(){
      document.querySelector('.mode-btn[data-mode="spectate"]').click();
      document.getElementById('specBlack').value='lv3';
      document.getElementById('specWhite').value='lv7';
      document.getElementById('specMaxMoves').value='80';
      const s = document.getElementById('specSpeed');
      s.value = 'fast';
      s.dispatchEvent(new Event('change'));
    })()`);
    await wait(700);
    const speedUi = await js(`(function(){
      const g = (id) => document.getElementById(id).value;
      return {
        speed: g('specSpeed'),
        visits: g('specVisits'),
        pace: g('specPace'),
        hint: document.getElementById('specSpeedHint').textContent,
      };
    })()`);
    console.log("  速度预设:", JSON.stringify(speedUi));
    await wait(1500);
    await js(`document.getElementById('btnSpectateStart').click()`);
    await wait(18000);
    const spec = await state();
    const specText = await js(`document.getElementById('specStatus').textContent`);
    const metricsText = await js(`(function(){
      const g = (id) => document.getElementById(id).textContent;
      return { cpu: g('cpuText'), gpu: g('gpuText'), vram: g('vramText'), backend: g('backendText') };
    })()`);
    const policyText = await js(`(function(){
      const list = document.getElementById('candidateList');
      return {
        title: document.getElementById('candidatesTitle').textContent,
        rows: list.children.length,
        sample: [...list.children].slice(0, 3).map((li) => li.textContent.replace(/\\s+/g, ' ').trim()),
      };
    })()`);
    console.log("  观战中:", JSON.stringify({ moveNumber: spec.moveNumber, blacks: spec.blacks, whites: spec.whites, running: spec.spectateRunning }));
    console.log("  状态栏:", specText);
    console.log("  系统占用:", JSON.stringify(metricsText));
    console.log("  落子概率面板:", JSON.stringify(policyText));
    console.log("  双方概率条数 黑/白:", spec.policyB, "/", spec.policyW);

    step("停止观战（按钮需立刻生效）");
    const tStop = Date.now();
    await js(`document.getElementById('btnSpectateStop').click()`);
    let stoppedAt = null;
    for (let i = 0; i < 20; i++) {
      await wait(150);
      const st = await state();
      if (!st.spectateRunning) {
        stoppedAt = Date.now() - tStop;
        break;
      }
    }
    const stopText = await js(`document.getElementById('specStatus').textContent`);
    console.log("  停止耗时:", stoppedAt == null ? "未停止（异常）" : stoppedAt + "ms", " 状态栏:", stopText);
    await wait(1200);

    step("保存观战棋谱（点真实按钮走 IPC，不走测试钩子）");
    await fs.mkdir(TEST_TMP, { recursive: true });
    const sgfOut = path.join(TEST_TMP, 'spectate-ui.sgf');
    // 让主进程跳过原生保存弹窗，直接写到这个路径
    process.env.GO_TEST_SAVE_SGF = sgfOut;
    try {
      await fs.rm(sgfOut, { force: true });
    } catch {
      /* ignore */
    }
    const saveBtnState = await js(`(function(){
      const b = document.getElementById('btnSaveSgf');
      return { disabled: b.disabled, label: b.textContent.trim() };
    })()`);
    console.log("  按钮状态:", JSON.stringify(saveBtnState));
    await js(`document.getElementById('btnSaveSgf').click()`);
    await wait(1500);
    delete process.env.GO_TEST_SAVE_SGF;
    try {
      const txt = await fs.readFile(sgfOut, 'utf8');
      const moveCount = (txt.match(/;[BW]\[/g) || []).length;
      const names = (txt.match(/P[BW]\[[^\]]*\]/g) || []).join(' ');
      console.log(`  ✓ 按钮导出成功：${txt.length} 字节，${moveCount} 手，${names}`);
    } catch (err) {
      console.log("  ✗ 按钮导出失败:", err.message);
      const logTail = await js(`[...document.querySelectorAll('#logBox div')].slice(-4).map((d) => d.textContent)`);
      console.log("  日志尾部:", JSON.stringify(logTail));
      process.exitCode = 1;
    }

    step("保存棋谱：直接指定路径（测试钩子 window.__saveSgf）");
    const sgfDirect = path.join(TEST_TMP, 'spectate.sgf');
    try {
      await fs.rm(sgfDirect, { force: true });
    } catch {
      /* ignore */
    }
    await js('window.__saveSgf(' + JSON.stringify(sgfDirect) + ')');
    await wait(900);
    try {
      const txt = await fs.readFile(sgfDirect, 'utf8');
      const moveCount = (txt.match(/;[BW]\[/g) || []).length;
      console.log(`  ✓ 指定路径保存成功：${txt.length} 字节，${moveCount} 手`);
    } catch (err) {
      console.log("  ✗ 指定路径保存失败:", err.message);
      process.exitCode = 1;
    }

    step("棋谱复盘：加载 test-game.sgf");
    await js(`document.querySelector('.mode-btn[data-mode="review"]').click()`);
    await wait(1200);
    await fs.mkdir(TEST_TMP, { recursive: true });
    const sgfPath = path.join(TEST_TMP, 'test-game.sgf');
    if (!existsSync(sgfPath)) {
      const { buildSgf } = await import('../shared/sgf.js');
      const demo = [
        ['B', 4, 4], ['W', 2, 6], ['B', 6, 2], ['W', 4, 6], ['B', 6, 6],
        ['W', 2, 2], ['B', 5, 4], ['W', 3, 4], ['B', 4, 3], ['W', 5, 6],
        ['B', 3, 5], ['W', 4, 5], ['B', 5, 2], ['W', 2, 4], ['B', 6, 4],
      ].map(([color, x, y]) => ({ color, x, y }));
      await fs.writeFile(sgfPath, buildSgf({ size: 9, komi: 7, moves: demo }), 'utf8');
    }
    await js("window.__openSgf(" + JSON.stringify(sgfPath) + ")");
    await wait(45000);
    const rev = await state();
    const revText = await js(`document.getElementById('reviewStatus').textContent`);
    const blunderCount = await js(`document.querySelectorAll('#blunderList li').length`);
    const blunderFirst = await js(`(document.querySelector('#blunderList li:not(.muted)') || {}).textContent || ''`);
    console.log("  复盘状态:", JSON.stringify({ index: rev.reviewIndex, timeline: rev.reviewTimeline, blunders: rev.reviewBlunders }));
    console.log("  状态栏:", revText);
    console.log("  恶手条目:", blunderCount, "首个:", String(blunderFirst).replace(/\\s+/g, " ").trim());

    step("复盘导航：下一手 / 跳恶手");
    await js(`document.getElementById('btnReviewNext').click()`);
    await wait(900);
    await js(`document.getElementById('btnReviewNext').click()`);
    await wait(900);
    const nav = await state();
    await js(`document.getElementById('btnReviewBlunder').click()`);
    await wait(900);
    const nav2 = await state();
    const chart = await js(`(function(){
      const cv = document.getElementById('winrateChart');
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let gold = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i+1] > 170 && d[i+2] < 130) gold++;
      return { goldPixels: gold, width: cv.width, height: cv.height };
    })()`);
    console.log("  导航 index:", nav.reviewIndex, "→ 跳恶手后:", nav2.reviewIndex);
    console.log("  走势图当前手标记:", chart.goldPixels > 0 ? "有" : "无", "(" + chart.width + "x" + chart.height + ")");

    step("设置面板：语言 / 后台计算 / 组件 / 跑分");
    await js(`document.getElementById('btnSettings').click()`);
    await wait(1800);
    const setUi = await js(`(function(){
      const g = (id) => document.getElementById(id);
      return {
        visible: !g('settingsModal').classList.contains('hidden'),
        lang: g('setLang').value,
        perf: g('setPerfMode').value,
        backend: g('setBackendMode').value,
        info: g('setComputeInfo').textContent,
        about: g('setAbout').textContent,
        deps: g('depsList').children.length,
        depsFirst: g('depsList').children[0] ? g('depsList').children[0].textContent.replace(/\\s+/g, ' ').trim() : '',
      };
    })()`);
    console.log("  设置面板:", JSON.stringify(setUi, null, 2));

    step("语言切换 en → zh");
    await js(`(function(){ const s = document.getElementById('setLang'); s.value='en'; s.dispatchEvent(new Event('change')); })()`);
    await wait(2200);
    const enUi = await js(`(function(){
      const q = (sel) => document.querySelector(sel);
      return {
        lang: document.documentElement.getAttribute('lang'),
        modeBtn: q('.mode-btn[data-mode="play"]').textContent,
        saveBtn: document.getElementById('btnSaveSgf').textContent,
        turnLabel: q('#statusCard .stat-row span').textContent,
        title: q('#settingsModal h2').textContent,
      };
    })()`);
    console.log("  英文界面:", JSON.stringify(enUi));
    await js(`(function(){ const s = document.getElementById('setLang'); s.value='zh'; s.dispatchEvent(new Event('change')); })()`);
    await wait(1800);
    const zhUi = await js(`(function(){
      return {
        lang: document.documentElement.getAttribute('lang'),
        modeBtn: document.querySelector('.mode-btn[data-mode="play"]').textContent,
      };
    })()`);
    console.log("  切回中文:", JSON.stringify(zhUi));

    step("后台计算：切到仅 CPU 再切回自动");
    await js(`(function(){ const s = document.getElementById('setBackendMode'); s.value='cpu'; s.dispatchEvent(new Event('change')); })()`);
    await wait(1500);
    const cpuMode = await js(`window.go.settings().then((s) => ({ backendMode: s.backendMode, backend: s.backendLabel }))`);
    console.log("  切到仅 CPU:", JSON.stringify(cpuMode));
    // 新开一局逼引擎按 CPU 重启
    const cpuRun = await js(
      `window.go.newGame({ size: 9, komi: 7, levelId: 'lv8', handicap: 0 }).then((r) => r.status && { backend: r.status.backendLabel, backendId: r.status.backend })`,
    );
    console.log("  CPU 引擎状态:", JSON.stringify(cpuRun));
    await js(`(function(){ const s = document.getElementById('setBackendMode'); s.value='auto'; s.dispatchEvent(new Event('change')); })()`);
    await wait(1500);
    const autoRun = await js(
      `window.go.newGame({ size: 9, komi: 7, levelId: 'lv8', handicap: 0 }).then((r) => r.status && { backend: r.status.backendLabel, backendId: r.status.backend })`,
    );
    console.log("  切回自动:", JSON.stringify(autoRun));
    if (cpuRun && cpuRun.backendId !== 'cpu') {
      console.log("  ✗ 切到仅 CPU 后引擎仍在用", cpuRun.backendId);
      process.exitCode = 1;
    }

    step("跑分：GPU（与当前设置无关，固定最吃显卡）");
    // 先把性能模式切成省电，验证跑分不会跟着变弱
    await js(`window.go.setSettings({ perfMode: 'balanced' })`);
    await wait(900);
    const bench = await js(`window.go.benchmarkRun({ target: 'gpu', visits: 120, positions: 2 })`);
    console.log(
      "  跑分结果:",
      JSON.stringify({
        ok: bench.ok,
        visits: bench.visits,
        nnEvals: bench.nnEvals,
        batch: bench.batchSize,
        threads: bench.threads,
        tune: bench.tune,
        reason: bench.reason,
      }),
    );
    if (!bench.ok) {
      console.log("  跑分输出尾部:", String(bench.output ?? "").split("\n").slice(-6).join(" | "));
      process.exitCode = 1;
    } else if (bench.tune && bench.threads < 16) {
      console.log(`  ✗ 省电模式下跑分被压低（${bench.threads} 线程），应与设置无关`);
      process.exitCode = 1;
    }
    await js(`window.go.setSettings({ perfMode: 'performance' })`);

    step("关闭设置面板");
    await js(`document.getElementById('btnSettingsClose').click()`);
    await wait(600);
    const modalClosed = await js(`document.getElementById('settingsModal').classList.contains('hidden')`);
    console.log("  面板已关闭:", modalClosed);

    step("性能模式：切换到省电再切回高吞吐（引擎重启 + 局面恢复）");
    await js(`document.querySelector('.mode-btn[data-mode="play"]').click()`);
    await wait(9000);
    const beforePerf = await js(`(function(){
      return {
        mode: document.getElementById('perfSelect').value,
        text: document.getElementById('perfText').textContent,
        moveNumber: window.__state().moveNumber,
        stones: window.__state().stones,
      };
    })()`);
    console.log("  当前:", JSON.stringify(beforePerf));
    await js(`(function(){
      const s = document.getElementById('perfSelect');
      s.value = s.value === 'performance' ? 'balanced' : 'performance';
      s.dispatchEvent(new Event('change'));
    })()`);
    await wait(1500);
    const midPerf = await js(`(function(){
      return {
        mode: document.getElementById('perfSelect').value,
        text: document.getElementById('perfText').textContent,
        status: (window.__state().moveNumber),
      };
    })()`);
    console.log("  切换后:", JSON.stringify(midPerf));
    // 让引擎真正重启：下一手 AI 落子会触发 ensureEngine
    await js(`document.getElementById('btnPass').click()`);
    await wait(14000);
    const afterPerf = await js(`(function(){
      return {
        mode: document.getElementById('perfSelect').value,
        stones: window.__state().stones,
        moveNumber: window.__state().moveNumber,
        logTail: [...document.querySelectorAll('#logBox div')].slice(-6).map((d) => d.textContent),
      };
    })()`);
    console.log("  落子后:", JSON.stringify(afterPerf, null, 2));
    console.log("  局面恢复:", afterPerf.logTail.some((l) => l.includes("已恢复局面")) ? "✓ 有恢复日志" : "（无历史，属正常）");

    step("全部通过");
  } catch (err) {
    console.error("UI 功能测试失败:", err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    await manager?.shutdown().catch(() => {});
    await spectate?.shutdown().catch(() => {});
    app.quit();
  }
}


/** 无界面：复盘测试（棋谱 → 逐手评估 → 恶手） */
async function runReviewTest(sgfPath) {
  const text = await fs.readFile(sgfPath, 'utf8');
  const game = parseSgf(text);
  const mgr = new EngineManager({ rootDir: APP_ROOT, threads: 4 });
  mgr.on('log', (l) => console.log('[engine]', l));

  console.log(`\n### 载入棋谱 ${sgfPath}`);
  console.log(`  ${game.size} 路  贴目 ${game.komi}  手数 ${game.moves.length}  让子 ${game.handicap ?? 0}`);

  const t0 = Date.now();
  const r = await mgr.reviewGame({
    size: game.size,
    komi: game.komi,
    handicap: game.handicap ?? 0,
    moves: game.moves.map((m) => ({ color: m.color, x: m.x, y: m.y, pass: m.pass })),
    visits: 120,
    perMoveMs: 400,
  });
  console.log(`\n### 逐手评估：${r.timeline.length} 个局面，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const t of r.timeline.slice(0, 6)) {
    console.log(
      `  第 ${String(t.index).padStart(2)} 手 ${t.move?.color ?? '-'}${t.move?.gtp ?? '初始'}  ` +
        `黑胜率 ${t.blackWin == null ? '?' : (t.blackWin * 100).toFixed(1) + '%'}  ` +
        `目差 ${t.scoreLeadBlack == null ? '?' : t.scoreLeadBlack.toFixed(1)}`,
    );
  }

  const blunders = [];
  for (let i = 1; i < r.timeline.length; i++) {
    const before = r.timeline[i - 1];
    const after = r.timeline[i];
    if (before.blackWin == null || after.blackWin == null) continue;
    const mover = after.move?.color ?? game.moves[i - 1]?.color;
    if (!mover) continue;
    const beforeMover = mover === 'B' ? before.blackWin : 1 - before.blackWin;
    const afterMover = mover === 'B' ? after.blackWin : 1 - after.blackWin;
    const drop = beforeMover - afterMover;
    if (drop >= 0.1) {
      blunders.push({
        ply: i,
        color: mover,
        played: after.move?.gtp ?? '',
        best: before.candidates?.[0]?.move ?? '',
        drop,
        severe: drop >= 0.25,
      });
    }
  }
  console.log(`\n### 恶手：${blunders.length} 个`);
  for (const b of blunders.slice(0, 8)) {
    console.log(
      `  第 ${String(b.ply).padStart(2)} 手 ${b.color === 'B' ? '黑' : '白'} ${b.played}` +
        `${b.severe ? '（严重）' : ''} 亏 ${(b.drop * 100).toFixed(1)}%  建议 ${b.best || '—'}`,
    );
  }

  await mgr.shutdown();
  app.quit();
}

/** 无界面：AI 观战 + ELO 测速 */
async function runSpectateTest() {
  const runner = new SpectateRunner({ rootDir: APP_ROOT, dataDir: DATA_DIR, engineRoot: ENGINE_ROOT, threads: 4 });
  runner.on('log', (l) => console.log('[spec]', l));

  console.log('\n### 单局观战：黑 lv2 vs 白 lv6（9 路）');
  let count = 0;
  runner.on('move', (ev) => {
    count++;
    if (count <= 12 || count % 20 === 0) {
      const m = ev.move;
      process.stdout.write(`${m.color}${m.pass ? 'pass' : m.gtp} `);
    }
  });
  const r = await runner.playGame({ size: 9, komi: 7, levelBlack: 'lv2', levelWhite: 'lv6', paceMs: 0, maxMoves: 140 });
  console.log(`\n  结果=${r.result} 胜方=${r.winner ?? '—'} 手数=${r.moves.length}`);

  console.log('\n### ELO 测速：A=lv2 vs B=lv6，4 局，每手 40 访问');
  const summary = await runner.runMatch({
    games: 4,
    size: 9,
    komi: 7,
    levelA: 'lv2',
    levelB: 'lv6',
    visitsA: 40,
    visitsB: 40,
    onGameEnd: (g) => console.log(`  第 ${g.game} 局：A执${g.aIsBlack ? '黑' : '白'} → ${g.winner ?? '和'}（${g.result}）`),
  });
  console.log('  汇总:', JSON.stringify(summary));

  await runner.shutdown();
  app.quit();
}

/** 无界面：让子棋测试 */
async function runHandicapTest() {
  const mgr = new EngineManager({ rootDir: APP_ROOT, threads: 4 });
  mgr.on('log', (l) => console.log('[engine]', l));
  console.log('\n### 让子棋：9 路，让 2 子，贴 0.5');
  const res = await mgr.newGame({ size: 9, komi: 0.5, levelId: 'lv5', handicap: 2 });
  console.log('  让子坐标:', res.handicapStones.join(' '));
  const w = await mgr.genmove('W');
  console.log(`  白棋应手: ${w.move}  ${w.elapsedMs}ms`);

  console.log('\n### 让 4 子');
  const res4 = await mgr.newGame({ size: 9, komi: 0.5, levelId: 'lv5', handicap: 4 });
  console.log('  让子坐标:', res4.handicapStones.join(' '));
  const w4 = await mgr.genmove('W');
  console.log(`  白棋应手: ${w4.move}  ${w4.elapsedMs}ms`);

  await mgr.shutdown();
  app.quit();
}

/**
 * 无界面：性能模式测试
 * 1) 高吞吐 vs 省电 的每秒访问数对比
 * 2) 切换性能模式会重启引擎 —— 验证局面被自动恢复（往已有棋子处落子必须被拒绝）
 */
async function runPerfTest() {
  const mgr = new EngineManager({
    rootDir: APP_ROOT,
    threads: 6,
    perfMode: 'performance',
  });
  mgr.on('log', (l) => console.log('[engine]', l));
  const step = (s) => console.log(`\n### ${s}`);
  const rate = (ms, visits) => `${Math.round(visits / (ms / 1000))} visits/s`;

  step(`高吞吐模式：${mgr.tune.numSearchThreads} 线程 / batch ${mgr.tune.nnMaxBatchSize}`);
  await mgr.newGame({ size: 9, komi: 7, levelId: 'lv9' });
  const a = await mgr.genmove('B');
  console.log(`  黑 ${a.move}  ${a.elapsedMs}ms  ${rate(a.elapsedMs, 2000)}`);
  const b = await mgr.genmove('W');
  console.log(`  白 ${b.move}  ${b.elapsedMs}ms  ${rate(b.elapsedMs, 2000)}`);
  console.log(`  引擎记录局面：${mgr.history.length} 手`);

  step('切到省电模式（引擎重启 → 局面自动恢复）');
  const sw = await mgr.setPerfMode('balanced');
  console.log(`  changed=${sw.changed} restarted=${sw.restarted} 线程=${sw.tune.numSearchThreads}`);
  const c = await mgr.genmove('B');
  console.log(`  黑 ${c.move}  ${c.elapsedMs}ms  ${rate(c.elapsedMs, 2000)}`);
  console.log(`  引擎记录局面：${mgr.history.length} 手（应比上面多 1）`);

  step('校验局面恢复：往已有黑子处落白子应被引擎拒绝');
  const occupied = mgr.history.find((m) => m.color === 'B' && m.coord !== 'pass');
  if (!occupied) {
    console.log('  ⚠ 没有可用于校验的着法，跳过');
  } else {
    try {
      await mgr.play('W', occupied.coord);
      console.log(`  ✗ 恢复失败：${occupied.coord} 上已有黑子，引擎却接受了这手棋`);
      process.exitCode = 1;
    } catch (err) {
      console.log(`  ✓ 引擎拒绝 W ${occupied.coord}：${String(err.message).split('\n')[0]}`);
    }
  }

  step('完成');
  await mgr.shutdown();
  app.quit();
}

/** 验证首次安装向导：组件列表 → 下载 → 完成后自动进游戏 */
async function runSetupTest(target) {
  const js = (code) => target.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = (label) => console.log(`\n### ${label}`);
  try {
    await wait(4000);
    const first = await js(`(function(){
      const screen = document.getElementById('setupScreen');
      const rows = [...document.querySelectorAll('#setupList li')].map((li) => ({
        text: li.textContent.replace(/\\s+/g, ' ').trim(),
        checked: li.querySelector('input') ? li.querySelector('input').checked : false,
        disabled: li.querySelector('input') ? li.querySelector('input').disabled : false,
      }));
      return {
        visible: !screen.classList.contains('hidden'),
        hw: document.getElementById('setupHw').textContent,
        rows,
        total: document.getElementById('setupTotal').textContent,
      };
    })()`);
    console.log('  向导可见:', first.visible);
    console.log('  环境检测:', first.hw);
    for (const r of first.rows) console.log('   -', (r.checked ? '[✓]' : '[ ]') + (r.disabled ? '(不适用)' : '') , r.text);
    console.log('  已选合计:', first.total);

    step('点击「下载并安装」');
    await js("document.getElementById('btnSetupInstall').click()");

    let done = false;
    let lastText = '';
    for (let i = 0; i < 240; i++) {
      await wait(1000);
      const st = await js(`(function(){
        const screen = document.getElementById('setupScreen');
        return {
          hidden: screen.classList.contains('hidden'),
          progress: document.getElementById('setupProgressText') ? document.getElementById('setupProgressText').textContent : '',
          hint: document.getElementById('setupHint').textContent,
          states: [...document.querySelectorAll('#setupList .comp-state')].map((s) => s.textContent),
        };
      })()`);
      if (st.progress !== lastText) {
        lastText = st.progress;
        if (i % 3 === 0) console.log('  进度:', st.progress);
      }
      if (st.hidden) {
        done = true;
        console.log('  安装完成，向导已关闭');
        break;
      }
      if (/失败/.test(st.hint)) {
        console.log('  安装失败:', st.hint);
        break;
      }
    }

    if (done) {
      await wait(15000);
      const game = await js("window.__state ? window.__state() : null");
      const backend = await js("document.getElementById('backendText') ? document.getElementById('backendText').textContent : '—'");
      const verify = await js(`[...document.querySelectorAll('#setupVerify li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim())`);
      console.log('  后端校验:', JSON.stringify(verify));
      console.log('  进入游戏:', JSON.stringify({ moveNumber: game?.moveNumber, mode: game?.mode }));
      console.log('  计算后端:', backend);
    }

    step(done ? '向导流程通过' : '向导流程未完成');
  } catch (err) {
    console.error('向导测试失败:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    await manager?.shutdown().catch(() => {});
    await spectate?.shutdown().catch(() => {});
    app.quit();
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 940,
    minWidth: 980,
    minHeight: 720,
    backgroundColor: '#1a1b1e',
    title: 'Komi · 内置 KataGo',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (ARGV.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => {
    win = null;
  });

  win.webContents.on('console-message', (...args) => {
    const event = args[0];
    const message = typeof event === 'object' && event?.message ? event.message : args[2];
    if (typeof message === 'string' && !message.includes('Security Warning')) {
      console.log('[renderer]', message.slice(0, 400));
    }
  });

  if (IS_PLAY) {
    win.webContents.once('did-finish-load', () => runUiPlayThrough(win));
    return;
  }

  if (uiTestMode) {
    win.webContents.once('did-finish-load', () => runUiFeatureTest(win));
    return;
  }

  if (ARGV.includes('--setup-test')) {
    win.webContents.once('did-finish-load', () => runSetupTest(win));
    return;
  }

  if (IS_SHOT) {
    win.webContents.once('did-finish-load', async () => {
      const shotJs = (code) => win.webContents.executeJavaScript(code);
      const shotWait = (ms) => new Promise((r) => setTimeout(r, ms));
      await shotWait(12000);

      // 默认先走几手，让截图里能看到棋子、候选点与胜率走势（--shot-plain 可跳过）
      if (!ARGV.includes('--shot-plain')) {
        try {
          await shotJs("(function(){const s=document.getElementById('sizeSelect');s.value='9';s.dispatchEvent(new Event('change'));})()");
          await shotWait(11000);
          const clickAt = (gx, gy) => shotJs(`(function(){
            const cv = document.getElementById('board');
            const rect = cv.getBoundingClientRect();
            const side = parseFloat(cv.style.width);
            const n = Number(document.getElementById('sizeSelect').value);
            const margin = Math.round(side * 0.055);
            const cell = (side - margin * 2) / (n - 1);
            const x = rect.left + margin + ${gx} * cell;
            const y = rect.top + margin + ${gy} * cell;
            cv.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
            cv.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
            return true;
          })()`);
          await clickAt(4, 4);
          await shotWait(9000);
          await clickAt(2, 6);
          await shotWait(9000);
          await clickAt(6, 2);
          await shotWait(9000);
        } catch (err) {
          console.error('演示走子失败:', err.message);
        }
      }

      try {
        console.log('页面探针:', JSON.stringify(await win.webContents.executeJavaScript(PROBE_JS), null, 2));
        const image = await win.webContents.capturePage();
        const out = path.join(TEST_TMP, 'shot.png');
        await fs.mkdir(path.dirname(out), { recursive: true });
        await fs.writeFile(out, image.toPNG());
        console.log('截图已保存:', out);
      } catch (err) {
        console.error('截图失败:', err.message);
      }
      app.quit();
    });
  }
}

app.whenReady().then(async () => {
  if (IS_SELFTEST) {
    await runSelfTest();
    return;
  }

  if (ARGV.includes('--review')) {
    const file = ARGV[ARGV.indexOf('--review') + 1];
    await runReviewTest(file);
    return;
  }

  if (ARGV.includes('--ui')) {
    // 走完整窗口流程，createWindow 里挂载 UI 测试
    uiTestMode = true;
  }

  if (ARGV.includes('--spectate')) {
    await runSpectateTest();
    return;
  }

  if (ARGV.includes('--handicap')) {
    await runHandicapTest();
    return;
  }

  if (ARGV.includes('--perf-test')) {
    await runPerfTest();
    return;
  }

  ENGINE_ROOT = resolveEngineRoot();
  settings = { ...(await readSettingsFile()) };
  // 没设置过就默认高吞吐（弱机可以在界面里切回省电）
  settings.perfMode = normalizePerfMode(settings.perfMode ?? PERF.PERFORMANCE);
  settings.backendMode = normalizeBackendMode(settings.backendMode);
  settings.lang = normalizeLang(settings.lang);
  manager = new EngineManager({
    rootDir: APP_ROOT,
    dataDir: DATA_DIR,
    engineRoot: ENGINE_ROOT,
    threads: 6,
    perfMode: settings.perfMode,
    perfEngines: 1,
    backendMode: settings.backendMode,
  });
  manager.on('log', (line) => {
    console.log('[engine]', line);
    send('engine:log', line);
  });
  manager.on('crashed', (info) => send('engine:crashed', info));

  spectate = new SpectateRunner({
    rootDir: APP_ROOT,
    dataDir: DATA_DIR,
    engineRoot: ENGINE_ROOT,
    threads: 4,
    perfMode: settings.perfMode,
    backendMode: settings.backendMode,
  });
  spectate.on('log', (line) => {
    console.log('[spectate]', line);
    send('spectate:log', line);
  });
  spectate.on('gameStart', (g) => send('spectate:gameStart', g));
  spectate.on('move', (m) => send('spectate:move', m));
  spectate.on('gameEnd', (g) => send('spectate:gameEnd', g));
  spectate.on('matchEnd', (summary) => send('spectate:matchEnd', summary));

  metrics = new SystemMetrics({ intervalMs: 1500 });
  metrics.on('sample', (s) => send('system:metrics', { ...s, backend: manager.backendLabel ?? null, backendDetail: manager.backendDetail ?? null }));
  metrics.start();

  ipcMain.handle('app:info', () => ({
    root: APP_ROOT,
    version: app.getVersion(),
    exe: manager.exePath,
    models: manager.models,
  }));

  ipcMain.handle('levels:list', () =>
    LEVELS.map((l) => ({
      ...describeLevel(l, normalizeLang(settings.lang)),
      isHumanStyle: l.backend === 'human',
    })),
  );

  ipcMain.handle('engine:status', () => manager.status());

  ipcMain.handle('game:new', async (_e, opts) => ({ ...(await manager.newGame(opts ?? {})), status: manager.status() }));
  ipcMain.handle('game:setLevel', async (_e, levelId) => ({
    ...(await manager.setLevel(levelId)),
    status: manager.status(),
  }));
  ipcMain.handle('game:play', async (_e, { color, coord }) => {
    await manager.play(color, coord);
    return { ok: true };
  });
  ipcMain.handle('game:genmove', async (_e, color) => manager.genmove(color));
  ipcMain.handle('game:undo', async (_e, times = 1) => {
    await manager.undo(times);
    return { ok: true };
  });
  ipcMain.handle('game:score', async () => manager.finalScore());

  ipcMain.handle('game:saveSgf', async (_e, { sgf, suggestedName, forcedPath } = {}) => {
    if (!sgf || typeof sgf !== 'string') throw new Error('棋谱内容为空');
    // 只有字符串才算「指定路径」，防止界面把事件对象之类的东西当路径传进来
    if (typeof forcedPath === 'string' && forcedPath) {
      await fs.writeFile(forcedPath, sgf, 'utf8');
      return { saved: true, path: forcedPath };
    }
    // 自动测试用：不走原生弹窗，直接写文件（GO_TEST_SAVE_SGF=<路径>）
    if (process.env.GO_TEST_SAVE_SGF) {
      const target = process.env.GO_TEST_SAVE_SGF;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, sgf, 'utf8');
      return { saved: true, path: target };
    }
    const res = await dialog.showSaveDialog(win, {
      title: '保存棋谱',
      defaultPath: path.join(app.getPath('documents'), suggestedName || 'game.sgf'),
      filters: [{ name: 'SGF 棋谱', extensions: ['sgf'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    await fs.writeFile(res.filePath, sgf, 'utf8');
    return { saved: true, path: res.filePath };
  });
  ipcMain.handle('engine:shutdown', async () => {
    await manager.shutdown();
    await spectate.shutdown();
    return { ok: true };
  });

  // ---------------------------------------------------------------- 组件目录
  ipcMain.handle('paths:info', async () => ({
    engineRoot: ENGINE_ROOT,
    installDir: INSTALL_DIR,
    userEngine: USER_ENGINE,
    installEngine: INSTALL_ENGINE,
    installWritable: isWritableDir(INSTALL_DIR),
    custom: Boolean(readEngineDirSetting()),
    componentsReady: (await missingComponents(ENGINE_ROOT)).filter((c) => c.required).length === 0,
  }));

  ipcMain.handle('paths:choose', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择组件存放目录（引擎与神经网络）',
      defaultPath: path.dirname(ENGINE_ROOT),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { changed: false };

    const target = res.filePaths[0];
    const previous = ENGINE_ROOT;
    if (path.resolve(target) === path.resolve(previous)) return { changed: false };

    // 旧目录已有组件、新目录没有 → 询问是否搬过去
    const oldReady = hasEnginePayload(previous) || existsSync(path.join(previous, 'directml'));
    const newEmpty = !existsSync(target) || (await fs.readdir(target).catch(() => [])).length === 0;
    let copied = false;
    if (oldReady && newEmpty && existsSync(previous)) {
      const ask = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['复制过去', '不复制（重新下载）', '取消'],
        defaultId: 0,
        cancelId: 2,
        message: '要把已下载的组件复制到新目录吗？',
        detail: `从 ${previous}\n到 ${target}\n\n复制约需几秒，可避免重新下载。`,
      });
      if (ask.response === 2) return { changed: false };
      if (ask.response === 0) {
        await fs.mkdir(target, { recursive: true });
        await fs.cp(previous, target, { recursive: true }).catch(() => {});
        copied = true;
      }
    }

    writeEngineDirSetting(target);
    ENGINE_ROOT = target;
    if (manager) {
      manager.engineDir = target;
      manager.cfgDir = path.join(DATA_DIR, 'config', 'generated');
      manager.refreshBackends();
    }
    if (spectate) spectate.engineRoot = target;
    manager?._note?.('组件目录已改为 ' + target + (copied ? '（已复制既有组件）' : ''));
    send('paths:changed', { engineRoot: target, copied });
    return { changed: true, engineRoot: target, copied };
  });

  // ---------------------------------------------------------------- 组件按需下载
  const downloadConfigPath = path.join(DATA_DIR, 'config', 'download.json');

  async function readMirrorMode() {
    if (process.env.GO_MIRROR) {
      return process.env.GO_MIRROR === 'china' ? 'china' : 'direct';
    }
    try {
      const raw = await fs.readFile(downloadConfigPath, 'utf8');
      const cfg = JSON.parse(raw);
      return cfg.mirror === 'china' ? 'china' : 'direct';
    } catch {
      return null; // 未设置 → 由探测结果决定
    }
  }

  async function writeMirrorMode(mode) {
    try {
      await fs.mkdir(path.dirname(downloadConfigPath), { recursive: true });
      await fs.writeFile(downloadConfigPath, JSON.stringify({ mirror: mode }, null, 2), 'utf8');
    } catch {
      /* 忽略 */
    }
  }

  // ---------------------------------------------------------------- 偏好设置
  const settingsPath = path.join(DATA_DIR, 'config', 'settings.json');

  async function readSettingsFile() {
    try {
      const raw = await fs.readFile(settingsPath, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  async function writeSettingsFile(patch) {
    const current = await readSettingsFile();
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    try {
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify(next, null, 2), 'utf8');
    } catch {
      /* 写入失败不影响本次运行 */
    }
    return next;
  }

  /** 当前性能模式与它换算出来的搜索参数（供界面展示） */
  function perfSnapshot() {
    const mode = normalizePerfMode(settings.perfMode);
    const backendId = manager?.backendId ?? null;
    const tune = tuningFor({ mode, threads: 6, engines: 1, backendId });
    const spectateTune = tuningFor({ mode, threads: 4, engines: 2, backendId });
    return {
      perfMode: mode,
      perfLabel: mode === PERF.PERFORMANCE ? '高吞吐' : '省电',
      backendMode: normalizeBackendMode(settings.backendMode),
      lang: normalizeLang(settings.lang),
      backendId,
      backendLabel: manager?.backendLabel ?? null,
      backendDetail: manager?.backendDetail ?? null,
      running: Boolean(manager?.engine?.running),
      tune,
      spectateTune,
      cores: os.cpus().length,
      version: app.getVersion(),
      uninstaller: uninstallerPath(),
      engineRoot: ENGINE_ROOT,
    };
  }

  /** 根目录下的卸载程序（便携版才有；MSI 安装版由系统卸载项负责） */
  function uninstallerPath() {
    const names =
      process.platform === 'win32'
        ? ['卸载 Komi.exe', 'Uninstall-Komi.exe']
        : ['uninstall.sh'];
    for (const dir of [INSTALL_DIR, APP_ROOT]) {
      for (const n of names) {
        const p = path.join(dir, n);
        if (existsSync(p)) return p;
      }
    }
    return null;
  }

  ipcMain.handle('settings:get', () => perfSnapshot());

  ipcMain.handle('settings:set', async (_e, patch = {}) => {
    let restarted = false;

    if (patch.perfMode !== undefined) {
      if (spectateBusy) {
        return { ok: false, reason: '观战/测速进行中，请先停止再切换性能模式', ...perfSnapshot() };
      }
      const mode = normalizePerfMode(patch.perfMode);
      settings = { ...settings, perfMode: mode };
      await writeSettingsFile({ perfMode: mode });
      const a = manager ? await manager.setPerfMode(mode) : { changed: false };
      const b = spectate ? await spectate.setPerfMode(mode) : { changed: false };
      restarted = Boolean(a.changed || b.changed) || restarted;
      if (restarted) {
        send(
          'engine:log',
          `性能模式 → ${mode === PERF.PERFORMANCE ? '高吞吐' : '省电'}（引擎将在下一次落子/分析时自动重启）`,
        );
      }
    }

    if (patch.backendMode !== undefined) {
      if (spectateBusy) {
        return { ok: false, reason: '观战/测速进行中，请先停止再切换计算方式', ...perfSnapshot() };
      }
      const mode = normalizeBackendMode(patch.backendMode);
      settings = { ...settings, backendMode: mode };
      await writeSettingsFile({ backendMode: mode });
      const a = manager ? await manager.setBackendMode(mode) : { changed: false };
      const b = spectate ? await spectate.setBackendMode(mode) : { changed: false };
      restarted = Boolean(a.changed || b.changed) || restarted;
      const label = mode === BACKEND_MODE.CPU ? '仅 CPU' : mode === BACKEND_MODE.GPU ? '仅 GPU' : '自动';
      send('engine:log', `后台计算方式 → ${label}${restarted ? '（下一次思考时自动重启引擎）' : ''}`);
    }

    if (patch.lang !== undefined) {
      const lang = normalizeLang(patch.lang);
      settings = { ...settings, lang };
      await writeSettingsFile({ lang });
    }

    return { ok: true, restarted, ...perfSnapshot() };
  });

  // ---------------------------------------------------------------- 组件状态（设置面板用）
  ipcMain.handle('components:list', async () => {
    const hw = await detectHardware();
    const out = [];
    for (const c of COMPONENTS) {
      const installed = await isInstalled(c, ENGINE_ROOT);
      const ev = evaluateComponent(hw, c);
      out.push({
        id: c.id,
        label: c.label,
        detail: c.detail,
        bytes: c.bytes,
        required: Boolean(c.required),
        installed,
        applicable: ev.applicable,
        recommended: Boolean(ev.recommended) || Boolean(c.required),
        reason: ev.reason ?? null,
      });
    }
    return { engineRoot: ENGINE_ROOT, components: out, hardware: summarize(hw) };
  });

  // ---------------------------------------------------------------- 跑分（benchmark）
  const ENGINE_BIN = process.platform === 'win32' ? 'katago.exe' : 'katago';

  function benchmarkTargets() {
    const out = [];
    const gpu = manager?.backends?.find((b) => b.id !== 'cpu');
    if (gpu) out.push({ id: 'gpu', label: `GPU · ${gpu.label}`, backendId: gpu.id, exe: gpu.exe });
    const cpu =
      manager?.backends?.find((b) => b.id === 'cpu') ??
      { id: 'cpu', label: 'CPU', exe: path.join(ENGINE_ROOT, 'cpu', ENGINE_BIN) };
    out.push({ id: 'cpu', label: `CPU · ${cpu.label}`, backendId: 'cpu', exe: cpu.exe });
    return out;
  }

  ipcMain.handle('benchmark:targets', () =>
    benchmarkTargets().map(({ id, label, backendId, exe }) => ({ id, label, backendId, available: existsSync(exe) })),
  );

  ipcMain.handle('benchmark:run', async (_e, { target = 'gpu', visits = 200, positions = 4 } = {}) => {
    if (benchRunning) return { ok: false, reason: '已有跑分在进行中' };
    const t = benchmarkTargets().find((x) => x.id === target);
    if (!t) return { ok: false, reason: '未知的跑分目标' };
    if (!existsSync(t.exe)) return { ok: false, reason: `没找到 ${t.label} 的引擎文件：${t.exe}` };

    const auto = manager && manager.engine?.running ? manager.engine : null;
    const wasRunning = Boolean(auto);
    // 跑分期间先停掉正在搜索的引擎，免得两边抢显卡把成绩拉低
    if (auto) await manager.engine.stop().catch(() => {});
    if (manager) {
      manager.engine = null;
      manager.activeKey = null;
    }

    benchRunning = true;
    const t0 = Date.now();
    try {
      // 跑分配置完全独立于用户设置：不读性能模式、不读档位、不读「仅 CPU / 仅 GPU」，
      // 固定用最能吃满硬件的参数（线程拉满、批次放大、CUDA 双 NN server 线程）
      const tune = benchmarkTuning({ backendId: t.backendId, target, cores: os.cpus().length });
      const { file: cfgFile } = await manager.ensureBenchCfg(t.backendId, tune);
      const numThreads = tune.numSearchThreads;
      const args = [
        'benchmark',
        '-model',
        manager.models.main,
        '-config',
        cfgFile,
        '-visits',
        String(visits),
        '-n',
        String(positions),
        '-t',
        String(numThreads),
        '-boardsize',
        '19',
      ];
      const result = await new Promise((resolve, reject) => {
        const proc = spawn(t.exe, args, { cwd: path.dirname(t.exe), windowsHide: true });
        let buf = '';
        let full = '';
        let lastLine = '';
        const timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            /* ignore */
          }
          reject(new Error(`跑分超时（${target === 'cpu' ? 600 : 240} 秒）`));
        }, target === 'cpu' ? 600000 : 240000);

        proc.stdout.on('data', (chunk) => {
          const text = String(chunk);
          full += text;
          buf += text;
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const s = line.trim();
            if (!s) continue;
            lastLine = s;
            send('benchmark:progress', { target, line: s });
          }
        });
        proc.stderr.on('data', (chunk) => {
          const s = String(chunk);
          full += s;
          if (/error|warn/i.test(s)) send('benchmark:progress', { target, line: s.trim() });
        });
        proc.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        proc.on('exit', (code) => {
          clearTimeout(timer);
          resolve({ code, output: full, lastLine });
        });
      });

      const text = `${result.output}\n${result.lastLine}`;
      // 取最后一次匹配：benchmark 会先跑一轮基线，最后一行才是推荐配置的成绩
      const lastMatch = (re) => {
        re.lastIndex = 0;
        let m = null;
        let last = null;
        while ((m = re.exec(text)) !== null) {
          last = m;
          if (m.index === re.lastIndex) re.lastIndex += 1;
        }
        return last;
      };
      const mv = lastMatch(/visits\/s\s*=\s*(-?[\d.]+)/gi);
      const mn = lastMatch(/nnEvals\/s\s*=\s*(-?[\d.]+)/gi);
      const mb = lastMatch(/avgBatchSize\s*=\s*(-?[\d.]+)/gi);
      const visitsPerSec = Number(mv?.[1] ?? NaN);
      if (result.code !== 0 || !Number.isFinite(visitsPerSec) || visitsPerSec <= 0) {
        return {
          ok: false,
          reason: `跑分失败（退出码 ${result.code}，未解析到 visits/s）`,
          output: text.slice(-1500),
        };
      }
      return {
        ok: true,
        target,
        label: t.label,
        backendId: t.backendId,
        threads: numThreads,
        tune,
        visits: visitsPerSec,
        nnEvals: Number(mn?.[1] ?? 0),
        batchSize: Number(mb?.[1] ?? 0),
        elapsedMs: Date.now() - t0,
        output: text.slice(-1500),
      };
    } catch (err) {
      return { ok: false, reason: err.message };
    } finally {
      benchRunning = false;
      // 跑完把引擎按用户原本的设置重新拉起来（跑分不改变任何设置）
      if (wasRunning) manager?.ensureEngine().catch(() => {});
    }
  });

  ipcMain.handle('shell:reveal', async (_e, target) => {
    const p = target === 'uninstaller' ? uninstallerPath() : target === 'engineRoot' ? ENGINE_ROOT : null;
    if (!p) return { ok: false, reason: '找不到该路径' };
    shell.showItemInFolder(p);
    return { ok: true, path: p };
  });

  ipcMain.handle('app:openUninstaller', async () => {
    const p = uninstallerPath();
    if (!p) {
      return {
        ok: false,
        reason:
          '当前目录里没有卸载程序。安装版（MSI）请到「设置 → 应用 → Komi」卸载；便携版根目录应有「卸载 Komi.exe」。',
      };
    }
    const err = await shell.openPath(p);
    return err ? { ok: false, reason: err } : { ok: true, path: p };
  });

  ipcMain.handle('setup:check', async () => {
    const hw = await detectHardware();
    const savedMirror = await readMirrorMode();
    const probe = await probeSources();
    const mirrorMode = savedMirror ?? probe.suggest;
    const installed = [];
    const candidates = [];
    for (const c of COMPONENTS) {
      const ok = await (await import('./components.js')).isInstalled(c, ENGINE_ROOT);
      if (ok) {
        installed.push(c.id);
        continue;
      }
      const ev = evaluateComponent(hw, c);
      candidates.push({
        id: c.id,
        label: c.label,
        detail: c.detail,
        bytes: c.bytes,
        required: c.required,
        applicable: ev.applicable,
        reason: ev.reason ?? null,
        recommended: Boolean(ev.recommended) || c.required,
      });
    }
    return {
      engineRoot: ENGINE_ROOT,
      bundled: ENGINE_ROOT === BUNDLED_ENGINE,
      hardware: { ...hw, summary: summarize(hw) },
      installed,
      candidates,
      requiredBytes: totalBytes(candidates.filter((c) => c.required)),
      recommendedBytes: totalBytes(candidates.filter((c) => c.recommended && c.applicable)),
      mirror: {
        mode: mirrorMode,
        saved: Boolean(savedMirror),
        suggest: probe.suggest,
        githubOk: probe.githubOk,
        pypiOk: probe.pypiOk,
        ms: probe.ms,
      },
    };
  });

  ipcMain.handle('setup:install', async (_e, ids, opts = {}) => {
    const mirror = opts?.mirror === 'china' ? 'china' : 'direct';
    await writeMirrorMode(mirror);
    manager._note(`下载源：${mirror === 'china' ? '国内镜像' : '直连官方'}`);
    const list = Array.isArray(ids) && ids.length ? ids : (await missingComponents(ENGINE_ROOT)).filter((c) => c.required).map((c) => c.id);
    const comps = list.map((id) => componentById(id)).filter(Boolean);
    let index = 0;
    for (const comp of comps) {
      index++;
      send('setup:progress', { id: comp.id, label: comp.label, index, count: comps.length, phase: 'start', received: 0, total: comp.bytes });
      await installSelected(
        [comp.id],
        ENGINE_ROOT,
        (p) => send('setup:progress', { ...p, label: comp.label, index, count: comps.length }),
        { mirror },
      );
      manager._note(`组件安装完成：${comp.label}`);
    }
    await cleanDownloadCache(ENGINE_ROOT);
    manager.refreshBackends();

    // 环境校验：逐个后端跑一次 exe version，确认组件真的能用
    const checks = [];
    for (const b of manager.backends) {
      const label = await probeBackendLabelSafe(b.exe);
      checks.push({ id: b.id, label: b.label, ok: Boolean(label), detail: label ?? '无法启动' });
    }
    send('setup:done', { ok: true, engineRoot: ENGINE_ROOT, backends: checks.map((c) => c.label), checks });
    return { ok: true, checks };
  });

  ipcMain.handle('download:get', async () => ({
    mode: (await readMirrorMode()) ?? 'auto',
    suggested: (await probeSources().catch(() => ({ suggest: 'direct' }))).suggest,
  }));

  ipcMain.handle('download:set', async (_e, mode) => {
    const normalized = mode === 'china' || mode === 'direct' ? mode : null;
    if (normalized) await writeMirrorMode(normalized);
    return { mode: normalized ?? 'auto' };
  });

  // ---------------------------------------------------------------- SGF / 复盘
  ipcMain.handle('sgf:open', async (_e, forcedPath) => {
    if (forcedPath) {
      const text = await fs.readFile(forcedPath, 'utf8');
      return { opened: true, path: forcedPath, game: parseSgf(text) };
    }
    const res = await dialog.showOpenDialog(win, {
      title: '打开棋谱',
      filters: [{ name: 'SGF 棋谱', extensions: ['sgf'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return { opened: false };
    const filePath = res.filePaths[0];
    const text = await fs.readFile(filePath, 'utf8');
    return { opened: true, path: filePath, game: parseSgf(text) };
  });

  ipcMain.handle('review:start', async (_e, opts) => {
    const t0 = Date.now();
    const { timeline, handicapStones, retries } = await manager.reviewGame({
      ...opts,
      onProgress: (p) => send('review:progress', p),
    });
    return { timeline, handicapStones, retries: retries ?? 0, elapsedMs: Date.now() - t0 };
  });

  // ---------------------------------------------------------------- AI 对 AI
  ipcMain.handle('spectate:start', async (_e, opts) => {
    if (spectateBusy) return { started: false, reason: '正在对局中' };
    spectateBusy = true;
    (async () => {
      try {
        spectate.reset();
        await spectate.configureSides({
          levelBlack: opts.levelBlack,
          levelWhite: opts.levelWhite,
          visitsBlack: opts.visitsBlack,
          visitsWhite: opts.visitsWhite,
        });
        const r = await spectate.playGame({
          size: opts.size,
          komi: opts.komi,
          handicap: opts.handicap ?? 0,
          paceMs: opts.paceMs ?? 350,
          maxMoves: opts.maxMoves ?? 400,
        });
        send('spectate:gameResult', r);
      } catch (err) {
        send('spectate:error', err.message);
      } finally {
        spectateBusy = false;
      }
    })();
    return { started: true };
  });

  ipcMain.handle('spectate:match', async (_e, opts) => {
    if (spectateBusy) return { started: false, reason: '正在对局中' };
    spectateBusy = true;
    (async () => {
      try {
        spectate.reset();
        await spectate.runMatch({
          games: opts.games ?? 6,
          size: opts.size ?? 9,
          komi: opts.komi ?? 7,
          handicap: opts.handicap ?? 0,
          levelA: opts.levelA,
          levelB: opts.levelB,
          visitsA: opts.visitsA,
          visitsB: opts.visitsB,
          pausingBetweenGames: opts.pacingMs ?? 200,
          onProgress: (p) => send('spectate:matchProgress', p),
        });
      } catch (err) {
        send('spectate:error', err.message);
      } finally {
        spectateBusy = false;
      }
    })();
    return { started: true };
  });

  ipcMain.handle('spectate:stop', async () => {
    spectate.stop();
    return { ok: true };
  });

  ipcMain.handle('spectate:pause', async (_e, paused) => {
    spectate.paused = Boolean(paused);
    return { paused: spectate.paused };
  });
  ipcMain.handle('dialog:error', async (_e, message) => {
    await dialog.showMessageBox(win, { type: 'error', message });
  });

  // 自愈：渲染进程用的规则脚本缺失或过期时自动重建，避免“白屏”
  if (!app.isPackaged) {
    try {
      const { buildRulesGlobal } = await import('../shared/buildRulesGlobal.js');
      const res = await buildRulesGlobal({ rootDir: APP_ROOT });
      if (res.rebuilt) console.log('[build] 已生成 renderer/rules.global.js');
    } catch (err) {
      console.error('[build] 生成规则脚本失败:', err.message);
    }
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  try {
    await manager?.shutdown();
    await spectate?.shutdown();
  } catch {
    /* ignore */
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  try {
    metrics?.stop();
    await manager?.shutdown();
    await spectate?.shutdown();
  } catch {
    /* ignore */
  }
});
