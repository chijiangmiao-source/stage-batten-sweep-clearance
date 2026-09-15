import { describe, expect, it } from 'vitest';
import { computeEnvelope, validateEnvelopeRequest } from './envelope';
import {
  addRat,
  compareRat,
  crossRat,
  formatRat,
  mulRat,
  rat,
  subRat,
  subRatPoint,
  type Rat,
  type RatPoint
} from './rational';
import type { ValidBoom } from './validation';

const squareCW = [
  { x: -30n, y: 15n },
  { x: 30n, y: 15n },
  { x: 30n, y: -15n },
  { x: -30n, y: -15n }
];

function boom(keyframes: ValidBoom['keyframes'], vertices = squareCW): ValidBoom {
  return { vertices, keyframes };
}

/** 有向二倍面积（Rat）：顺时针为负、逆时针为正。 */
function signedArea2(vertices: RatPoint[]): Rat {
  let acc = rat(0n);
  const n = vertices.length;
  for (let i = 0; i < n; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    acc = addRat(acc, subRat(mulRat(a.x, b.y), mulRat(a.y, b.x)));
  }
  return acc;
}

describe('straight sweep envelope', () => {
  it('builds the exact swept rectangle of a translating box across one keyframe segment', () => {
    const moving = boom([
      { t: 0n, x: 200n, y: 200n },
      { t: 1000n, x: 300n, y: 200n }
    ]);
    const result = computeEnvelope(moving, 0, 0n, 1000n);

    expect(result.holes).toHaveLength(0);
    expect(result.outerLoops).toHaveLength(1);
    // Area = base area 60*30 + length 100 * height 30 = 1800 + 3000 = 4800.
    expect(formatRat(result.area)).toBe('4800');

    const loop = result.outerLoops[0];
    const vertices = loop.vertices;
    // 扫掠矩形的长边按来源分成三段：起始轮廓边、顶点位移轨迹（桥接）、
    // 终止轮廓边；共线中间点予以保留，使每条输出边都对应唯一源特征。
    const xs = vertices.map((p) => formatRat(p.x)).sort();
    const ys = vertices.map((p) => formatRat(p.y)).sort();
    expect(xs).toEqual(['170', '170', '230', '230', '270', '270', '330', '330']);
    expect(ys).toEqual(['185', '185', '185', '185', '215', '215', '215', '215']);

    // 外环顺时针：每个转角非正，整体有向面积为负。
    const n = vertices.length;
    for (let i = 0; i < n; i += 1) {
      const a = vertices[i];
      const b = vertices[(i + 1) % n];
      const c = vertices[(i + 2) % n];
      expect(compareRat(crossRat(subRatPoint(b, a), subRatPoint(c, b)), rat(0n)) <= 0).toBe(true);
    }
    expect(compareRat(signedArea2(vertices), rat(0n)) < 0).toBe(true);
  });

  it('clips the sweep at endpoints falling between keyframes and reuses the endpoint pose', () => {
    const moving = boom([
      { t: 0n, x: 200n, y: 200n },
      { t: 1000n, x: 400n, y: 200n },
      { t: 2000n, x: 400n, y: 400n }
    ]);
    // 250ms 时锚点 250；首段扫到 1000ms 的锚点 400（x 方向 150），
    // 第二段 1000→1500 锚点 y 200→300（y 方向 100）。
    const result = computeEnvelope(moving, 0, 250n, 1500n);
    expect(result.holes).toHaveLength(0);
    // 6300 + 7800 - 公共 60*30 = 12300。
    expect(formatRat(result.area)).toBe('12300');
    expect(result.outerLoops).toHaveLength(1);
  });

  it('holds the endpoint pose before the first / after the last keyframe', () => {
    const moving = boom([
      { t: 100n, x: 200n, y: 200n },
      { t: 200n, x: 300n, y: 200n }
    ]);
    const held = computeEnvelope(moving, 0, 0n, 200n);
    const plain = computeEnvelope(moving, 0, 100n, 200n);
    expect(formatRat(held.area)).toBe(formatRat(plain.area));
    expect(held.outerLoops).toHaveLength(1);
    expect(held.holes).toHaveLength(0);
  });

  it('keeps endpoints between keyframes exactly rational, including fractional area', () => {
    // 面积为 2 的三角形，高（y 方向跨距）为 2；t∈[0,3] 内 x 位移 1 mm。
    const triangleCW = [
      { x: 0n, y: 1n },
      { x: 1n, y: -1n },
      { x: -1n, y: -1n }
    ];
    const moving = boom(
      [
        { t: 0n, x: 200n, y: 200n },
        { t: 3n, x: 201n, y: 200n }
      ],
      triangleCW
    );
    // 区间 0..1：位移恰为 1/3 mm；扫掠面积 = 2 + (1/3)·2 = 8/3。
    const result = computeEnvelope(moving, 0, 0n, 1n);
    expect(formatRat(result.area)).toBe('8/3');
    expect(result.outerLoops).toHaveLength(1);
    expect(result.holes).toHaveLength(0);
    // 顶点坐标保持精确分数，不出现浮点尾数。
    const fractions = result.outerLoops[0].vertices.map((p) => `${formatRat(p.x)},${formatRat(p.y)}`);
    for (const text of fractions) {
      expect(text).toMatch(/^-?\d+(\/\d+)?,-?\d+(\/\d+)?$/);
    }
  });

  it('supports a zero-length interval: the envelope is the polygon itself', () => {
    const moving = boom([
      { t: 0n, x: 200n, y: 200n },
      { t: 1000n, x: 300n, y: 200n }
    ]);
    const result = computeEnvelope(moving, 0, 700n, 700n);
    expect(formatRat(result.area)).toBe('1800');
    expect(result.outerLoops).toHaveLength(1);
    expect(result.outerLoops[0].vertices).toHaveLength(4);
  });

  it('supports a diagonal translation with slanted vertex trajectories', () => {
    const moving = boom([
      { t: 0n, x: 200n, y: 200n },
      { t: 1000n, x: 300n, y: 300n }
    ]);
    const result = computeEnvelope(moving, 0, 0n, 1000n);
    expect(result.holes).toHaveLength(0);
    expect(result.outerLoops).toHaveLength(1);
    // area = base 1800 + |dx|·30 + |dy|·60 = 1800 + 3000 + 6000 = 10800.
    expect(formatRat(result.area)).toBe('10800');
    // All vertex-trajectory edges connect the same local vertex across poses.
    const vertexEdges = result.edges.filter((e) => e.feature.kind === 'vertex');
    expect(vertexEdges.length).toBeGreaterThanOrEqual(2);
  });

  it('tags every edge with its source keyframe segment and profile feature', () => {
    const moving = boom([
      { t: 0n, x: 200n, y: 200n },
      { t: 1000n, x: 300n, y: 200n }
    ]);
    const result = computeEnvelope(moving, 0, 0n, 1000n);
    expect(result.edges).toHaveLength(result.outerLoops[0].edgeIds.length);
    const featureKinds = result.edges.map((edge) => edge.feature.kind);
    expect(featureKinds).toContain('edge');
    expect(featureKinds).toContain('vertex');
    for (const edge of result.edges) {
      expect(edge.segment).toBe(0);
      expect(formatRat(edge.segmentStart)).toBe('0');
      expect(formatRat(edge.segmentEnd)).toBe('1000');
      expect(edge.feature.index).toBeGreaterThanOrEqual(0);
    }
    const earliest = result.edges.reduce(
      (best, edge) => (compareRat(edge.firstTime, best) < 0 ? edge.firstTime : best),
      result.edges[0].firstTime
    );
    expect(formatRat(earliest)).toBe('0');
  });
});

describe('backtrack and overlapping sweeps', () => {
  it('folds a retracing motion into one strip without duplicated zero-length edges', () => {
    const moving = boom([
      { t: 0n, x: 200n, y: 200n },
      { t: 100n, x: 300n, y: 200n },
      { t: 200n, x: 200n, y: 200n }
    ]);
    const result = computeEnvelope(moving, 0, 0n, 200n);
    expect(result.outerLoops).toHaveLength(1);
    expect(result.holes).toHaveLength(0);
    expect(formatRat(result.area)).toBe('4800');
    for (const edge of result.edges) {
      const degenerate =
        compareRat(edge.from.x, edge.to.x) === 0 && compareRat(edge.from.y, edge.to.y) === 0;
      expect(degenerate).toBe(false);
    }
    const vertices = result.outerLoops[0].vertices;
    expect(new Set(vertices.map((p) => `${formatRat(p.x)},${formatRat(p.y)}`)).size).toBe(vertices.length);
  });

  it('unions perpendicular strips into an L-shaped result', () => {
    const moving = boom([
      { t: 0n, x: 200n, y: 200n },
      { t: 100n, x: 300n, y: 200n },
      { t: 200n, x: 300n, y: 300n }
    ]);
    const result = computeEnvelope(moving, 0, 0n, 200n);
    // 横条带 4800（160x30），竖条带 7800（60x130），公共 60x30=1800。
    expect(formatRat(result.area)).toBe('10800');
    expect(result.outerLoops).toHaveLength(1);
    expect(result.holes).toHaveLength(0);
  });
});

describe('closed loop with a hole', () => {
  it('keeps a counter-clockwise hole when swept strips form a closed ring', () => {
    const ring = [
      { x: -60n, y: 10n },
      { x: 60n, y: 10n },
      { x: 60n, y: -10n },
      { x: -60n, y: -10n }
    ];
    // 锚点沿 200x200 顺时针方形路径行走，四条扫掠条带围出中央孔洞。
    const moving = boom(
      [
        { t: 0n, x: 300n, y: 400n },
        { t: 100n, x: 500n, y: 400n },
        { t: 200n, x: 500n, y: 200n },
        { t: 300n, x: 300n, y: 200n },
        { t: 400n, x: 300n, y: 400n }
      ],
      ring
    );
    const result = computeEnvelope(moving, 0, 0n, 400n);
    expect(result.holes.length).toBeGreaterThanOrEqual(1);

    const outerArea2 = signedArea2(result.outerLoops[0].vertices);
    expect(compareRat(outerArea2, rat(0n)) < 0).toBe(true); // 外环顺时针
    let holeArea2 = rat(0n);
    for (const hole of result.holes) {
      const area = signedArea2(hole.vertices);
      expect(compareRat(area, rat(0n)) > 0).toBe(true); // 孔洞逆时针
      holeArea2 = addRat(holeArea2, area);
    }

    // 精确面积 = 外环面积 - 孔洞面积。
    const expectedArea = mulRat(subRat(negLike(outerArea2), holeArea2), rat(1n, 2n));
    expect(formatRat(result.area)).toBe(formatRat(expectedArea));
    // 外环包围盒 320x220=70400；中央孔洞为 80 x 180 = 14400。
    expect(formatRat(mulRat(holeArea2, rat(1n, 2n)))).toBe('14400');
    expect(formatRat(result.area)).toBe('56000');
  });
});

function negLike(value: Rat): Rat {
  return { n: -value.n, d: value.d };
}

describe('envelope request validation', () => {
  const interval = { start: rat(0n), end: rat(1000n) };

  it('accepts integer in-range ordered bounds', () => {
    const { request, errors } = validateEnvelopeRequest('0', '100', '900', interval);
    expect(errors).toEqual([]);
    expect(request).toEqual({ boom: 0, start: 100n, end: 900n });
  });

  it('selects the boom from the selector value', () => {
    const { request } = validateEnvelopeRequest('1', '0', '1000', interval);
    expect(request?.boom).toBe(1);
  });

  it('rejects non-integer, reversed and out-of-range bounds and reports the start field first', () => {
    const bad = validateEnvelopeRequest('0', '1.5', '900', interval);
    expect(bad.request).toBeNull();
    expect(bad.errors[0].path).toBe('envelope.start');

    const reversed = validateEnvelopeRequest('0', '900', '100', interval);
    expect(reversed.errors[0].path).toBe('envelope.start');
    expect(reversed.errors.some((e) => e.message.includes('不得晚于'))).toBe(true);

    const outOfRange = validateEnvelopeRequest('0', '-1', '1001', interval);
    expect(outOfRange.errors.some((e) => e.path === 'envelope.start')).toBe(true);
    expect(outOfRange.errors.some((e) => e.path === 'envelope.end')).toBe(true);

    const endBad = validateEnvelopeRequest('0', '0', 'x', interval);
    expect(endBad.errors[0].path).toBe('envelope.end');
  });
});
