// SGF 解析/生成单元测试
import assert from 'node:assert/strict';
import { parseSgf, buildSgf, pointToSgf, sgfToPoint } from '../src/shared/sgf.js';

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

console.log('坐标');
t('SGF 坐标与棋盘坐标互转', () => {
  assert.equal(pointToSgf(0, 0), 'aa');
  assert.deepEqual(sgfToPoint('aa', 19), { x: 0, y: 0 });
  assert.deepEqual(sgfToPoint('ss', 19), { x: 18, y: 18 });
  assert.equal(sgfToPoint('', 19), null, '空字符串应为 pass');
});

console.log('解析');
t('基本棋谱：尺寸/贴目/着法', () => {
  const g = parseSgf('(;GM[1]FF[4]SZ[19]KM[7.5]PB[A]PW[B];B[pd];W[dp];B[pp])');
  assert.equal(g.size, 19);
  assert.equal(g.komi, 7.5);
  assert.equal(g.moves.length, 3);
  assert.deepEqual(g.moves[0], { color: 'B', x: 15, y: 3, pass: false, comment: '' });
  assert.deepEqual(g.moves[1], { color: 'W', x: 3, y: 15, pass: false, comment: '' });
});

t('pass 与注释', () => {
  const g = parseSgf('(;SZ[9]KM[6.5];B[ee]C[好棋];W[])');
  assert.equal(g.moves.length, 2);
  assert.equal(g.moves[0].comment, '好棋');
  assert.equal(g.moves[1].pass, true);
});

t('让子（AB）与 HA', () => {
  const g = parseSgf('(;SZ[9]KM[0.5]HA[2]AB[cg][gc];W[ee])');
  assert.equal(g.handicap, 2);
  assert.deepEqual(g.setupBlack, [
    { x: 2, y: 6 }, // cg
    { x: 6, y: 2 }, // gc
  ]);
  assert.equal(g.moves.length, 1);
  assert.equal(g.moves[0].color, 'W');
});

t('转义字符不会被截断', () => {
  const g = parseSgf('(;SZ[9];B[ee]C[括号\\]与反斜杠\\\\结束];W[cc])');
  assert.equal(g.moves.length, 2);
  assert.match(g.moves[0].comment, /括号\]/);
});

t('带分支的棋谱只走主分支', () => {
  const g = parseSgf('(;SZ[9];B[ee](;W[cc];B[gg])(;W[gg]))');
  assert.ok(g.moves.length >= 2, `至少读到主分支前两手，实际 ${g.moves.length}`);
  assert.equal(g.moves[0].color, 'B');
  assert.equal(g.moves[1].color, 'W');
});

console.log('生成');
t('生成后再解析，内容一致', () => {
  const moves = [
    { color: 'B', x: 4, y: 4 },
    { color: 'W', x: 2, y: 6 },
    { color: 'B', x: null, y: null, pass: true },
  ];
  const text = buildSgf({ size: 9, komi: 6.5, moves });
  const g = parseSgf(text);
  assert.equal(g.size, 9);
  assert.equal(g.komi, 6.5);
  assert.equal(g.moves.length, 3);
  assert.deepEqual(g.moves[0], { color: 'B', x: 4, y: 4, pass: false, comment: '' });
  assert.equal(g.moves[2].pass, true);
});

t('让子棋谱生成包含 HA/AB', () => {
  const text = buildSgf({
    size: 9,
    komi: 0.5,
    handicapStones: [
      { x: 2, y: 2 },
      { x: 6, y: 6 },
    ],
    moves: [{ color: 'W', x: 4, y: 4 }],
  });
  assert.match(text, /HA\[2\]/);
  assert.match(text, /AB\[cc\]\[gg\]/);
  const g = parseSgf(text);
  assert.equal(g.handicap, 2);
  assert.equal(g.setupBlack.length, 2);
});

console.log(`\n通过 ${pass} 项`);
