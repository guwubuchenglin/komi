// 预加载脚本（CommonJS）：只暴露受控 API
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('go', {
  // 基础
  appInfo: () => ipcRenderer.invoke('app:info'),
  levels: () => ipcRenderer.invoke('levels:list'),
  status: () => ipcRenderer.invoke('engine:status'),
  shutdown: () => ipcRenderer.invoke('engine:shutdown'),

  // 人机对弈
  newGame: (opts) => ipcRenderer.invoke('game:new', opts),
  setLevel: (levelId) => ipcRenderer.invoke('game:setLevel', levelId),
  play: (color, coord) => ipcRenderer.invoke('game:play', { color, coord }),
  genmove: (color) => ipcRenderer.invoke('game:genmove', color),
  undo: (times) => ipcRenderer.invoke('game:undo', times),
  score: () => ipcRenderer.invoke('game:score'),
  saveSgf: (sgf, suggestedName, forcedPath) => ipcRenderer.invoke('game:saveSgf', { sgf, suggestedName, forcedPath }),

  // 组件目录
  pathsInfo: () => ipcRenderer.invoke('paths:info'),
  choosePath: () => ipcRenderer.invoke('paths:choose'),
  onPathsChanged: on('paths:changed'),

  // 下载源
  downloadConfig: () => ipcRenderer.invoke('download:get'),
  setDownloadSource: (mode) => ipcRenderer.invoke('download:set', mode),

  // 偏好设置（性能模式 / 计算方式 / 语言）
  settings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 组件与依赖
  componentsList: () => ipcRenderer.invoke('components:list'),

  // 跑分（CPU / GPU）
  benchmarkTargets: () => ipcRenderer.invoke('benchmark:targets'),
  benchmarkRun: (opts) => ipcRenderer.invoke('benchmark:run', opts),
  onBenchmarkProgress: on('benchmark:progress'),

  // 跑分（棋盘可视化：真下棋，速度即成绩）
  benchStart: (opts) => ipcRenderer.invoke('bench:start', opts),
  benchStop: () => ipcRenderer.invoke('bench:stop'),
  benchStatus: () => ipcRenderer.invoke('bench:status'),
  onBenchStarted: on('bench:started'),
  onBenchMove: on('bench:move'),
  onBenchDone: on('bench:done'),
  onBenchError: on('bench:error'),
  onBenchLog: on('bench:log'),

  // 卸载与路径
  openUninstaller: () => ipcRenderer.invoke('app:openUninstaller'),
  revealInFolder: (target) => ipcRenderer.invoke('shell:reveal', target),

  // 首次安装向导
  setupCheck: () => ipcRenderer.invoke('setup:check'),
  setupInstall: (ids, opts) => ipcRenderer.invoke('setup:install', ids, opts),
  onSetupProgress: on('setup:progress'),
  onSetupDone: on('setup:done'),

  // 棋谱与复盘
  openSgf: (filePath) => ipcRenderer.invoke('sgf:open', filePath),
  reviewStart: (opts) => ipcRenderer.invoke('review:start', opts),
  onReviewProgress: on('review:progress'),

  // AI 对 AI
  spectateStart: (opts) => ipcRenderer.invoke('spectate:start', opts),
  spectateMatch: (opts) => ipcRenderer.invoke('spectate:match', opts),
  spectateStop: () => ipcRenderer.invoke('spectate:stop'),
  spectatePause: (paused) => ipcRenderer.invoke('spectate:pause', paused),
  onSpectateLog: on('spectate:log'),
  onSpectateGameStart: on('spectate:gameStart'),
  onSpectateMove: on('spectate:move'),
  onSpectateGameResult: on('spectate:gameResult'),
  onSpectateMatchProgress: on('spectate:matchProgress'),
  onSpectateMatchEnd: on('spectate:matchEnd'),
  onSpectateError: on('spectate:error'),

  // 系统占用
  onMetrics: on('system:metrics'),

  // 引擎日志
  onLog: on('engine:log'),
  onCrash: on('engine:crashed'),
});
