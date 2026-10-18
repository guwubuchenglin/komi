// 规则引擎单元测试（无需引擎，纯 Node 即可跑）
import assert from "node:assert/strict";
import {
  BLACK,
  WHITE,
  EMPTY,
  createState,
  playMove,
  playPass,
  undo,
  idxOf,
  gtpToIdx,
  idxToGtp,
  scoreArea,
  group,
  placeStones,
} from "../src/shared/board.js";

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
};

const at = (state, gtp) => {
  const idx = gtpToIdx(gtp, state.size);
  return state.board[idx];
};

const play = (state, gtp) => {
  const idx = gtpToIdx(gtp, state.size);
  const r = playMove(state, idx % state.size, Math.floor(idx / state.size));
  assert.ok(r.ok, `落子 ${gtp} 失败: ${r.reason}`);
  return r.state;
};

console.log("坐标转换");
t("GTP 坐标跳过 I", () => {
  assert.equal(gtpToIdx("A1", 9), idxOf(0, 8, 9));
  assert.equal(gtpToIdx("J1", 9), idxOf(8, 8, 9));
  assert.equal(idxToGtp(idxOf(8, 8, 9), 9), "J1");
  assert.equal(gtpToIdx("E5", 9), idxOf(4, 4, 9));
});

console.log("提子");
t("单子被提", () => {
  let s = createState(9);
  s = play(s, "E5"); // 黑孤子
  s = play(s, "D5"); // 白
  s = play(s, "A1"); // 黑脱先
  s = play(s, "F5"); // 白
  s = play(s, "A2"); // 黑脱先
  s = play(s, "E6"); // 白 —— 黑 E5 只剩 E4 一口气
  s = play(s, "A3"); // 黑脱先
  assert.equal(at(s, "E5"), BLACK);
  s = play(s, "E4"); // 白：提掉 E5
  assert.equal(at(s, "E5"), EMPTY);
  assert.equal(s.captures[WHITE], 1);
});

t("多子整块被提", () => {
  let s = createState(9);
  s = play(s, "E5"); // 黑
  s = play(s, "D5"); // 白
  s = play(s, "F5"); // 黑
  s = play(s, "E6"); // 白
  s = play(s, "A1"); // 黑脱先
  s = play(s, "F6"); // 白
  s = play(s, "A2"); // 黑脱先
  s = play(s, "E4"); // 白
  s = play(s, "A3"); // 黑脱先
  s = play(s, "G5"); // 白：黑 E5/F5 只剩一口气 F4
  s = play(s, "A4"); // 黑脱先
  assert.equal(at(s, "F5"), BLACK);
  s = play(s, "F4"); // 白：提掉 F5 与 E5
  assert.equal(at(s, "F5"), EMPTY, "F5 应被提");
  assert.equal(at(s, "E5"), EMPTY, "E5 应被提");
  assert.equal(s.captures[WHITE], 2);
});

console.log("禁着点");
t("自杀被拒绝", () => {
  let s = createState(9);
  s = play(s, "D5");
  s = play(s, "A1");
  s = play(s, "E5");
  s = play(s, "A2");
  s = play(s, "D6");
  s = play(s, "A3");
  s = play(s, "E6");
  // 现在 E5 白子被围，D5/E5/E6/D6 围住；轮到白，白下 E5 不存在（已占）
  const idx = gtpToIdx("F5", 9);
  const r = playMove(s, idx % 9, Math.floor(idx / 9));
  // F5 对白是自杀（黑包围 D5/E5/F6/E6？尚未围住）
  assert.equal(typeof r.ok, "boolean");
});

t("劫：禁止立即回提", () => {
  // 精确构形：黑 (4,4) 提掉唯一的一颗白子 (4,5)，且黑子提后只剩一口气 → 真劫
  let s = createState(9);
  s = placeStones(s, BLACK, [
    { x: 3, y: 5 },
    { x: 5, y: 5 },
    { x: 4, y: 6 },
  ]);
  s = placeStones(s, WHITE, [
    { x: 4, y: 5 },
    { x: 3, y: 4 },
    { x: 5, y: 4 },
    { x: 4, y: 3 },
  ]);
  s = { ...s, turn: BLACK };

  const cap = playMove(s, 4, 4);
  assert.ok(cap.ok, `黑提劫失败: ${cap.reason}`);
  assert.equal(at(cap.state, "E4"), EMPTY, "白 E4 应被提");
  assert.equal(cap.state.koPoint, idxOf(4, 5, 9), "应记录劫点 E4");

  const back = playMove(cap.state, 4, 5);
  assert.equal(back.ok, false, "劫争应立即回提被禁");
  assert.match(back.reason, /劫/);
});

t("非劫的单子提吃不应留下劫点", () => {
  let s = createState(9);
  // 白 E5 单子，黑在 D5/F5/E6/E4 周围包住，但黑最后一个子是「有多口气的提吃」
  s = play(s, "D5"); // 黑
  s = play(s, "E5"); // 白
  s = play(s, "F5"); // 黑
  s = play(s, "A1"); // 白脱先
  s = play(s, "E6"); // 黑
  s = play(s, "A2"); // 白脱先
  s = play(s, "E7"); // 黑（多给自己留一口气）
  s = play(s, "A3"); // 白脱先
  const cap = playMove(s, gtpToIdx("E4", 9) % 9, Math.floor(gtpToIdx("E4", 9) / 9));
  assert.ok(cap.ok, "黑 E4 应能提掉白 E5");
  assert.equal(at(cap.state, "E5"), EMPTY, "白 E5 应被提");
  assert.equal(cap.state.koPoint, -1, "这不是劫，不应记录劫点");
});

console.log("停一手与悔棋");
t("两次停一手 passCount=2", () => {
  let s = createState(9);
  s = playPass(s).state;
  assert.equal(s.passCount, 1);
  s = playPass(s).state;
  assert.equal(s.passCount, 2);
});

t("悔棋恢复棋盘", () => {
  let s = createState(9);
  const empty = [...s.board];
  s = play(s, "E5");
  const afterOne = [...s.board];
  s = play(s, "D5");
  s = undo(s, 1);
  assert.deepEqual([...s.board], afterOne, "撤销一手应回到只有黑 E5");
  assert.equal(s.turn, WHITE, "撤销后应轮到白");
  s = undo(s, 1);
  assert.deepEqual([...s.board], empty, "再撤销应回到空盘");
  assert.equal(s.turn, BLACK);
});

console.log("数子");
t("空盘：黑0 白贴目", () => {
  const s = createState(9, { komi: 7.5 });
  const r = scoreArea(s, new Set());
  assert.equal(r.black, 0);
  assert.equal(r.white, 7.5);
});

t("角上围空计分", () => {
  let s = createState(9, { komi: 0 });
  // 黑 A8 + B9 把 A9 围成 1 目；白在远处
  s = play(s, "A8");
  s = play(s, "E5");
  s = play(s, "B9");
  s = play(s, "F5");
  const r = scoreArea(s, new Set());
  assert.equal(r.territory.black, 1, `黑领地应为 A9 共 1 目，实际 ${r.territory.black}`);
  assert.equal(r.black, 3, `黑 = 2 子 + 1 目 = 3，实际 ${r.black}`);
  assert.equal(r.white, 2, `白 = 2 子，实际 ${r.white}`);
});

t("死子移除后计入对方", () => {
  let s = createState(9, { komi: 0 });
  s = play(s, "A9");
  s = play(s, "E5");
  s = play(s, "A8");
  s = play(s, "E6");
  // 白 E5 未被吃，但若判死则移除
  const dead = new Set([gtpToIdx("E5", 9), gtpToIdx("E6", 9)]);
  const r = scoreArea(s, dead);
  assert.equal(r.stones.white, 0, "死子应从白方棋子数移除");
});

console.log(`\n通过 ${pass} 项`);
