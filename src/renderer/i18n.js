/* Komi 界面多语言（中文 / English）
 * 用法：
 *   KomiI18n.setLang('en'); KomiI18n.apply(document);      // 静态文案
 *   KomiI18n.t('mode.play')                                 // 动态文案
 *   <span data-i18n="mode.play">人机对弈</span>              // 静态标记
 * 引擎日志、SGF、KataGo 自身输出保持原文（诊断信息，便于检索）。
 */
(function () {
  "use strict";

  const dict = {
    zh: {
      "app.sub": "内置 KataGo",
      "mode.play": "人机对弈",
      "mode.spectate": "AI 观战",
      "mode.review": "棋谱复盘",
      "mode.bench": "基准跑分",

      "bench.start": "开始跑分",
      "bench.stop": "停止",
      "bench.card": "基准跑分",
      "bench.target": "目标",
      "bench.gpu": "GPU（显卡）",
      "bench.cpu": "CPU（处理器）",
      "bench.size": "棋盘",
      "bench.level": "难度",
      "bench.games": "局数",
      "bench.rate": "当前手速度",
      "bench.avg": "平均速度",
      "bench.progress": "进度",
      "bench.idle": "基准跑分按极限压榨的满载参数跑完整对局（一盘算一局），棋盘会跟着引擎出招飞快变化",

      "set.level": "难度",
      "set.perf": "性能",
      "set.size": "棋盘",
      "set.komi": "贴目",
      "set.mirror": "下载源",
      "set.handicap": "让子",
      "set.settings": "设置",

      "size.9": "9 路",
      "size.13": "13 路",
      "size.19": "19 路",
      "perf.performance": "高吞吐",
      "perf.balanced": "省电",
      "mirror.auto": "自动",
      "mirror.direct": "官方直连",
      "mirror.china": "国内镜像",
      "handicap.none": "无",
      "handicap.n": "{n} 子",

      "btn.new": "新对局",
      "btn.undo": "悔棋",
      "btn.pass": "停一手",
      "btn.resign": "认输",
      "btn.score": "形势判断",
      "btn.saveSgf": "保存棋谱",
      "btn.spectateStart": "开始观战",
      "btn.spectatePause": "暂停",
      "btn.spectateResume": "继续",
      "btn.spectateStop": "停止",
      "btn.match": "测速对局",
      "btn.openSgf": "打开棋谱",
      "btn.reviewPrev": "◀ 上一手",
      "btn.reviewNext": "下一手 ▶",
      "btn.reviewBlunder": "下个恶手",
      "btn.change": "更改",
      "btn.close": "关闭",
      "btn.cancel": "取消",

      "chip.candidates": "候选点",
      "chip.policy": "落子概率",
      "chip.ownership": "形势图",
      "chip.numbers": "手数",

      "card.position": "局面",
      "pos.turn": "轮到",
      "pos.moves": "手数",
      "pos.captures": "提子 黑/白",
      "pos.winrate": "胜率",
      "pos.score": "目差",
      "card.metrics": "系统占用",
      "metrics.cpu": "CPU",
      "metrics.gpu": "GPU",
      "metrics.vram": "显存",
      "metrics.backend": "计算后端",
      "metrics.threads": "搜索线程",
      "metrics.engineDir": "组件目录",
      "card.spectate": "观战设置",
      "spec.black": "黑方",
      "spec.white": "白方",
      "spec.speed": "速度",
      "spec.maxMoves": "手数上限",
      "spec.visits": "每手访问",
      "spec.pace": "落子间隔",
      "spec.games": "测速局数",
      "spec.idle": "选择双方难度后点「开始观战」",
      "card.review": "复盘",
      "review.idle": "打开一个 SGF 棋谱开始复盘",
      "review.analyzing": "分析中…",
      "review.blunders": "恶手列表",
      "review.notYet": "尚未复盘",
      "card.candidates": "候选点",
      "candidatesTitle.play": "AI 候选点（白方胜率）",
      "candidatesTitle.spectate": "落子概率（黑 / 白）",
      "candidatesTitle.review": "当前局面最佳点",
      "candidates.waiting": "等待对局开始…",
      "card.chart": "胜率走势",
      "chartTitle.play": "胜率走势",
      "chartTitle.review": "全盘胜率走势（复盘）",
      "chart.note": "面积＝胜率占比",
      "card.log": "引擎日志",
      "thinking": "AI 思考中…",

      "setup.title": "首次使用 · 环境检测与组件安装",
      "setup.desc": "安装包只含程序本体。下面按你的显卡环境列出了需要的运行组件，勾选后下载，只需一次，之后完全离线。",
      "setup.mirror": "使用国内镜像加速下载（GitHub 代理 + 清华 PyPI 源）",
      "setup.dir": "组件将安装到",
      "setup.total": "已选组件合计",
      "setup.install": "下载并安装",
      "setup.preparing": "准备中…",
      "setup.doneHint": "下载完成后会自动进入游戏。",
      "setup.detecting": "正在检测硬件…",

      "result.title": "对局结束",
      "result.viewBoard": "查看棋盘",
      "result.again": "再来一局",

      "settings.title": "设置",
      "settings.compute": "计算",
      "settings.backendMode": "后台计算",
      "settings.backendMode.desc": "自动 = 有显卡就用显卡；仅 CPU = 不占用显卡（省电、发热低，慢很多）",
      "settings.backendMode.auto": "自动（推荐）",
      "settings.backendMode.gpu": "仅 GPU",
      "settings.backendMode.cpu": "仅 CPU",
      "settings.perfMode": "性能模式",
      "settings.perfMode.desc": "高吞吐 = 更多搜索线程与更大批次；省电 = 低发热",
      "settings.current": "当前",
      "settings.benchmark": "快速测速（每秒访问数）",
      "settings.benchmark.desc": "固定用最吃硬件的参数（线程拉满、批次放大、CUDA 双 NN server 线程），与当前性能模式和计算方式无关；测的是这台机器最多能跑多快",
      "settings.benchGpu": "测试 GPU",
      "settings.benchCpu": "测试 CPU",
      "settings.benchRunning": "测速中…",
      "settings.language": "语言",
      "settings.lang": "界面语言",
      "settings.lang.desc": "切换后立即生效；引擎日志与技术信息保持原文",
      "settings.deps": "依赖与组件",
      "settings.deps.desc": "安装包只含程序本体，引擎与神经网络按需下载。缺什么就勾什么。",
      "settings.deps.installed": "已安装",
      "settings.deps.missing": "未安装",
      "settings.deps.na": "不适用",
      "settings.deps.open": "打开组件下载",
      "settings.deps.refresh": "刷新状态",
      "settings.about": "关于与卸载",
      "settings.uninstall": "运行卸载程序",
      "settings.uninstall.none": "当前目录没有卸载程序（安装版请走系统「应用和功能」）",
      "settings.openFolder": "打开所在目录",
      "settings.version": "版本",
      "settings.engine": "引擎",
      "settings.root": "组件目录",

      "log.savedSgf": "棋谱已保存：{path}",
      "log.noSgf": "还没有棋谱可保存",
      "log.saveFailed": "保存棋谱失败: {msg}",
      "log.prevLabel": "黑",
      "st.turn.black": "黑（你）",
      "st.turn.white": "白（你）",
      "st.winrateFmt": "黑 {b}% ／ 白 {w}%",
      "st.movesFmt": "{n} 手",
    },

    en: {
      "app.sub": "Built-in KataGo",
      "mode.play": "Play",
      "mode.spectate": "AI vs AI",
      "mode.review": "Review",
      "mode.bench": "Benchmark",

      "bench.start": "Start benchmark",
      "bench.stop": "Stop",
      "bench.card": "Benchmark",
      "bench.target": "Target",
      "bench.gpu": "GPU",
      "bench.cpu": "CPU",
      "bench.size": "Board",
      "bench.level": "Level",
      "bench.games": "Games",
      "bench.rate": "This move",
      "bench.avg": "Average",
      "bench.progress": "Progress",
      "bench.idle": "Plays full games at maximum load (one finished game = one round); the board updates as fast as the engine plays",

      "set.level": "Level",
      "set.perf": "Perf",
      "set.size": "Board",
      "set.komi": "Komi",
      "set.mirror": "Source",
      "set.handicap": "Handicap",
      "set.settings": "Settings",

      "size.9": "9×9",
      "size.13": "13×13",
      "size.19": "19×19",
      "perf.performance": "Turbo",
      "perf.balanced": "Eco",
      "mirror.auto": "Auto",
      "mirror.direct": "Direct",
      "mirror.china": "China mirror",
      "handicap.none": "None",
      "handicap.n": "{n} stones",

      "btn.new": "New game",
      "btn.undo": "Undo",
      "btn.pass": "Pass",
      "btn.resign": "Resign",
      "btn.score": "Score",
      "btn.saveSgf": "Save SGF",
      "btn.spectateStart": "Start",
      "btn.spectatePause": "Pause",
      "btn.spectateResume": "Resume",
      "btn.spectateStop": "Stop",
      "btn.match": "Elo match",
      "btn.openSgf": "Open SGF",
      "btn.reviewPrev": "◀ Prev",
      "btn.reviewNext": "Next ▶",
      "btn.reviewBlunder": "Next blunder",
      "btn.change": "Change",
      "btn.close": "Close",
      "btn.cancel": "Cancel",

      "chip.candidates": "Candidates",
      "chip.policy": "Move policy",
      "chip.ownership": "Territory",
      "chip.numbers": "Move numbers",

      "card.position": "Position",
      "pos.turn": "To play",
      "pos.moves": "Moves",
      "pos.captures": "Captures B/W",
      "pos.winrate": "Winrate",
      "pos.score": "Score lead",
      "card.metrics": "System usage",
      "metrics.cpu": "CPU",
      "metrics.gpu": "GPU",
      "metrics.vram": "VRAM",
      "metrics.backend": "Backend",
      "metrics.threads": "Threads",
      "metrics.engineDir": "Engine dir",
      "card.spectate": "Spectate settings",
      "spec.black": "Black",
      "spec.white": "White",
      "spec.speed": "Speed",
      "spec.maxMoves": "Max moves",
      "spec.visits": "Visits/move",
      "spec.pace": "Move delay",
      "spec.games": "Games",
      "spec.idle": "Pick both sides, then press Start",
      "card.review": "Review",
      "review.idle": "Open an SGF file to start reviewing",
      "review.analyzing": "Analyzing…",
      "review.blunders": "Blunders",
      "review.notYet": "Not reviewed yet",
      "card.candidates": "Candidates",
      "candidatesTitle.play": "AI candidates (White winrate)",
      "candidatesTitle.spectate": "Move policy (Black / White)",
      "candidatesTitle.review": "Best moves here",
      "candidates.waiting": "Waiting for the game to start…",
      "card.chart": "Winrate chart",
      "chartTitle.play": "Winrate chart",
      "chartTitle.review": "Winrate chart (review)",
      "chart.note": "Area = winrate share",
      "card.log": "Engine log",
      "thinking": "AI is thinking…",

      "setup.title": "First run · Hardware check & components",
      "setup.desc": "The installer contains only the app. Components needed for your GPU are listed below — tick and download once, then everything works offline.",
      "setup.mirror": "Use China mirrors (GitHub proxy + Tsinghua PyPI)",
      "setup.dir": "Components will be installed to",
      "setup.total": "Selected total",
      "setup.install": "Download & install",
      "setup.preparing": "Preparing…",
      "setup.doneHint": "The game will start when the download finishes.",
      "setup.detecting": "Detecting hardware…",

      "result.title": "Game over",
      "result.viewBoard": "View board",
      "result.again": "Play again",

      "settings.title": "Settings",
      "settings.compute": "Compute",
      "settings.backendMode": "Background compute",
      "settings.backendMode.desc": "Auto uses the GPU when available; CPU-only avoids the GPU entirely (cooler, much slower)",
      "settings.backendMode.auto": "Auto (recommended)",
      "settings.backendMode.gpu": "GPU only",
      "settings.backendMode.cpu": "CPU only",
      "settings.perfMode": "Performance mode",
      "settings.perfMode.desc": "Turbo = more search threads and larger batches; Eco = lower heat",
      "settings.current": "Current",
      "settings.benchmark": "Quick benchmark (visits/s)",
      "settings.benchmark.desc": "Always uses the most GPU-hungry settings (max threads, large batches, 2 NN server threads on CUDA), regardless of the current perf mode or compute mode",
      "settings.benchGpu": "Test GPU",
      "settings.benchCpu": "Test CPU",
      "settings.benchRunning": "Benchmarking…",
      "settings.language": "Language",
      "settings.lang": "Interface language",
      "settings.lang.desc": "Applies immediately; engine logs and technical output stay as-is",
      "settings.deps": "Dependencies & components",
      "settings.deps.desc": "The installer ships only the app; engine and networks are downloaded on demand.",
      "settings.deps.installed": "Installed",
      "settings.deps.missing": "Missing",
      "settings.deps.na": "N/A",
      "settings.deps.open": "Open component downloader",
      "settings.deps.refresh": "Refresh",
      "settings.about": "About & uninstall",
      "settings.uninstall": "Run uninstaller",
      "settings.uninstall.none": "No uninstaller next to the app (MSI installs: use Windows Apps & features)",
      "settings.openFolder": "Open folder",
      "settings.version": "Version",
      "settings.engine": "Engine",
      "settings.root": "Component dir",

      "log.savedSgf": "SGF saved: {path}",
      "log.noSgf": "Nothing to save yet",
      "log.saveFailed": "Failed to save SGF: {msg}",
      "log.prevLabel": "B",
      "st.turn.black": "Black (you)",
      "st.turn.white": "White (you)",
      "st.winrateFmt": "Black {b}% / White {w}%",
      "st.movesFmt": "{n} moves",
    },
  };

  let current = "zh";

  function t(key, vars) {
    const table = dict[current] || dict.zh;
    let s = table[key];
    if (s === undefined) s = dict.zh[key];
    if (s === undefined) return key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
    return s;
  }

  function setLang(lang) {
    current = lang === "en" ? "en" : "zh";
    return current;
  }

  function getLang() {
    return current;
  }

  /** 把所有带 data-i18n 的静态文案替换掉 */
  function apply(root) {
    const scope = root || document;
    for (const el of scope.querySelectorAll("[data-i18n]")) {
      el.textContent = t(el.getAttribute("data-i18n"));
    }
    for (const el of scope.querySelectorAll("[data-i18n-title]")) {
      el.title = t(el.getAttribute("data-i18n-title"));
    }
    for (const el of scope.querySelectorAll("[data-i18n-placeholder]")) {
      el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
    }
    document.documentElement.setAttribute("lang", current === "en" ? "en" : "zh-CN");
  }

  window.KomiI18n = { t, setLang, getLang, apply, dict };
})();
