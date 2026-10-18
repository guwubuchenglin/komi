/**
 * 难度系统
 *
 * 设计依据（KataGo 官方 human SL 文档）：
 * - 弱档：用 human 模型模拟真人段位的“原始策略”（几乎不做搜索），并加入随机温度与延迟，
 *   这样既弱得像人，也不会下出 AI 特有的怪棋。
 * - 中档：human 模型 + 有节制的搜索（humanSLChosenMovePiklLambda 抑制明显亏的着法）。
 * - 强档：标准网络 + 递增访问数，必要时用 playoutDoublingAdvantage 微调。
 *
 * 关键约束：humanSLProfile 是配置级参数，切换段位需要重启引擎；
 * 而 maxVisits / maxTime / playoutDoublingAdvantage 属于搜索参数，可运行时热切换。
 */

export const BACKEND = { HUMAN: 'human', NORMAL: 'normal' };

/**
 * @typedef {object} Level
 * @property {string} id
 * @property {string} label    界面显示名
 * @property {string} rank     目标棋力（KGS 近似）
 * @property {'human'|'normal'} backend
 * @property {string} [humanProfile] human SL 段位档，如 preaz_10k
 * @property {number} maxVisits  搜索访问数
 * @property {number} maxTimeMs  单步最长思考时间（UI 层软限制）
 * @property {number} [pdA]      playoutDoublingAdvantage
 * @property {number} [piklLambda] 人类着法抑制强度（越小越强、越像 AI）
 * @property {number} [rootExplore] 用于评估人类着法的访问占比
 * @property {string} note      一句话说明
 */

/** @type {Level[]} */
export const LEVELS = [
  {
    id: "lv1",
    label: "入门",
    rank: "约 20 级",
    backend: BACKEND.HUMAN,
    humanProfile: "preaz_20k",
    maxVisits: 40,
    maxTimeMs: 1200,
    note: "刚学会规则的水平，会漏看死活，适合第一次下完一整盘",
  },
  {
    id: "lv2",
    label: "新手",
    rank: "约 15 级",
    backend: BACKEND.HUMAN,
    humanProfile: "preaz_15k",
    maxVisits: 40,
    maxTimeMs: 1400,
    note: "知道基本死活与连接，但常下无理手",
  },
  {
    id: "lv3",
    label: "初级",
    rank: "约 10 级",
    backend: BACKEND.HUMAN,
    humanProfile: "preaz_10k",
    maxVisits: 40,
    maxTimeMs: 1600,
    note: "会做基本判断，接触战容易吃亏",
  },
  {
    id: "lv4",
    label: "中级",
    rank: "约 5 级",
    backend: BACKEND.HUMAN,
    humanProfile: "preaz_5k",
    maxVisits: 40,
    maxTimeMs: 1800,
    note: "KataGo 官方 5k 拟人配置，棋形与定式接近人类业余爱好者",
  },
  {
    id: "lv5",
    label: "中高",
    rank: "约 2 级",
    backend: BACKEND.HUMAN,
    humanProfile: "preaz_2k",
    maxVisits: 60,
    maxTimeMs: 2000,
    piklLambda: 0.5,
    rootExplore: 0.4,
    note: "开始引入少量搜索，减少明显失误",
  },
  {
    id: "lv6",
    label: "高级",
    rank: "约 1 段",
    backend: BACKEND.HUMAN,
    humanProfile: "preaz_1d",
    maxVisits: 200,
    maxTimeMs: 2500,
    piklLambda: 0.15,
    rootExplore: 0.8,
    note: "人类棋风 + 搜索校验，业余段位水平",
  },
  {
    id: "lv7",
    label: "低段",
    rank: "约 3 段",
    backend: BACKEND.NORMAL,
    maxVisits: 150,
    maxTimeMs: 2500,
    pdA: 0.5,
    note: "标准网络，搜索量适中，棋风开始偏 AI",
  },
  {
    id: "lv8",
    label: "高段",
    rank: "约 5 段",
    backend: BACKEND.NORMAL,
    maxVisits: 500,
    maxTimeMs: 3000,
    note: "业余强豪水平，局部战斗极少失误",
  },
  {
    id: "lv9",
    label: "职业",
    rank: "职业级",
    backend: BACKEND.NORMAL,
    maxVisits: 2000,
    maxTimeMs: 5000,
    note: "职业棋手水平，长时间思考会有强手",
  },
  {
    id: "lv10",
    label: "超人",
    rank: "超越人类",
    backend: BACKEND.NORMAL,
    maxVisits: 12000,
    maxTimeMs: 10000,
    note: "KataGo 全力模式，思考较慢但几乎不出错",
  },
];

export const DEFAULT_LEVEL_ID = "lv4";

export function levelById(id) {
  return LEVELS.find((l) => l.id === id) ?? LEVELS.find((l) => l.id === DEFAULT_LEVEL_ID);
}

/**
 * 该档位需要启动/重启引擎时使用的“配置指纹”。
 * 指纹变化 = 必须重启引擎；否则只用 kata-set-param 热切换。
 */
export function engineProfileKey(level, fast = false) {
  const suffix = fast ? ":fast" : "";
  if (level.backend === BACKEND.HUMAN) {
    return `human:${level.humanProfile}:${level.piklLambda ?? "pure"}:${level.rootExplore ? "explore" : "plain"}${suffix}`;
  }
  return `normal${suffix}`;
}

/** 生成该档位的 GTP 配置内容（config/generated/<key>.cfg） */
export function generateCfg(level, { threads = 6, boardSize = 19, fast = false } = {}) {
  // 用对象累积，同一键后写覆盖先写，避免 KataGo 因重复键拒绝启动
  const cfg = {
    logDir: "gtp_logs",
    logAllGTPCommunication: "false",
    logSearchInfo: "false",
    logSearchInfoForChosenMove: "false",
    logToStderr: "false",
    startupPrintMessageToStderr: "false",
    rules: "chinese",
    defaultBoardSize: boardSize,
    allowResignation: "true",
    resignThreshold: "-0.90",
    resignConsecTurns: 3,
    conservativePass: "true",
    reportAnalysisWinratesAs: "SIDETOMOVE",
    analysisPVLen: 12,
    nnCacheSizePowerOfTwo: 20,
  };

  if (level.backend === BACKEND.HUMAN) {
    const pure = (level.piklLambda ?? Infinity) === Infinity;
    Object.assign(cfg, {
      // 拟人档：弱棋不该轻易认输
      resignThreshold: "-0.99",
      resignConsecTurns: 20,
      resignMinScoreDifference: 40,
      resignMinMovesPerBoardArea: "0.4",
      humanSLProfile: level.humanProfile,
      humanSLChosenMoveProp: "1.0",
      humanSLChosenMoveIgnorePass: "true",
      humanSLChosenMovePiklLambda: pure ? 100000000 : (level.piklLambda ?? 0.08),
      humanSLRootExploreProbWeightless: pure ? "0.0" : (level.rootExplore ?? 0.8),
      humanSLRootExploreProbWeightful: "0.0",
      humanSLPlaExploreProbWeightless: "0.0",
      humanSLPlaExploreProbWeightful: "0.0",
      humanSLOppExploreProbWeightless: "0.0",
      humanSLOppExploreProbWeightful: "0.0",
      humanSLCpuctExploration: "0.50",
      humanSLCpuctPermanent: pure ? "0.2" : "2.0",
      chosenMoveTemperatureEarly: "0.85",
      chosenMoveTemperature: pure ? "0.70" : "0.25",
      chosenMoveTemperatureHalflife: 80,
      chosenMoveTemperatureOnlyBelowProb: "0.01",
      chosenMoveSubtract: 0,
      chosenMovePrune: 0,
      ignorePreRootHistory: "false",
      analysisIgnorePreRootHistory: "false",
      rootNumSymmetriesToSample: 2,
      useLcbForSelection: "false",
      winLossUtilityFactor: "1.0",
      staticScoreUtilityFactor: "0.30",
      dynamicScoreUtilityFactor: "0.00",
      useUncertainty: "false",
      subtreeValueBiasFactor: "0.0",
      useNoisePruning: "false",
      maxVisits: level.maxVisits,
      numSearchThreads: pure ? 1 : threads,
      lagBuffer: "1.0",
      delayMoveScale: fast ? "0" : "0.6",
      delayMoveMax: fast ? "0" : "1.8",
    });
  } else {
    Object.assign(cfg, {
      maxVisits: level.maxVisits,
      numSearchThreads: threads,
      ponderingEnabled: "false",
      maxTimePondering: "30.0",
      lagBuffer: "1.0",
      chosenMoveTemperatureEarly: "0.3",
      chosenMoveTemperature: "0.05",
      searchFactorAfterOnePass: "0.50",
      searchFactorAfterTwoPass: "0.25",
      playoutDoublingAdvantage: level.pdA ?? 0.0,
      rootPolicyTemperature: "1.1",
      nnMaxBatchSize: 8,
    });
  }

  const lines = ["# 由 difficulty.js 自动生成，请勿手工修改"];
  for (const [k, v] of Object.entries(cfg)) lines.push(`${k} = ${v}`);
  return lines;
}

/** 运行时热切换的搜索参数（不触发重启） */
export function runtimeParamsFor(level) {
  return {
    maxVisits: level.maxVisits,
    maxTime: Math.max(0.2, level.maxTimeMs / 1000),
    playoutDoublingAdvantage: level.backend === BACKEND.NORMAL ? (level.pdA ?? 0.0) : 0.0,
  };
}

/** 档位用于 UI 展示的完整描述 */
export function describeLevel(level) {
  return {
    id: level.id,
    label: level.label,
    rank: level.rank,
    note: level.note,
    backend: level.backend,
    maxVisits: level.maxVisits,
    maxTimeMs: level.maxTimeMs,
  };
}
