/**
 * 冒烟测试：验证引擎接入的每一个关键环节
 *   node scripts/smoke-test.mjs [exe路径]
 */
import { mkdir, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GtpEngine, parseGenmoveAnalyze } from "../src/main/gtp.js";
import { levelById, generateCfg, engineProfileKey } from "../src/main/difficulty.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEIGHTS = path.join(ROOT, "engine", "weights");
const MODEL = path.join(WEIGHTS, "b18c384nbt.bin.gz");
const HUMAN_MODEL = path.join(WEIGHTS, "b18c384nbt-humanv0.bin.gz");
const CFG_DIR = path.join(ROOT, "config", "generated");

const CANDIDATES = [process.argv[2], path.join(ROOT, "engine", "katago.exe"), path.join(ROOT, "engine", "cpu", "katago.exe")]
  .filter(Boolean)
  .map((p) => path.resolve(ROOT, p));

const log = (...a) => console.log(...a);
const section = (t) => log(`\n########## ${t}`);

async function startEngine({ exe, configPath, modelPath, humanModelPath = null }) {
  const engine = new GtpEngine({ exe, configPath, modelPath, humanModelPath, cwd: path.dirname(exe) });
  try {
    const hs = await engine.start();
    return { engine, hs };
  } catch (err) {
    log("  引擎 stderr（最后 8 行）：");
    for (const l of engine.lastStderr.slice(-8)) log(`    | ${l}`);
    try {
      await engine.stop();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

async function main() {
  await mkdir(CFG_DIR, { recursive: true });
  for (const p of [MODEL, HUMAN_MODEL]) log(`${existsSync(p) ? "OK  " : "MISS"} ${path.basename(p)}`);

  const normalLevel = levelById("lv8");
  const humanLevel = levelById("lv4");
  const normalCfg = path.join(CFG_DIR, "smoke-normal.cfg");
  const humanCfg = path.join(CFG_DIR, "smoke-human.cfg");
  await writeFile(normalCfg, generateCfg(normalLevel, { threads: 4 }).join("\n") + "\n");
  await writeFile(humanCfg, generateCfg(humanLevel, { threads: 4 }).join("\n") + "\n");

  section("1. 启动引擎（CUDA → CPU 回退）");
  let engine = null;
  let usedExe = null;
  const errs = [];
  for (const exe of CANDIDATES) {
    try {
      const r = await startEngine({ exe, configPath: normalCfg, modelPath: MODEL });
      engine = r.engine;
      usedExe = exe;
      log(`  成功: ${path.basename(path.dirname(exe))}/${path.basename(exe)}`);
      log(`  握手: ${JSON.stringify(r.hs)}`);
      break;
    } catch (err) {
      errs.push(`${exe}: ${err.message}`);
    }
  }
  if (!engine) {
    log("全部候选失败:\n  " + errs.join("\n  "));
    process.exit(1);
  }

  section("2. 可用 GTP 命令（关键子集）");
  const cmds = (await engine.command("list_commands", 20000)).split(/\s+/).filter(Boolean);
  const interesting = cmds.filter((c) => /kata|genmove|analy|undo|final|param|rules|score|handicap|time/.test(c));
  log(`  共 ${cmds.length} 条，关键命令: ${interesting.join(" ")}`);

  section("3. kata-set-param 支持哪些参数");
  for (const cmd of [
    "kata-set-param bogusParamXYZ 1",
    "kata-set-param maxVisits 100",
    "kata-set-param maxTime 2.0",
    "kata-set-param playoutDoublingAdvantage 0.5",
    "kata-set-param wideRootNoise 0.02",
    "kata-set-param rootPolicyTemperature 1.05",
    "kata-set-param humanSLProfile rank_5k",
    "kata-set-param humanSLChosenMoveProp 0.5",
    "kata-get-param maxVisits",
  ]) {
    try {
      const r = await engine.command(cmd, 20000);
      log(`  OK   ${cmd}  ->  ${String(r).slice(0, 200)}`);
    } catch (err) {
      log(`  ERR  ${cmd}  ->  ${err.message.slice(0, 160)}`);
    }
  }

  section("4. 9 路对局与 genmove");
  await engine.commands(["boardsize 9", "komi 6.5", "clear_board"], 20000);
  for (const mv of ["play B E5", "play W C3", "play B G7"]) await engine.command(mv, 20000);
  const t0 = Date.now();
  const move = await engine.command("genmove W", 120000);
  log(`  genmove W -> ${move}   (${Date.now() - t0}ms)`);
  log(`  final_score -> ${await engine.command("final_score", 30000)}`);

  section("5. kata-genmove_analyze 结构化解析");
  await engine.command("clear_board", 20000);
  await engine.commands(["play B E5", "play W E3", "play B C5"], 20000);
  const tA = Date.now();
  try {
    const raw = await engine.command("kata-genmove_analyze W interval 100 ownership true", 120000);
    fs.writeFileSync(".tmp/analyze-raw.txt", raw, "utf8");
    const { move: best, infos } = parseGenmoveAnalyze(raw);
    log(`  着法=${best}  候选 ${infos.length} 个  (${Date.now() - tA}ms)`);
    for (const i of infos.slice(0, 5)) {
      log(
        `    ${i.move}  visits=${i.visits}  winrate=${(i.winrate * 100).toFixed(1)}%  scoreLead=${i.scoreLead?.toFixed(1)}  prior=${(i.prior * 100).toFixed(1)}%`,
      );
    }
    // ownership 行是否出现在正文里
    const hasOwnership = /ownership/i.test(raw);
    log(`  正文含 ownership 数据: ${hasOwnership}`);
  } catch (err) {
    log(`  失败: ${err.message}`);
  }

  section("6. 拟人档位（human SL）");
  await engine.stop();
  try {
    const r = await startEngine({ exe: usedExe, configPath: humanCfg, modelPath: MODEL, humanModelPath: HUMAN_MODEL });
    const h = r.engine;
    log(`  启动成功 profile=${engineProfileKey(humanLevel)}  握手=${JSON.stringify(r.hs)}`);
    await h.commands(["boardsize 9", "komi 6.5", "clear_board"], 20000);
    // 让引擎自己走几步（黑白轮流），验证拟人着法分布
    for (let i = 0; i < 6; i++) {
      const color = i % 2 === 0 ? "B" : "W";
      const mv = await h.command(`genmove ${color}`, 60000);
      log(`  拟人 genmove ${color} -> ${mv}`);
      if (/pass/i.test(mv)) break;
    }
    await h.stop();
    log("  拟人档验证完成");
  } catch (err) {
    log(`  拟人档失败: ${err.message}`);
  }

  log("\n冒烟测试结束");
}

process.on("exit", () => {});
main().catch((err) => {
  console.error("测试异常:", err);
  process.exit(1);
});
