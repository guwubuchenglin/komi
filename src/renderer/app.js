/* 围棋 · 内置 KataGo —— 渲染进程主逻辑（经典脚本，依赖 rules.global.js） */
(function () {
  "use strict";

  const R = window.GoRules;
  const api = window.go;

  const el = (id) => document.getElementById(id);

  // 各尺寸的平衡贴目（实测：KataGo 4000 访问下黑棋胜率接近 50% 的取值）
  const KOMI_BY_SIZE = { 9: 7, 13: 7, 19: 7.5 };

  const S = {
    mode: "play", // play | spectate | review
    spectate: { running: false, paused: false },
    stopRequested: false,
    policies: { B: null, W: null },
    policyShown: null,
    showPolicy: true,
    review: null,
    levels: [],
    levelId: "lv4",
    size: 19,
    komi: 7.5,
    humanColor: R.BLACK,
    game: null,
    ended: false,
    busy: false,
    lastAiMove: null,
    candidates: [],
    ownership: null,
    winrateHist: [],
    showCandidates: true,
    showOwnership: false,
    showNumbers: false,
    hover: null,
    canvas: null,
    ctx: null,
    cell: 0,
    origin: 0,
    dpr: 1,
  };

  // ------------------------------------------------------------------ 工具
  const colorName = (c) => (c === R.BLACK ? "黑" : "白");
  const gtpColor = (c) => (c === R.BLACK ? "B" : "W");
  const other = (c) => (c === R.BLACK ? R.WHITE : R.BLACK);

  function log(line) {
    const box = el("logBox");
    const div = document.createElement("div");
    div.textContent = line;
    box.appendChild(div);
    while (box.childElementCount > 200) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function setThinking(on, text) {
    el("thinking").classList.toggle("hidden", !on);
    if (text) el("thinkingText").textContent = text;
  }

  // ------------------------------------------------------------------ 初始化
  async function boot() {
    if (!api) {
      log("错误：未检测到 Electron 预加载 API（请用 npm start 启动）");
      return;
    }
    S.canvas = el("board");
    S.ctx = S.canvas.getContext("2d");
    setupCanvas();

    const levels = await api.levels();
    S.levels = levels;
    const sel = el("levelSelect");
    sel.innerHTML = "";
    for (const lv of levels) {
      const opt = document.createElement("option");
      opt.value = lv.id;
      opt.textContent = `${lv.label} · ${lv.rank}${lv.isHumanStyle ? " · 拟人" : ""}`;
      sel.appendChild(opt);
    }
    sel.value = S.levelId;
    el("levelSelect").addEventListener("change", onLevelChange);
    el("sizeSelect").addEventListener("change", () => {
      const size = Number(el("sizeSelect").value);
      if (KOMI_BY_SIZE[size]) el("komiInput").value = String(KOMI_BY_SIZE[size]);
      onNewGame();
    });
    el("komiInput").addEventListener("change", () => onNewGame());
    el("handicapSelect").addEventListener("change", () => {
      const h = Number(el("handicapSelect").value || 0);
      const size = Number(el("sizeSelect").value);
      el("komiInput").value = String(h > 0 ? 0.5 : (KOMI_BY_SIZE[size] ?? 7.5));
      onNewGame();
    });

    el("btnNew").addEventListener("click", () => onNewGame());
    el("btnUndo").addEventListener("click", onUndo);
    el("btnPass").addEventListener("click", onPass);
    el("btnResign").addEventListener("click", onResign);
    el("btnScore").addEventListener("click", onScoreNow);
    el("btnSaveSgf").addEventListener("click", () => onSaveSgf());
    el("chkCandidates").addEventListener("change", (e) => {
      S.showCandidates = e.target.checked;
      draw();
    });
    el("chkOwnership").addEventListener("change", (e) => {
      S.showOwnership = e.target.checked;
      draw();
    });
    el("chkNumbers").addEventListener("change", (e) => {
      S.showNumbers = e.target.checked;
      draw();
    });
    el("chkPolicy").addEventListener("change", (e) => {
      S.showPolicy = e.target.checked;
      draw();
    });
    el("btnResultClose").addEventListener("click", () => el("resultModal").classList.add("hidden"));
    el("btnResultNew").addEventListener("click", () => {
      el("resultModal").classList.add("hidden");
      if (S.mode === "play") onNewGame();
    });

    // 模式切换
    el("modeNav").addEventListener("click", (e) => {
      const btn = e.target.closest(".mode-btn");
      if (btn) setMode(btn.dataset.mode);
    });

    // AI 观战的双方难度下拉
    for (const id of ["specBlack", "specWhite"]) {
      const sel = el(id);
      sel.innerHTML = "";
      for (const lv of levels) {
        const opt = document.createElement("option");
        opt.value = lv.id;
        opt.textContent = `${lv.label} · ${lv.rank}`;
        sel.appendChild(opt);
      }
    }
    el("specBlack").value = "lv3";
    el("specWhite").value = "lv5";

    // 观战速度：选预设会自动填好「每手访问 / 落子间隔」，手动改动则转为「自定义」
    el("specSpeed").addEventListener("change", () => applySpectateSpeed(el("specSpeed").value));
    for (const id of ["specVisits", "specPace"]) {
      el(id).addEventListener("input", () => {
        el("specSpeed").value = "custom";
        renderSpectateSpeedHint();
      });
    }
    applySpectateSpeed("normal", { silent: true });

    el("btnSpectateStart").addEventListener("click", onSpectateStart);
    el("btnSpectatePause").addEventListener("click", toggleSpectatePause);
    el("btnSpectateStop").addEventListener("click", stopSpectate);
    el("btnMatch").addEventListener("click", onMatchStart);

    // 复盘
    el("btnOpenSgf").addEventListener("click", () => onOpenSgf());
    window.__openSgf = onOpenSgf; // 测试钩子
    window.__saveSgf = onSaveSgf;
    window.__state = () => ({
      mode: S.mode,
      size: S.size,
      komi: S.komi,
      blacks: S.game ? [...S.game.board].filter((v) => v === 1).length : 0,
      whites: S.game ? [...S.game.board].filter((v) => v === 2).length : 0,
      stones: S.game ? [...S.game.board].filter((v) => v !== 0).length : 0,
      moveNumber: S.game?.moveNumber ?? 0,
      turn: S.game?.turn ?? null,
      reviewIndex: S.review?.index ?? null,
      reviewTimeline: S.review?.timeline?.length ?? null,
      reviewBlunders: S.review?.blunders?.length ?? null,
      spectateRunning: S.spectate.running,
      policyB: S.policies.B ? S.policies.B.candidates.length : 0,
      policyW: S.policies.W ? S.policies.W.candidates.length : 0,
    });
    el("btnReviewPrev").addEventListener("click", () => gotoReview((S.review?.index ?? 0) - 1));
    el("btnReviewNext").addEventListener("click", () => gotoReview((S.review?.index ?? 0) + 1));
    el("btnReviewBlunder").addEventListener("click", () => {
      const bs = S.review?.blunders ?? [];
      if (!bs.length) return;
      const cur = S.review.index;
      const next = bs.find((b) => b.ply > cur) ?? bs[0];
      gotoReview(next.ply);
    });

    S.canvas.addEventListener("click", onBoardClick);
    S.canvas.addEventListener("mousemove", (e) => {
      S.hover = pointFromEvent(e);
      draw();
    });
    S.canvas.addEventListener("mouseleave", () => {
      S.hover = null;
      draw();
    });

    window.addEventListener("resize", () => {
      setupCanvas();
      draw();
    });

    api.onLog((line) => log(line));
    api.onCrash(() => log("⚠ 引擎意外退出，下一次落子时会自动重启"));

    // 观战事件
    api.onSpectateLog((line) => log(line));
    api.onSpectateGameStart((g) => {
      S.handicapStones = (g.stones ?? []).map((gtp) => R.gtpToIdx(gtp, S.size)).filter((i) => i >= 0)
        .map((i) => ({ x: R.xOf(i, S.size), y: R.yOf(i, S.size) }));
      if (S.handicapStones.length) log(`观战开局让 ${S.handicapStones.length} 子`);
    });
    api.onSpectateMove((ev) => onSpectateMoveEvent(ev));
    api.onSpectateGameResult((r) => {
      S.spectate.running = false;
      setThinking(false);
      updateButtons();
      if (r.result === 'aborted') {
        el("specStatus").textContent = "已停止";
        return;
      }
      const who = r.winner === "B" ? "黑棋" : r.winner === "W" ? "白棋" : "无胜负";
      const detail =
        r.result === "score"
          ? `终局判定：${r.score ?? "—"}`
          : r.result === "resign"
            ? "对方认输"
            : r.result === "aborted"
              ? "已中止"
              : `结果：${r.result}`;
      el("specStatus").textContent = `对局结束：${who}胜（${detail}）`;
      modal(`观战结束 · ${who}胜`, `${detail}\n共 ${r.moves?.length ?? 0} 手`);
      log(`观战结束：${who}胜 / ${detail}`);
    });
    api.onSpectateMatchProgress((p) => {
      el("specStatus").textContent = `测速 ${p.done}/${p.total} 局　A 胜 ${p.winsA} · B 胜 ${p.winsB} · 和 ${p.draws}`;
    });
    api.onSpectateMatchEnd((s) => {
      S.spectate.running = false;
      setThinking(false);
      updateButtons();
      const elo = s.eloAminusB >= 0 ? `+${s.eloAminusB}` : String(s.eloAminusB);
      el("specStatus").textContent = `测速完成：A 胜 ${s.winsA} / B 胜 ${s.winsB} / 和 ${s.draws}，ELO 差 ${elo}`;
      modal(
        "测速结果",
        `A 胜 ${s.winsA} 局，B 胜 ${s.winsB} 局，和棋 ${s.draws} 局\n` +
          `A 的胜率 ${(s.winRateA * 100).toFixed(1)}%\n` +
          `估算 ELO 差：A - B = ${elo}`,
      );
      log(`测速完成：A ${s.winsA} : B ${s.winsB}（ELO ${elo}）`);
    });
    api.onSpectateError((msg) => {
      S.spectate.running = false;
      setThinking(false);
      log("观战错误：" + msg);
      el("specStatus").textContent = "出错：" + msg;
    });
    api.onReviewProgress((p) => {
      const pct = Math.round((p.done / p.total) * 100);
      el("reviewProgressBar").style.width = pct + "%";
      el("reviewProgressText").textContent = `${p.done} / ${p.total} 手（${pct}%）`;
    });
    if (api.onMetrics) api.onMetrics((m) => renderMetrics(m));

    document.addEventListener("keydown", (e) => {
      if (S.mode === "review") {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          gotoReview((S.review?.index ?? 0) - 1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          gotoReview((S.review?.index ?? 0) + 1);
        }
        return;
      }
      if (e.key === "z" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onUndo();
      }
      if (e.key.toLowerCase() === "p" && !e.ctrlKey) onPass();
    });

    el("komiInput").value = String(KOMI_BY_SIZE[Number(el("sizeSelect").value)] ?? 7.5);

    // 下载源
    try {
      const dl = await api.downloadConfig();
      const sel = el("mirrorSelect");
      sel.value = dl.mode === "china" || dl.mode === "direct" ? dl.mode : "auto";
      sel.title = "建议：" + (dl.suggested === "china" ? "国内镜像" : "官方直连");
      sel.addEventListener("change", async () => {
        const mode = sel.value === "auto" ? dl.suggested : sel.value;
        await api.setDownloadSource(mode);
        log("下载源已设为：" + (mode === "china" ? "国内镜像" : "官方直连"));
      });
    } catch {
      /* ignore */
    }

    await refreshPathsInfo();
    el("btnChooseDir").addEventListener("click", onChooseDir);

    // 性能模式（高吞吐 / 省电）
    let refreshPerfInfo = async () => {};
    try {
      const st = await api.settings();
      const perfSel = el("perfSelect");
      let previous = st.perfMode === "balanced" ? "balanced" : "performance";
      perfSel.value = previous;
      renderPerfInfo(st);
      perfSel.addEventListener("change", async () => {
        previous = await onPerfChange(perfSel, previous);
      });
      // 引擎起来之后后端才知道（CUDA 的 batch 更大），届时刷新一次显示
      refreshPerfInfo = async () => {
        try {
          renderPerfInfo(await api.settings());
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* 旧版主进程没有 settings 接口时忽略 */
    }

    const started = await ensureComponentsThenStart();
    if (!started) return;
    await refreshPerfInfo();
  }

  function setupCanvas() {
    const wrap = S.canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    const side = Math.max(320, Math.floor(Math.min(rect.width, rect.height) - 24));
    const dpr = window.devicePixelRatio || 1;
    S.dpr = dpr;
    S.canvas.width = side * dpr;
    S.canvas.height = side * dpr;
    S.canvas.style.width = side + "px";
    S.canvas.style.height = side + "px";
    S.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S.boardSide = side;
    S.margin = Math.round(side * 0.055);
    S.cell = (side - S.margin * 2) / (S.size - 1);
    S.origin = S.margin;
  }

  // ------------------------------------------------------------------ 对局流程
  let newGameSeq = 0;
  async function onNewGame() {
    if (S.mode !== "play") return;
    const seq = ++newGameSeq;
    if (S.newGameBusy) {
      // 已有一次新局在跑，等它结束后再跑最新的一次
      S.pendingNewGame = true;
      return;
    }
    S.newGameBusy = true;
    const size = Number(el("sizeSelect").value);
    const komi = Number(el("komiInput").value);
    const handicap = Number(el("handicapSelect").value || 0);
    S.size = size;
    S.komi = Number.isFinite(komi) ? komi : 7.5;
    S.game = R.createState(S.size, { komi: S.komi });
    S.ended = false;
    S.busy = false;
    S.candidates = [];
    S.ownership = null;
    S.winrateHist = [];
    S.lastAiMove = null;
    S.handicapStones = [];
    const hb = el("hintBlack");
    const hw = el("hintWhite");
    if (hb) hb.textContent = "黑 0.0%";
    if (hw) hw.textContent = "白 0.0%";
    setThinking(true, "引擎启动中…");
    const slowTimer = setTimeout(() => {
      if (S.newGameBusy) setThinking(true, "初始化引擎中…（首次使用 OpenCL / DirectML 后端可能需要 1~3 分钟）");
    }, 8000);
    try {
      const res = await api.newGame({ size: S.size, komi: S.komi, levelId: S.levelId, handicap });
      const stones = res.handicapStones ?? [];
      if (stones.length) {
        const pts = stones
          .map((g) => R.gtpToIdx(g, S.size))
          .filter((i) => i >= 0)
          .map((i) => ({ x: R.xOf(i, S.size), y: R.yOf(i, S.size) }));
        S.handicapStones = pts;
        S.game = R.placeStones(S.game, R.BLACK, pts);
        S.game = { ...S.game, turn: R.WHITE };
        log(`让 ${stones.length} 子：${stones.join(" ")}（白棋先行）`);
      }
      setupCanvas();
      draw();
      renderStats();
      log(
        `新对局：${size} 路，贴目 ${S.komi}，难度 ${currentLevel().label}${stones.length ? `，让 ${stones.length} 子` : ""}`,
      );
    } catch (err) {
      log("新局失败: " + err.message);
      modal("引擎启动失败", String(err.message));
    } finally {
      clearTimeout(slowTimer);
      setThinking(false);
    }
    S.busy = false;
    updateButtons();
    S.newGameBusy = false;
    if (S.pendingNewGame) {
      S.pendingNewGame = false;
      return onNewGame();
    }
    // 让子棋由白棋（AI）先行
    if (S.game && S.game.turn === R.WHITE) {
      log("让子局：白棋（AI）先行");
      await aiTurn();
    }
  }

  function currentLevel() {
    return S.levels.find((l) => l.id === S.levelId) ?? { label: S.levelId, rank: "" };
  }

  async function onLevelChange(e) {
    S.levelId = e.target.value;
    try {
      setThinking(true, "切换难度…");
      const res = await api.setLevel(S.levelId);
      log(`难度 → ${currentLevel().label}${res.restarted ? "（引擎已重启）" : ""}`);
    } catch (err) {
      log("切换难度失败: " + err.message);
    } finally {
      setThinking(false);
    }
    // 换难度后让 AI 走一手，保证新档位立即生效于当前局面
  }

  async function onBoardClick(ev) {
    if (S.mode !== "play") return;
    if (!S.game || S.ended || S.busy) return;
    if (S.game.turn !== S.humanColor) return;
    const p = pointFromEvent(ev);
    if (!p) return;

    const result = R.playMove(S.game, p.x, p.y);
    if (!result.ok) {
      log(`不能落子：${result.reason}`);
      return;
    }
    S.game = result.state;
    S.lastAiMove = null;
    S.candidates = [];
    draw();
    renderStats();

    try {
      await api.play(gtpColor(p.color ?? S.humanColor), R.idxToGtp(R.idxOf(p.x, p.y, S.size), S.size));
    } catch (err) {
      log("同步引擎失败: " + err.message);
    }

    await checkEnd();
    if (!S.ended) await aiTurn();
  }

  async function aiTurn() {
    if (!S.game || S.ended) return;
    const color = S.game.turn;
    if (color === S.humanColor) return;

    S.busy = true;
    updateButtons();
    setThinking(true, `${currentLevel().label} AI 思考中…`);
    try {
      const res = await api.genmove(gtpColor(color));
      if (!res.move) throw new Error("引擎未返回着法");

      const coord = String(res.move).trim();
      if (/^(pass|resign)$/i.test(coord)) {
        if (/resign/i.test(coord)) {
          finish(`AI 认输，你赢了`);
          return;
        }
        const r = R.playPass(S.game);
        S.game = r.state;
        log(`${colorName(color)} 停一手`);
      } else {
        const idx = R.gtpToIdx(coord, S.size);
        if (idx < 0) throw new Error(`无法解析着法 ${coord}`);
        const r = R.playMove(S.game, R.xOf(idx, S.size), R.yOf(idx, S.size));
        if (!r.ok) throw new Error(`引擎着法非法 ${coord}: ${r.reason}`);
        S.game = r.state;
        S.lastAiMove = { idx, color };
      }

      S.candidates = res.candidates ?? [];
      S.ownership = res.ownership ?? null;
      const blackWin = toBlackWinrate(color, res.winrate);
      if (blackWin != null) S.winrateHist.push({ move: S.game.moveNumber, blackWin });

      log(
        `AI(${colorName(color)}) ${coord} · ${res.elapsedMs}ms · 胜率${pct(res.winrate)} · 目差${fmtLead(res.scoreLead)}`,
      );

      draw();
      renderStats();
      renderCandidates();
      await checkEnd();
    } catch (err) {
      log("AI 落子失败: " + err.message);
    } finally {
      S.busy = false;
      setThinking(false);
      updateButtons();
    }
  }

  async function onPass() {
    if (!S.game || S.ended || S.busy) return;
    if (S.game.turn !== S.humanColor) return;
    try {
      await api.play(gtpColor(S.humanColor), "pass");
    } catch (err) {
      log("同步引擎失败: " + err.message);
    }
    S.game = R.playPass(S.game).state;
    log(`${colorName(S.humanColor)} 停一手`);
    draw();
    renderStats();
    await checkEnd();
    if (!S.ended) await aiTurn();
  }

  async function onResign() {
    if (!S.game || S.ended) return;
    finish("你认输了");
  }

  async function onUndo() {
    if (!S.game || S.busy) return;
    const history = S.game.history;
    if (!history.length) return;
    // 退回到自己上一手之前：如果最后一手是 AI，退 2 手；否则退 1 手
    let plies = 1;
    const last = history[history.length - 1];
    if (last.color !== S.humanColor && history.length >= 2) plies = 2;

    try {
      await api.undo(plies);
    } catch (err) {
      log("引擎悔棋失败: " + err.message);
    }
    S.game = R.undo(S.game, plies);
    S.ended = false;
    S.candidates = [];
    S.ownership = null;
    S.lastAiMove = null;
    S.winrateHist = S.winrateHist.slice(0, Math.max(0, S.winrateHist.length - 1));
    log(`悔棋 ${plies} 手`);
    draw();
    renderStats();
    renderCandidates();
    updateButtons();
  }

  async function checkEnd() {
    if (S.game.passCount >= 2) {
      setThinking(true, "数子中…");
      try {
        const res = await api.score();
        finishScore(res);
      } catch (err) {
        modal("对局结束", "双方连续停一手，对局结束（引擎数子失败：" + err.message + "）");
      } finally {
        setThinking(false);
      }
      return true;
    }
    return false;
  }

  function finishScore(res) {
    S.ended = true;
    const score = String(res?.score ?? "").trim();
    const winner = score.startsWith("B") ? "黑" : score.startsWith("W") ? "白" : "";
    const humanWon = winner === "黑" ? S.humanColor === R.BLACK : winner === "白" ? S.humanColor === R.WHITE : false;
    const title = winner ? `${winner}棋胜` : "对局结束";
    const detail = `引擎判定：${score || "无结果"}\n${humanWon ? "你赢了 🎉" : "你输了"}${
      res?.dead?.length ? `\n死子：${res.dead.join(" ")}` : ""
    }`;
    finish(title, detail);
  }

  function finish(title, detail) {
    S.ended = true;
    updateButtons();
    modal(title, detail);
    log(`对局结束：${title}`);
  }

  function modal(title, detail) {
    el("resultTitle").textContent = title;
    el("resultDetail").textContent = detail ?? "";
    el("resultModal").classList.remove("hidden");
  }

  // ------------------------------------------------------------------ 数据展示
  function toBlackWinrate(color, winrate) {
    if (winrate == null) return null;
    return color === R.BLACK ? winrate : 1 - winrate;
  }

  const pct = (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
  const fmtLead = (v) => (v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(1));

  function renderStats() {
    if (!S.game) return;
    const isReview = S.mode === "review" && S.review?.timeline;
    if (isReview) {
      el("turnText").textContent = `第 ${S.review.index} 手`;
    } else if (S.mode === "spectate") {
      el("turnText").textContent = `${colorName(S.game.turn)}（AI）`;
    } else {
      el("turnText").textContent = colorName(S.game.turn) + (S.game.turn === S.humanColor ? "（你）" : "（AI）");
    }
    el("moveCount").textContent = S.game.moveNumber;
    el("captureText").textContent = `${S.game.captures[R.BLACK]} / ${S.game.captures[R.WHITE]}`;

    let blackWin = null;
    let lead = null;
    if (isReview) {
      const t = S.review.timeline[S.review.index];
      blackWin = t?.blackWin ?? null;
      lead = t?.scoreLeadBlack ?? null;
    } else {
      const lastHist = S.winrateHist[S.winrateHist.length - 1];
      blackWin = lastHist?.blackWin ?? null;
      lead = S.candidates[0]?.scoreLead ?? null;
    }

    if (blackWin != null) {
      const bw = Math.min(1, Math.max(0, blackWin));
      el("winrateText").innerHTML =
        `<span class="wr-black">黑 ${(bw * 100).toFixed(1)}%</span>` +
        `<span class="wr-sep">/</span>` +
        `<span class="wr-white">白 ${((1 - bw) * 100).toFixed(1)}%</span>`;
      const hb = el("hintBlack");
      const hw = el("hintWhite");
      if (hb) hb.textContent = `黑 ${(bw * 100).toFixed(1)}%`;
      if (hw) hw.textContent = `白 ${((1 - bw) * 100).toFixed(1)}%`;
    } else {
      el("winrateText").textContent = "—";
    }

    el("scoreLeadText").textContent = fmtLead(lead);
    drawWinrateChart();
  }

  function candidateRow(c, maxWeight, { showPrior = false } = {}) {
    const li = document.createElement("li");
    const weight = (showPrior ? c.prior : c.visits) || 0;
    const width = Math.round((weight / (maxWeight || 1)) * 100);
    const tail = showPrior
      ? `${((c.prior ?? 0) * 100).toFixed(1)}% · ${pct(c.winrate)}`
      : `${pct(c.winrate)} · ${c.visits}v`;
    li.innerHTML =
      `<span class="mv">${c.move}</span>` +
      `<span class="bar" style="width:${Math.max(2, width)}%"></span>` +
      `<span>${tail}</span>`;
    return li;
  }

  function renderCandidates() {
    const list = el("candidateList");
    list.innerHTML = "";

    // 观战模式：黑 / 白 两方的落子概率并列
    if (S.mode === "spectate" && (S.policies.B || S.policies.W)) {
      for (const color of ["B", "W"]) {
        const pol = S.policies[color];
        if (!pol?.candidates?.length) continue;
        const head = document.createElement("li");
        head.className = "policy-head";
        head.innerHTML =
          `<span class="dot ${color === "B" ? "black" : "white"}"></span>` +
          `${color === "B" ? "黑方" : "白方"} · 第 ${pol.moveNumber} 手` +
          `${pol.elapsedMs != null ? ` · ${(pol.elapsedMs / 1000).toFixed(1)}s` : ""}`;
        list.appendChild(head);

        const shown = pol.candidates.slice(0, 4);
        const maxPrior = Math.max(...shown.map((c) => c.prior ?? 0), 0.0001);
        for (const c of shown) list.appendChild(candidateRow(c, maxPrior, { showPrior: true }));
      }
      return;
    }

    if (!S.candidates.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "下一手 AI 落子后显示";
      list.appendChild(li);
      return;
    }
    const maxVisits = Math.max(...S.candidates.map((c) => c.visits || 1));
    for (const c of S.candidates.slice(0, 6)) list.appendChild(candidateRow(c, maxVisits));
  }

  /**
   * 胜率走势：纯黑白面积占比
   * 每一列的高度分成两段——下方黑色面积 = 黑棋胜率占比，上方白色面积 = 白棋胜率占比。
   * 不画折线，靠两种极端色的分界线本身表达趋势。
   */
  function drawWinrateChart() {
    const cv = el("winrateChart");
    const ctx = cv.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 320;
    const h = cv.clientHeight || 104;
    if (Math.round(cv.width / dpr) !== Math.round(w) || Math.round(cv.height / dpr) !== Math.round(h)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const hist = S.winrateHist;
    const clamp01 = (v) => Math.min(1, Math.max(0, v));

    if (!hist.length) {
      ctx.fillStyle = "#16171c";
      ctx.fillRect(0, 0, w, h);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(200,200,210,0.55)";
      ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText("落子后开始记录黑白胜率占比", w / 2, h / 2);
      return;
    }

    const n = hist.length;

    // 只有一个点时画等宽色柱
    if (n === 1) {
      const yb = h - clamp01(hist[0].blackWin) * h;
      ctx.fillStyle = "#0a0a0d";
      ctx.fillRect(0, yb, w, h - yb);
      ctx.fillStyle = "#f6f6f8";
      ctx.fillRect(0, 0, w, yb);
      return;
    }

    const pts = hist.map((p, i) => ({
      x: (i / (n - 1)) * w,
      y: h - clamp01(p.blackWin) * h,
    }));

    // 白棋面积（分界线以上）
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(pts[n - 1].x, 0);
    ctx.lineTo(pts[0].x, 0);
    ctx.closePath();
    const gWhite = ctx.createLinearGradient(0, 0, 0, h * 0.6);
    gWhite.addColorStop(0, "#ffffff");
    gWhite.addColorStop(1, "#e8e8ec");
    ctx.fillStyle = gWhite;
    ctx.fill();

    // 黑棋面积（分界线以下）
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(pts[n - 1].x, h);
    ctx.lineTo(pts[0].x, h);
    ctx.closePath();
    const gBlack = ctx.createLinearGradient(0, 0, 0, h);
    gBlack.addColorStop(0, "#26262e");
    gBlack.addColorStop(1, "#08080b");
    ctx.fillStyle = gBlack;
    ctx.fill();

    // 复盘：在当前手位置画一条竖线
    if (S.mode === "review" && S.review?.timeline) {
      const total = S.review.game.moves.length;
      const x = total > 0 ? (S.review.index / total) * w : 0;
      ctx.strokeStyle = "rgba(255,196,80,0.95)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  function updateButtons() {
    const playMode = S.mode === "play";
    const canAct = playMode && Boolean(S.game) && !S.ended && !S.busy && S.game.turn === S.humanColor;
    el("btnPass").disabled = !canAct;
    el("btnResign").disabled = !playMode || !S.game || S.ended;
    el("btnUndo").disabled = !playMode || !S.game || S.busy || !S.game.history.length;
    el("btnScore").disabled = !playMode || !S.game;
    el("btnSaveSgf").disabled = !S.game || !S.game.history.length;

    const inReview = S.mode === "review" && Boolean(S.review?.timeline);
    el("btnReviewPrev").disabled = !inReview || S.review.index <= 0;
    el("btnReviewNext").disabled = !inReview || S.review.index >= (S.review?.game?.moves?.length ?? 0);
    el("btnReviewBlunder").disabled = !inReview || !(S.review?.blunders?.length);

    const specRunning = S.spectate.running;
    el("btnSpectateStart").disabled = specRunning;
    el("btnSpectatePause").disabled = !specRunning;
    el("btnSpectateStop").disabled = !specRunning;
    el("btnMatch").disabled = specRunning;
    el("btnSpectatePause").textContent = S.spectate.paused ? "继续" : "暂停";
  }

  // ------------------------------------------------------------------ 绘制
  function pointFromEvent(ev) {
    if (!S.canvas) return null;
    const rect = S.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const gx = Math.round((x - S.origin) / S.cell);
    const gy = Math.round((y - S.origin) / S.cell);
    if (gx < 0 || gy < 0 || gx >= S.size || gy >= S.size) return null;
    const dist = Math.hypot(x - (S.origin + gx * S.cell), y - (S.origin + gy * S.cell));
    if (dist > S.cell * 0.62) return null;
    return { x: gx, y: gy };
  }

  function draw() {
    const ctx = S.ctx;
    if (!ctx) return;
    const side = S.boardSide;
    ctx.clearRect(0, 0, side, side);

    // 木纹底
    const g = ctx.createLinearGradient(0, 0, side, side);
    g.addColorStop(0, "#e2b866");
    g.addColorStop(0.5, "#d8ab55");
    g.addColorStop(1, "#c79846");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, side, side);

    // 网格
    ctx.strokeStyle = "rgba(60,45,20,0.85)";
    ctx.lineWidth = 1;
    for (let i = 0; i < S.size; i++) {
      const p = S.origin + i * S.cell;
      ctx.beginPath();
      ctx.moveTo(S.origin, p);
      ctx.lineTo(S.origin + (S.size - 1) * S.cell, p);
      ctx.moveTo(p, S.origin);
      ctx.lineTo(p, S.origin + (S.size - 1) * S.cell);
      ctx.stroke();
    }

    // 星位
    const star = starPoints(S.size);
    ctx.fillStyle = "rgba(50,38,16,0.9)";
    for (const [sx, sy] of star) {
      ctx.beginPath();
      ctx.arc(S.origin + sx * S.cell, S.origin + sy * S.cell, Math.max(2, S.cell * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }

    // 坐标
    ctx.fillStyle = "rgba(60,45,20,0.75)";
    ctx.font = `${Math.max(10, Math.round(S.cell * 0.36))}px "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const letters = "ABCDEFGHJKLMNOPQRSTUVWXYZ";
    for (let i = 0; i < S.size; i++) {
      ctx.fillText(letters[i], S.origin + i * S.cell, side - S.margin * 0.45);
      ctx.fillText(String(S.size - i), S.margin * 0.45, S.origin + i * S.cell);
    }

    // 形势图（ownership）
    if (S.showOwnership && S.ownership && S.ownership.length === S.size * S.size) {
      for (let idx = 0; idx < S.ownership.length; idx++) {
        const v = S.ownership[idx];
        if (Math.abs(v) < 0.15) continue;
        const x = S.origin + R.xOf(idx, S.size) * S.cell;
        const y = S.origin + R.yOf(idx, S.size) * S.cell;
        ctx.fillStyle = v > 0 ? "rgba(40,40,45,0.34)" : "rgba(245,245,245,0.45)";
        const s = S.cell * 0.78;
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }

    // 候选点
    if (S.showCandidates && S.candidates.length && !S.ended) {
      const maxVisits = Math.max(...S.candidates.map((c) => c.visits || 1));
      for (const c of S.candidates.slice(0, 6)) {
        const idx = R.gtpToIdx(c.move, S.size);
        if (idx < 0) continue;
        const x = S.origin + R.xOf(idx, S.size) * S.cell;
        const y = S.origin + R.yOf(idx, S.size) * S.cell;
        const ratio = Math.sqrt((c.visits || 1) / maxVisits);
        const r = S.cell * (0.16 + ratio * 0.26);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(70,110,220,0.30)";
        ctx.fill();
        ctx.strokeStyle = "rgba(60,90,200,0.55)";
        ctx.lineWidth = 1;
        ctx.stroke();
        if (ratio > 0.45) {
          ctx.fillStyle = "rgba(30,40,80,0.9)";
          ctx.font = `${Math.max(9, S.cell * 0.3)}px "Segoe UI", sans-serif`;
          ctx.fillText(`${Math.round((c.winrate ?? 0) * 100)}`, x, y);
        }
      }
    }

    // 棋子（对局还没建起来时 S.game 为 null，启动瞬间的重绘不能报错）
    const board = S.game?.board;
    const lastMove = S.game?.history?.[S.game.history.length - 1];
    if (board) {
      for (let idx = 0; idx < board.length; idx++) {
        const v = board[idx];
        if (v === R.EMPTY) continue;
        const x = S.origin + R.xOf(idx, S.size) * S.cell;
        const y = S.origin + R.yOf(idx, S.size) * S.cell;
        drawStone(ctx, x, y, S.cell * 0.46, v);
        if (S.showNumbers) {
          const num = moveNumberAt(idx);
          if (num) {
            ctx.fillStyle = v === R.BLACK ? "rgba(255,255,255,0.85)" : "rgba(30,30,30,0.85)";
            ctx.font = `${Math.max(8, S.cell * 0.34)}px "Segoe UI", sans-serif`;
            ctx.fillText(num, x, y);
          }
        }
      }
    }

    // 最后一手
    if (lastMove && lastMove.type === "move") {
      const x = S.origin + lastMove.x * S.cell;
      const y = S.origin + lastMove.y * S.cell;
      ctx.beginPath();
      ctx.arc(x, y, S.cell * 0.13, 0, Math.PI * 2);
      ctx.fillStyle = lastMove.color === R.BLACK ? "rgba(255,90,90,0.95)" : "rgba(220,40,40,0.95)";
      ctx.fill();
    }

    // 复盘：标出恶手位置
    if (S.mode === "review" && S.review?.blunders?.length) {
      for (const b of S.review.blunders) {
        const m = S.review.game.moves[b.ply - 1];
        if (!m || m.pass) continue;
        const bx = S.origin + m.x * S.cell;
        const by = S.origin + m.y * S.cell;
        ctx.beginPath();
        ctx.arc(bx, by, S.cell * 0.44, 0, Math.PI * 2);
        ctx.strokeStyle = b.severity === "severe" ? "rgba(224,108,117,0.95)" : "rgba(224,108,117,0.55)";
        ctx.lineWidth = b.severity === "severe" ? 2.2 : 1.4;
        ctx.stroke();
        if (b.ply === S.review.index) {
          ctx.fillStyle = "rgba(224,108,117,0.20)";
          ctx.fill();
        }
      }
    }

    // 观战：叠加双方落子概率（黑＝深色圆环，白＝浅色圆环）
    if (S.mode === "spectate" && S.showPolicy && (S.policies.B || S.policies.W)) {
      for (const color of ["B", "W"]) {
        const pol = S.policies[color];
        if (!pol?.candidates?.length) continue;
        const maxPrior = Math.max(...pol.candidates.map((c) => c.prior ?? 0), 0.0001);
        for (const c of pol.candidates.slice(0, 4)) {
          const pidx = R.gtpToIdx(c.move, S.size);
          if (pidx < 0) continue;
          const px = S.origin + R.xOf(pidx, S.size) * S.cell;
          const py = S.origin + R.yOf(pidx, S.size) * S.cell;
          const ratio = Math.sqrt((c.prior ?? 0) / maxPrior);
          const pr = S.cell * (0.15 + ratio * 0.24);
          ctx.beginPath();
          ctx.arc(px, py, pr, 0, Math.PI * 2);
          ctx.strokeStyle = color === "B" ? "rgba(18,18,24,0.92)" : "rgba(250,250,252,0.96)";
          ctx.lineWidth = 2;
          ctx.stroke();
          if (ratio > 0.35) {
            ctx.fillStyle = color === "B" ? "rgba(8,8,12,0.92)" : "rgba(248,248,250,0.96)";
            ctx.font = `${Math.max(9, Math.round(S.cell * 0.28))}px "Segoe UI", sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(`${Math.round((c.prior ?? 0) * 100)}%`, px, py);
          }
        }
      }
    }

    // 悬停提示
    if (S.hover && S.mode === "play" && !S.ended && !S.busy && S.game && S.game.turn === S.humanColor) {
      const x = S.origin + S.hover.x * S.cell;
      const y = S.origin + S.hover.y * S.cell;
      const occupied = S.game.board[R.idxOf(S.hover.x, S.hover.y, S.size)] !== R.EMPTY;
      if (!occupied) {
        ctx.globalAlpha = 0.35;
        drawStone(ctx, x, y, S.cell * 0.46, S.humanColor);
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawStone(ctx, x, y, r, color) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = r * 0.35;
    ctx.shadowOffsetY = r * 0.12;
    const grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.15, x, y, r);
    if (color === R.BLACK) {
      grad.addColorStop(0, "#5c5c5c");
      grad.addColorStop(0.45, "#232323");
      grad.addColorStop(1, "#050505");
    } else {
      grad.addColorStop(0, "#ffffff");
      grad.addColorStop(0.6, "#f2f2f2");
      grad.addColorStop(1, "#c8c8c8");
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = color === R.BLACK ? "rgba(0,0,0,0.55)" : "rgba(120,120,120,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  function moveNumberAt(idx) {
    const h = S.game.history;
    for (let i = h.length - 1, n = h.length; i >= 0; i--) {
      const m = h[i];
      if (m.type === "move" && R.idxOf(m.x, m.y, S.size) === idx) return n - i;
    }
    return null;
  }

  function starPoints(n) {
    if (n === 19) {
      const p = [3, 9, 15];
      return p.flatMap((a) => p.map((b) => [a, b]));
    }
    if (n === 13) {
      const p = [3, 6, 9];
      return p.flatMap((a) => p.map((b) => [a, b]));
    }
    if (n === 9) {
      const p = [2, 4, 6];
      return p.flatMap((a) => p.map((b) => [a, b]));
    }
    return [];
  }

  // ------------------------------------------------------------------ 形势判断 / 棋谱
  async function onScoreNow() {
    if (!S.game || S.busy) return;
    setThinking(true, "形势判断中…");
    try {
      const res = await api.score();
      const lastHist = S.winrateHist[S.winrateHist.length - 1];
      modal(
        "形势判断",
        `引擎判定：${res.score}\n${
          lastHist ? `黑胜率（AI 评估）：${(lastHist.blackWin * 100).toFixed(1)}%` : ""
        }\n（这是依据当前局面的估算，不代表最终结果）`,
      );
      log(`形势判断：${res.score}`);
    } catch (err) {
      log("形势判断失败: " + err.message);
    } finally {
      setThinking(false);
    }
  }

  function sgfCoord(x, y) {
    const letters = "abcdefghijklmnopqrs";
    return `${letters[x]}${letters[y]}`;
  }

  function buildSgf() {
    if (S.mode === "spectate") {
      const blackName = "KataGo " + levelLabel(el("specBlack").value);
      const whiteName = "KataGo " + levelLabel(el("specWhite").value);
      const headParts = [
        "(;GM[1]FF[4]CA[UTF-8]AP[围棋·KataGo:0.1]",
        "SZ[" + S.size + "]",
        "KM[" + S.komi + "]",
      ];
      const stones = S.handicapStones ?? [];
      if (stones.length) {
        headParts.push("HA[" + stones.length + "]");
        headParts.push("AB" + stones.map((p) => "[" + sgfCoord(p.x, p.y) + "]").join(""));
      }
      headParts.push("PB[" + blackName + "]", "PW[" + whiteName + "]", "RU[Chinese]");
      const head = headParts.join("");
      const moves = S.game.history
        .filter((m) => m.type === "move" || m.type === "pass")
        .map((m) => {
          const c = m.color === R.BLACK ? "B" : "W";
          return m.type === "pass" ? ";" + c + "[]" : ";" + c + "[" + sgfCoord(m.x, m.y) + "]";
        })
        .join("");
      return head + moves + ")";
    }
    const lv = currentLevel();
    const head = [
      "(;GM[1]FF[4]CA[UTF-8]AP[围棋·KataGo:0.1]",
      `SZ[${S.size}]`,
      `KM[${S.komi}]`,
      "PB[你]",
      `PW[KataGo ${lv.label}]`,
      `RU[Chinese]`,
    ].join("");
    const moves = S.game.history
      .filter((m) => m.type === "move" || m.type === "pass")
      .map((m) => {
        const c = m.color === R.BLACK ? "B" : "W";
        return m.type === "pass" ? `;${c}[]` : `;${c}[${sgfCoord(m.x, m.y)}]`;
      })
      .join("");
    return head + moves + ")";
  }

  async function onSaveSgf(forcedPath) {
    if (!S.game || !S.game.history.length) {
      log("还没有棋谱可保存");
      return;
    }
    // 只接受字符串路径；顺手挡住把 click 事件对象当路径传进来的情况
    const target = typeof forcedPath === "string" && forcedPath ? forcedPath : undefined;
    try {
      const res = await api.saveSgf(buildSgf(), `go-${S.size}x${S.size}-${S.mode}.sgf`, target);
      if (res.saved) log(`棋谱已保存：${res.path}`);
    } catch (err) {
      log("保存棋谱失败: " + err.message);
    }
  }

  // ------------------------------------------------------------------ 系统占用
  function setMeter(barId, textId, percent, label) {
    const bar = el(barId);
    const text = el(textId);
    if (!bar || !text) return;
    if (percent == null) {
      bar.style.width = "0%";
      text.textContent = "—";
      return;
    }
    const p = Math.max(0, Math.min(100, percent));
    bar.style.width = p + "%";
    bar.classList.toggle("warn", p >= 70 && p < 90);
    bar.classList.toggle("hot", p >= 90);
    text.textContent = label ?? `${p}%`;
  }

  function renderMetrics(m) {
    if (!m) return;
    const backendEl = el("backendText");
    if (backendEl && m.backend) {
      const detail = m.backendDetail ?? "";
      const same = !detail || detail.toLowerCase().startsWith(String(m.backend).toLowerCase());
      backendEl.textContent = same ? m.backend : `${m.backend}（${detail}）`;
      backendEl.title = m.backend === "CPU" ? "未检测到可用的 GPU 后端，已回退到 CPU" : "";
    }
    setMeter("cpuBar", "cpuText", m.cpu, `${m.cpu}%`);
    if (m.gpu) {
      setMeter("gpuBar", "gpuText", m.gpu.util, `${m.gpu.util}%`);
      if (m.gpu.memTotal) {
        const pct = Math.round((m.gpu.memUsed / m.gpu.memTotal) * 100);
        setMeter(
          "vramBar",
          "vramText",
          pct,
          `${(m.gpu.memUsed / 1024).toFixed(1)}/${(m.gpu.memTotal / 1024).toFixed(0)}G`,
        );
      }
    } else {
      setMeter("gpuBar", "gpuText", null, "无独显");
      setMeter("vramBar", "vramText", null, "—");
    }
  }

  // ================================================================== 性能模式
  function renderPerfInfo(info) {
    const box = el("perfText");
    if (!box || !info?.tune) return;
    const t = info.tune;
    const label = info.perfMode === "balanced" ? "省电" : "高吞吐";
    box.textContent = `${t.numSearchThreads} 线程 · batch ${t.nnMaxBatchSize}`;
    const sp = info.spectateTune;
    box.title =
      `${label}模式　单引擎 ${t.numSearchThreads} 线程 / batch ${t.nnMaxBatchSize}` +
      (sp ? `　观战双引擎各 ${sp.numSearchThreads} 线程` : "") +
      (info.cores ? `　CPU ${info.cores} 核` : "");
  }

  async function onPerfChange(select, previous) {
    const target = select.value;
    select.disabled = true;
    setThinking(true, "切换性能模式…");
    try {
      const res = await api.setSettings({ perfMode: target });
      if (!res?.ok) {
        select.value = previous;
        log("性能模式未切换：" + (res?.reason ?? "未知原因"));
        return;
      }
      renderPerfInfo(res);
      log(
        `性能模式 → ${res.perfLabel}（单引擎 ${res.tune.numSearchThreads} 线程 · batch ${res.tune.nnMaxBatchSize}` +
          `${res.spectateTune ? `；观战双引擎各 ${res.spectateTune.numSearchThreads} 线程` : ""}）` +
          (res.restarted ? "，下一次思考时自动重启引擎并恢复局面" : ""),
      );
    } catch (err) {
      select.value = previous;
      log("切换性能模式失败：" + (err?.message ?? err));
    } finally {
      select.disabled = false;
      setThinking(false);
    }
    return select.value;
  }

  // ================================================================== 组件目录
  function shortDir(p) {
    if (!p) return "—";
    const parts = p.split("\\").filter(Boolean);
    return parts.length > 2 ? "…\\" + parts.slice(-2).join("\\") : p;
  }

  async function refreshPathsInfo() {
    try {
      const info = await api.pathsInfo();
      const el2 = el("engineDirText");
      if (el2) {
        el2.textContent = shortDir(info.engineRoot);
        el2.title = info.engineRoot + (info.custom ? "（自定义）" : info.installWritable ? "（跟随安装目录）" : "（用户数据目录）");
      }
    } catch {
      /* ignore */
    }
  }

  async function onChooseDir() {
    try {
      const res = await api.choosePath();
      if (!res?.changed) return;
      log("组件目录已切换：" + res.engineRoot + (res.copied ? "（已复制既有组件）" : ""));
      await refreshPathsInfo();
      const started = await ensureComponentsThenStart();
      if (!started) return;
    } catch (err) {
      log("切换目录失败：" + err.message);
    }
  }

  /** 检查组件：齐了就直接开局，缺了弹安装向导。返回是否已开局 */
  async function ensureComponentsThenStart() {
    try {
      const setup = await api.setupCheck();
      // 只有「必需组件」缺失才进安装向导；可选加速包缺失不该拦着用户
      const missingRequired = (setup?.candidates ?? []).filter((c) => c.required && c.applicable !== false);
      if (missingRequired.length > 0) {
        showSetupWizard(setup);
        return false;
      }
      await onNewGame();
      return true;
    } catch (err) {
      log("组件检查失败：" + err.message);
      return false;
    }
  }

  // ================================================================== 首次安装向导
  function fmtMB(bytes) {
    return (bytes / 1048576).toFixed(0) + " MB";
  }

  function showSetupWizard(setup) {
    const screen = el("setupScreen");
    const list = el("setupList");
    const states = new Map();
    const selected = new Set();

    el("setupHw").textContent = setup.hardware?.summary ?? "硬件信息不可用";
    el("setupDir").textContent = setup.engineRoot ?? "—";
    el("setupDir").title = setup.engineRoot ?? "";
    el("btnSetupDir").onclick = async () => {
      const res = await api.choosePath().catch(() => null);
      if (!res?.changed) return;
      el("setupScreen").classList.add("hidden");
      await refreshPathsInfo();
      await ensureComponentsThenStart();
    };

    const mirrorBox = el("chkMirror");
    const m = setup.mirror ?? {};
    mirrorBox.checked = m.mode === "china";
    const ghMs = m.ms?.github ?? "?";
    const pypiMs = m.ms?.pypi ?? "?";
    el("mirrorHint").textContent =
      "官方源延迟：GitHub " + ghMs + " ms / PyPI " + pypiMs + " ms" +
      (m.suggest === "china" ? "　→ 建议勾选国内镜像" : "　→ 直连即可，无需镜像");
    list.innerHTML = "";
    el("setupVerify").classList.add("hidden");
    el("setupVerify").innerHTML = "";

    const updateTotal = () => {
      let bytes = 0;
      for (const id of selected) {
        const c = setup.candidates.find((x) => x.id === id);
        if (c) bytes += c.bytes;
      }
      el("setupTotal").textContent = bytes ? fmtMB(bytes) : "0 MB";
      el("btnSetupInstall").disabled = selected.size === 0;
    };

    for (const c of setup.candidates) {
      const li = document.createElement("li");
      const big = c.bytes > 200 * 1048576;
      const checked = c.required || (c.applicable && c.recommended && !big);
      if (!c.applicable) li.classList.add("na");
      if (c.recommended && !c.required) li.classList.add("recommend");

      const tag = c.required
        ? '<span class="comp-tag req">必需</span>'
        : c.recommended
          ? '<span class="comp-tag rec">' + (c.bytes > 200 * 1048576 ? '推荐·大' : '推荐') + '</span>'
          : c.applicable
            ? '<span class="comp-tag">可选</span>'
            : '<span class="comp-tag">不适用</span>';

      li.innerHTML =
        '<input type="checkbox" ' + (checked ? "checked" : "") + (c.applicable ? "" : " disabled") + ' />' +
        '<span class="comp-name">' + c.label +
          "<small>" + (c.applicable ? (c.detail ?? "") : (c.reason ?? "") + "，已跳过") + "</small></span>" +
        tag +
        '<span class="comp-size">' + fmtMB(c.bytes) + "</span>";

      const box = li.querySelector("input");
      box.dataset.id = c.id;
      if (checked && c.applicable) selected.add(c.id);
      box.addEventListener("change", () => {
        if (box.checked) selected.add(c.id);
        else selected.delete(c.id);
        updateTotal();
      });
      box.addEventListener("change", () => {
        const st = states.get(c.id);
        if (st) st.textContent = "";
      });
      states.set(c.id, li.querySelector(".comp-size"));
      list.appendChild(li);
    }

    updateTotal();
    el("setupProgressWrap").classList.add("hidden");
    el("setupHint").textContent = "下载完成后会自动进入游戏，并校验各后端的可用性。";
    const btn = el("btnSetupInstall");
    btn.textContent = "下载并安装";
    btn.disabled = selected.size === 0;
    screen.classList.remove("hidden");
    setThinking(false);

    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "正在下载…";
      el("setupProgressWrap").classList.remove("hidden");
      el("setupHint").textContent = "下载期间可以最小化窗口，请勿关闭。";
      setThinking(true, "正在下载运行组件…");
      try {
        await api.setupInstall([...selected], { mirror: mirrorBox.checked ? 'china' : 'direct' });
      } catch (err) {
        el("setupHint").textContent = "安装失败：" + err.message + "（可重试，已下载的部分会复用）";
        btn.disabled = false;
        btn.textContent = "重试";
        setThinking(false);
      }
    };

    api.onSetupProgress((p) => {
      const state = states.get(p.id);
      if (state) {
        if (p.phase === "download") state.textContent = p.total ? Math.floor((p.received / p.total) * 100) + "%" : "…";
        else if (p.phase === "extract") state.textContent = "解压中";
        else if (p.phase === "done") state.textContent = "已完成";
      }
      if ((p.phase === "download" || p.phase === "extract") && p.total) {
        const pct = Math.min(100, Math.floor((p.received / p.total) * 100));
        el("setupProgressBar").style.width = pct + "%";
        const srcInfo = p.sourceCount > 1 ? "（文件 " + p.sourceIndex + "/" + p.sourceCount + "）" : "";
        if (p.phase === "mirror") { el("setupProgressText").textContent = "镜像不通，已回退直连：" + p.label; return; }
        el("setupProgressText").textContent =
          "(" + p.index + "/" + p.count + ") " + p.label + srcInfo + "　" + pct + "%　" +
          (p.received / 1048576).toFixed(1) + " / " + (p.total / 1048576).toFixed(1) + " MB";
      }
    });

    api.onSetupDone(async (res) => {
      el("setupProgressBar").style.width = "100%";
      el("setupProgressText").textContent = "安装完成，正在校验后端…";
      if (res.checks?.length) {
        const ul = el("setupVerify");
        ul.innerHTML = "";
        for (const c of res.checks) {
          const li = document.createElement("li");
          li.className = c.ok ? "ok" : "bad";
          li.innerHTML = "<span>" + c.label + "</span><b>" + (c.ok ? "可用（" + c.detail + "）" : "不可用（" + c.detail + "）") + "</b>";
          ul.appendChild(li);
        }
        ul.classList.remove("hidden");
      }
      el("setupHint").textContent = "环境校验完成，正在启动引擎…";
      log("组件安装完成，后端：" + (res.backends ?? []).join(" / "));
      await new Promise((r) => setTimeout(r, 900));
      el("setupScreen").classList.add("hidden");
      setThinking(false);
      await onNewGame();
    });
  }

  // ================================================================== 模式切换
  function setMode(mode) {
    if (S.mode === mode) return;
    S.mode = mode;
    for (const btn of document.querySelectorAll(".mode-btn")) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    }
    for (const group of document.querySelectorAll(".btn-group[data-mode]")) {
      group.classList.toggle("hidden", group.dataset.mode !== mode);
    }
    el("spectateCard").classList.toggle("hidden", mode !== "spectate");
    el("reviewCard").classList.toggle("hidden", mode !== "review");
    el("levelWrap").classList.toggle("hidden", mode !== "play");
    el("handicapWrap").classList.toggle("hidden", mode === "review");
    el("candidatesTitle").textContent =
      mode === "review" ? "当前局面最佳点" : mode === "spectate" ? "落子概率（黑 / 白）" : "AI 候选点（白方胜率）";
    el("chartTitle").textContent = mode === "review" ? "全盘胜率走势（复盘）" : "胜率走势";
    el("modeBadge").classList.toggle("hidden", mode === "play");
    if (mode === "spectate") el("modeBadge").textContent = "观战模式";
    if (mode === "review") el("modeBadge").textContent = "复盘模式";

    if (mode !== "spectate" && S.spectate.running) stopSpectate();
    if (mode === "spectate") resetSpectateBoard();
    if (mode === "play") {
      S.review = null;
      onNewGame();
    }
    updateButtons();
    draw();
  }

  // ================================================================== AI 观战
  function resetSpectateBoard({ keepLevels = false } = {}) {
    S.size = Number(el("sizeSelect").value);
    S.komi = Number(el("komiInput").value);
    S.game = R.createState(S.size, { komi: S.komi });
    S.ended = false;
    S.busy = false;
    S.candidates = [];
    S.ownership = null;
    S.winrateHist = [];
    S.lastAiMove = null;
    S.policies = { B: null, W: null };
    S.policyShown = null;
    S.handicapStones = [];
    S.stopRequested = false;
    setupCanvas();
    draw();
    renderStats();
    renderCandidates();
    updateButtons();
  }

  // 观战速度预设：每手访问数（影响棋力与耗时）+ 落子间隔（只影响观感，不影响棋力）
  const SPECTATE_SPEEDS = {
    slow: { visits: 200, pace: 700, label: "慢慢看" },
    normal: { visits: 60, pace: 300, label: "标准" },
    fast: { visits: 40, pace: 120, label: "快" },
    turbo: { visits: 40, pace: 0, label: "极速（同测速）" },
  };

  function renderSpectateSpeedHint() {
    const hint = el("specSpeedHint");
    if (!hint) return;
    const visits = Number(el("specVisits").value) || 60;
    const pace = Number(el("specPace").value) || 0;
    const label = SPECTATE_SPEEDS[el("specSpeed").value]?.label ?? "自定义";
    // 粗估：本机双引擎 9 路约 600 访问/秒，19 路更慢；只做数量级参考
    const est = Math.round((visits / 600) * 1000) + pace;
    hint.textContent = `${label}：每手 ${visits} 访问 + 间隔 ${pace}ms ≈ ${(est / 1000).toFixed(2)} 秒/手（估算）`;
  }

  function applySpectateSpeed(key, { silent = false } = {}) {
    const preset = SPECTATE_SPEEDS[key];
    if (!preset) return;
    el("specVisits").value = String(preset.visits);
    el("specPace").value = String(preset.pace);
    const sel = el("specSpeed");
    if (sel.value !== key) sel.value = key;
    renderSpectateSpeedHint();
    if (!silent) log(`观战速度：${preset.label}（每手 ${preset.visits} 访问 · 间隔 ${preset.pace}ms）`);
  }

  async function onSpectateStart() {
    resetSpectateBoard();
    const visits = Number(el("specVisits").value) || 60;
    const opts = {
      size: S.size,
      komi: S.komi,
      handicap: Number(el("handicapSelect").value || 0),
      levelBlack: el("specBlack").value,
      levelWhite: el("specWhite").value,
      maxMoves: Number(el("specMaxMoves").value) || 240,
      paceMs: Number(el("specPace").value) || 0,
      visitsBlack: visits,
      visitsWhite: visits,
    };
    S.spectate.running = true;
    S.spectate.paused = false;
    el("specStatus").textContent =
      `对局中：黑 ${levelLabel(opts.levelBlack)} vs 白 ${levelLabel(opts.levelWhite)}　` +
      `每手 ${visits} 访问 · 间隔 ${opts.paceMs}ms`;
    log(`开始观战：黑 ${levelLabel(opts.levelBlack)} / 白 ${levelLabel(opts.levelWhite)}（每手 ${visits} 访问，间隔 ${opts.paceMs}ms）`);
    setThinking(true, "AI 对局中…");
    updateButtons();
    const res = await api.spectateStart(opts);
    if (!res.started) {
      log("无法开始：" + (res.reason ?? "未知原因"));
      S.spectate.running = false;
      setThinking(false);
      updateButtons();
    }
  }

  async function stopSpectate() {
    // 先让界面立刻响应，不等引擎跑完当前这一手
    S.spectate.running = false;
    S.spectate.paused = false;
    S.stopRequested = true;
    setThinking(true, "正在停止…");
    el("specStatus").textContent = "正在停止…";
    updateButtons();
    try {
      await api.spectateStop();
    } catch (err) {
      log("停止失败：" + err.message);
    }
    setThinking(false);
    el("specStatus").textContent = "已停止";
    updateButtons();
  }

  async function toggleSpectatePause() {
    if (!S.spectate.running) return;
    S.spectate.paused = !S.spectate.paused;
    await api.spectatePause(S.spectate.paused);
    el("btnSpectatePause").textContent = S.spectate.paused ? "继续" : "暂停";
    el("specStatus").textContent = S.spectate.paused ? "已暂停" : "对局中…";
    updateButtons();
  }

  async function onMatchStart() {
    resetSpectateBoard();
    const games = Number(el("specGames").value) || 6;
    const opts = {
      games,
      size: S.size,
      komi: S.komi,
      handicap: Number(el("handicapSelect").value || 0),
      levelA: el("specBlack").value,
      levelB: el("specWhite").value,
      visitsA: Number(el("specVisits").value) || 60,
      visitsB: Number(el("specVisits").value) || 60,
      pacingMs: 150,
    };
    S.spectate.running = true;
    el("specStatus").textContent = `测速中：A=${levelLabel(opts.levelA)} B=${levelLabel(opts.levelB)}（${games} 局）`;
    setThinking(true, "测速对局中…");
    updateButtons();
    const res = await api.spectateMatch(opts);
    if (!res.started) {
      log("无法开始测速：" + (res.reason ?? "未知原因"));
      S.spectate.running = false;
      setThinking(false);
      updateButtons();
    }
  }

  function onSpectateMoveEvent(ev) {
    const m = ev.move;
    if (!S.game) return;
    if (m.pass) {
      S.game = R.playPass(S.game).state;
    } else {
      const r = R.playMove(S.game, m.x, m.y);
      if (r.ok) S.game = r.state;
    }
    if (m.color === "B") S.lastAiMove = { color: R.BLACK, x: m.x, y: m.y };
    else S.lastAiMove = { color: R.WHITE, x: m.x, y: m.y };

    const cands = (m.candidates ?? []).map((c) => ({
      move: c.move,
      visits: c.visits,
      winrate: c.winrate,
      scoreLead: c.scoreLead,
      prior: c.prior ?? null,
      pv: c.pv ?? [],
    }));
    S.candidates = cands;
    // 记录双方各自的落子概率（policy prior），用于界面并列展示
    if (cands.length) {
      S.policies[m.color] = {
        candidates: cands.slice(0, 5),
        elapsedMs: m.elapsedMs ?? null,
        moveNumber: ev.moveNumber,
      };
      S.policyShown = m.color;
    }
    if (typeof m.winrate === "number") {
      const blackWin = m.color === "B" ? m.winrate : 1 - m.winrate;
      S.winrateHist.push({ move: ev.moveNumber, blackWin });
    }
    draw();
    renderStats();
    renderCandidates();
    el("turnText").textContent = `${S.game.turn === R.BLACK ? "黑" : "白"}（AI）`;
    updateButtons();
  }

  // ================================================================== 棋谱复盘
  function levelLabel(id) {
    const lv = S.levels.find((l) => l.id === id);
    return lv ? `${lv.label}·${lv.rank}` : id;
  }

  function reviewStateAt(idx) {
    let st = S.review.initial;
    const moves = S.review.game.moves;
    for (let i = 0; i < idx && i < moves.length; i++) {
      const m = moves[i];
      if (m.pass) {
        st = R.playPass(st).state;
      } else {
        const r = R.playMove(st, m.x, m.y);
        if (r.ok) st = r.state;
      }
    }
    return st;
  }

  function detectBlunders(game, timeline) {
    const out = [];
    for (let i = 1; i < timeline.length; i++) {
      const before = timeline[i - 1];
      const after = timeline[i];
      if (before.blackWin == null || after.blackWin == null) continue;
      const mover = after.move?.color ?? game.moves[i - 1]?.color;
      if (!mover) continue;
      const beforeMover = mover === "B" ? before.blackWin : 1 - before.blackWin;
      const afterMover = mover === "B" ? after.blackWin : 1 - after.blackWin;
      const drop = beforeMover - afterMover;
      if (drop >= 0.10) {
        out.push({
          ply: i,
          color: mover,
          played: after.move?.gtp ?? "",
          best: before.candidates?.[0]?.move ?? "",
          drop,
          severity: drop >= 0.25 ? "severe" : "normal",
        });
      }
    }
    return out;
  }

  function renderBlunders() {
    const list = el("blunderList");
    list.innerHTML = "";
    const blunders = S.review?.blunders ?? [];
    if (!blunders.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = S.review?.timeline ? "没有发现明显恶手 👍" : "尚未复盘";
      list.appendChild(li);
      return;
    }
    for (const b of blunders) {
      const li = document.createElement("li");
      li.className = b.severity === "severe" ? "severe" : "";
      li.innerHTML = `<span class="ply">${b.ply}</span>
        <span class="who">${b.color === "B" ? "黑" : "白"}</span>
        <span class="played">${b.played || "pass"}</span>
        <span class="drop">-${(b.drop * 100).toFixed(1)}%</span>`;
      li.title = b.best ? `建议改下：${b.best}` : "";
      li.addEventListener("click", () => gotoReview(b.ply));
      list.appendChild(li);
    }
  }

  function gotoReview(idx) {
    if (!S.review) return;
    const total = S.review.game.moves.length;
    idx = Math.max(0, Math.min(total, idx));
    S.review.index = idx;
    S.game = reviewStateAt(idx);
    S.ended = idx >= total;
    S.busy = false;
    const t = S.review.timeline?.[idx];
    S.candidates = (t?.candidates ?? []).map((c) => ({
      move: c.move,
      visits: c.visits,
      winrate: c.winrate,
      scoreLead: c.scoreLead,
      pv: c.pv ?? [],
    }));
    S.ownership = null;
    draw();
    renderStats();
    renderCandidates();
    drawWinrateChart();
    el("reviewStatus").textContent = `第 ${idx} / ${total} 手${
      idx > 0 ? `（${S.review.game.moves[idx - 1].color === "B" ? "黑" : "白"} ${t?.move?.gtp ?? "pass"}）` : "（初始局面）"
    }`;
    updateButtons();
  }

  async function onOpenSgf(forcedPath) {
    const res = await api.openSgf(forcedPath);
    if (!res?.opened) return;
    const g = res.game;
    S.mode = "review";
    S.size = g.size;
    el("sizeSelect").value = String(g.size);
    S.komi = g.komi;
    el("komiInput").value = String(g.komi);
    setupCanvas();

    let initial = R.createState(g.size, { komi: g.komi });
    if (g.setupBlack?.length) initial = R.placeStones(initial, R.BLACK, g.setupBlack);
    if (g.setupWhite?.length) initial = R.placeStones(initial, R.WHITE, g.setupWhite);
    if (g.setupBlack?.length) initial = { ...initial, turn: R.WHITE };

    S.review = { game: g, initial, timeline: null, index: 0, blunders: [] };
    S.game = initial;
    S.winrateHist = [];
    S.candidates = [];
    S.ended = false;
    draw();
    renderStats();
    renderCandidates();
    renderBlunders();
    log(`载入棋谱：${res.path}`);
    el("reviewStatus").textContent = `分析中…（共 ${g.moves.length} 手）`;
    el("reviewProgressWrap").classList.remove("hidden");
    el("reviewProgressBar").style.width = "0%";
    el("reviewProgressText").textContent = "0 / " + g.moves.length;

    try {
      const r = await api.reviewStart({
        size: g.size,
        komi: g.komi,
        handicap: g.handicap ?? 0,
        moves: g.moves.map((m) => ({ color: m.color, x: m.x, y: m.y, pass: m.pass })),
        visits: 120,
        perMoveMs: 400,
      });
      S.review.timeline = r.timeline;
      S.review.blunders = detectBlunders(g, r.timeline);
      if (r.retries > 0) log(`复盘过程中引擎重启并续跑 ${r.retries} 次（已自动恢复，结果完整）`);
      S.winrateHist = r.timeline
        .filter((t) => t.blackWin != null)
        .map((t) => ({ move: t.index, blackWin: t.blackWin }));
      renderBlunders();
      el("reviewStatus").textContent = `复盘完成：${g.moves.length} 手，${S.review.blunders.length} 个恶手（${(
        r.elapsedMs / 1000
      ).toFixed(1)}s${r.retries > 0 ? `，自动重试 ${r.retries} 次` : ""}）`;
      gotoReview(0);
    } catch (err) {
      log("复盘失败：" + err.message);
      el("reviewStatus").textContent = "复盘失败：" + err.message;
    } finally {
      el("reviewProgressWrap").classList.add("hidden");
    }
  }

  // ------------------------------------------------------------------ 启动
  boot().catch((err) => {
    log("启动失败: " + (err?.stack ?? err));
  });
})();
