import {
  addRat,
  compareRat,
  crossRat,
  divRat,
  formatRat,
  mulRat,
  negRat,
  rat,
  reduce,
  rOne,
  rZero,
  subRat,
  type Rat,
  type RatPoint
} from './rational';
import { framePosition } from './collision';
import type { ValidBoom } from './validation';

/**
 * 占用包络：一根吊杆在闭回放区间 [start, end] 内扫过的地面区域。
 *
 * 每个相邻关键帧（或区间端点）分段内吊杆做匀速平移，凸轮廓沿位移线段
 * 扫掠出的区域仍是凸集（用精确凸包求其边界）；对各段扫掠多边形做
 * bigint 有理数精确平面并集，输出顺时针外环、逆时针孔洞，以及每条输出
 * 边对应的源关键帧段与轮廓顶点/边。全程不使用浮点。
 */

export type EnvelopeFeature =
  | { kind: 'edge'; index: number }
  | { kind: 'vertex'; index: number };

export interface EnvelopeEdge {
  id: number;
  from: RatPoint;
  to: RatPoint;
  boom: 0 | 1;
  /** 源关键帧段序号（区间内按时间排序，从 0 起）。 */
  segment: number;
  segmentStart: Rat;
  segmentEnd: Rat;
  feature: EnvelopeFeature;
  /** 该输出边对应的源轮廓特征首次出现的最早精确时刻。 */
  firstTime: Rat;
}

export interface EnvelopeLoop {
  kind: 'outer' | 'hole';
  /** 从字典序最小顶点起沿环方向排列的顶点，末边回到首顶点。 */
  vertices: RatPoint[];
  edgeIds: number[];
}

export interface EnvelopeResult {
  boom: 0 | 1;
  start: Rat;
  end: Rat;
  area: Rat;
  outerLoops: EnvelopeLoop[];
  holes: EnvelopeLoop[];
  edges: EnvelopeEdge[];
}

interface SourceRef {
  boom: 0 | 1;
  segment: number;
  segmentStart: Rat;
  segmentEnd: Rat;
  kind: 'edge' | 'vertex';
  index: number;
  /** 该源特征（在输出边所在世界位置）首次出现的精确时刻。 */
  firstTime: Rat;
}

interface RawEdge {
  a: RatPoint;
  b: RatPoint;
  source: SourceRef;
  box: boolean;
}

interface HullPoint {
  p: RatPoint;
  /** 该世界点同时是哪些姿态的哪个局部顶点。 */
  tags: Array<{ pose: 0 | 1; index: number }>;
}

const SYNTHETIC_SOURCE: SourceRef = {
  boom: 0,
  segment: -1,
  segmentStart: rZero(),
  segmentEnd: rZero(),
  kind: 'edge',
  index: -1,
  firstTime: rZero()
};

function canonPoint(p: RatPoint): RatPoint {
  return { x: reduce(p.x), y: reduce(p.y) };
}

function pointKey(p: RatPoint): string {
  const x = reduce(p.x);
  const y = reduce(p.y);
  return `${x.n}/${x.d}|${y.n}/${y.d}`;
}

function pointsEqual(a: RatPoint, b: RatPoint): boolean {
  return compareRat(a.x, b.x) === 0 && compareRat(a.y, b.y) === 0;
}

function addPoints(a: RatPoint, b: RatPoint): RatPoint {
  return { x: addRat(a.x, b.x), y: addRat(a.y, b.y) };
}

function subPoints(a: RatPoint, b: RatPoint): RatPoint {
  return { x: subRat(a.x, b.x), y: subRat(a.y, b.y) };
}

function scalePoint(a: RatPoint, k: Rat): RatPoint {
  return { x: mulRat(a.x, k), y: mulRat(a.y, k) };
}

function dotPoints(a: RatPoint, b: RatPoint): Rat {
  return addRat(mulRat(a.x, b.x), mulRat(a.y, b.y));
}

function comparePointsLex(a: RatPoint, b: RatPoint): number {
  const x = compareRat(a.x, b.x);
  return x !== 0 ? x : compareRat(a.y, b.y);
}

/**
 * 构造一个分段内凸轮廓沿位移线段扫掠的边界环（顺时针）。
 * 扫掠体即 {p0}∪{p1} 的凸包；凸包上的共线中间点予以保留，以携带
 * “轮廓边平行于位移”时该轮廓边的来源。
 */
function buildSegmentRing(
  boom: ValidBoom,
  boomIndex: 0 | 1,
  t0: Rat,
  t1: Rat,
  segmentIndex: number
): RawEdge[] {
  const q0 = framePosition(boom, t0);
  const q1 = framePosition(boom, t1);
  const m = boom.vertices.length;
  const source = (kind: 'edge' | 'vertex', index: number, firstTime: Rat): SourceRef => ({
    boom: boomIndex,
    segment: segmentIndex,
    segmentStart: t0,
    segmentEnd: t1,
    kind,
    index,
    firstTime
  });
  const world = (q: RatPoint, i: number): RatPoint =>
    addPoints(q, { x: rat(boom.vertices[i].x), y: rat(boom.vertices[i].y) });

  // 零位移：扫掠退化为轮廓本身，按录入的顺时针环输出一次。
  if (pointsEqual(q0, q1)) {
    const edges: RawEdge[] = [];
    for (let i = 0; i < m; i += 1) {
      edges.push({
        a: world(q0, i),
        b: world(q0, (i + 1) % m),
        source: source('edge', i, t0),
        box: false
      });
    }
    return edges;
  }

  const p0 = boom.vertices.map((_, i) => canonPoint(world(q0, i)));
  const p1 = boom.vertices.map((_, i) => canonPoint(world(q1, i)));

  // 收集两姿态顶点并按世界坐标合并重合点（保留双重来源标签）。
  const merged = new Map<string, HullPoint>();
  const addHullPoint = (p: RatPoint, pose: 0 | 1, index: number) => {
    const key = pointKey(p);
    const existing = merged.get(key);
    if (existing) existing.tags.push({ pose, index });
    else merged.set(key, { p, tags: [{ pose, index }] });
  };
  p0.forEach((p, i) => addHullPoint(p, 0, i));
  p1.forEach((p, i) => addHullPoint(p, 1, i));
  const hullPoints = [...merged.values()].sort((a, b) => comparePointsLex(a.p, b.p));

  // 单调链凸包（逆时针），保留共线边界点（cross==0 时不弹栈）。
  const turn = (o: HullPoint, a: HullPoint, b: HullPoint): Rat =>
    crossRat(subPoints(a.p, o.p), subPoints(b.p, o.p));
  const lower: HullPoint[] = [];
  for (const point of hullPoints) {
    while (lower.length >= 2 && compareRat(turn(lower[lower.length - 2], lower[lower.length - 1], point), rZero()) < 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: HullPoint[] = [];
  for (let i = hullPoints.length - 1; i >= 0; i -= 1) {
    const point = hullPoints[i];
    while (upper.length >= 2 && compareRat(turn(upper[upper.length - 2], upper[upper.length - 1], point), rZero()) < 0) {
      upper.pop();
    }
    upper.push(point);
  }
  const ccwHull = lower.slice(0, -1).concat(upper.slice(0, -1));

  const findTag = (point: HullPoint, pose: 0 | 1): number | null => {
    const tag = point.tags.find((value) => value.pose === pose);
    return tag ? tag.index : null;
  };

  // 每条逆时针凸包边的来源：
  //  - 同姿态且沿凸包方向相邻（相对录入的顺时针后退一条）=> 轮廓边；
  //  - 同局部顶点跨两姿态 => 顶点位移轨迹（最早出现于 t0）；
  //  - 两姿态共线轮廓边之间的“桥接”段（平行于位移的轮廓边扫出的
  //    边界中段）：继承该轮廓边，最早时刻由精确插值求出。
  const profileMatch = (
    from: HullPoint,
    to: HullPoint
  ): { edgeIndex: number; pose: 0 | 1 } | null => {
    for (const pose of [0, 1] as const) {
      const fromIndex = findTag(from, pose);
      const toIndex = findTag(to, pose);
      if (fromIndex === null || toIndex === null) continue;
      // 凸包逆时针，轮廓录入为顺时针，沿轮廓边方向是下标后退。
      if ((fromIndex - 1 + m) % m === toIndex) return { edgeIndex: toIndex, pose };
    }
    return null;
  };

  const velocity = subPoints(q1, q0);
  const velocitySquared = dotPoints(velocity, velocity);

  const ccwSources: SourceRef[] = [];
  for (let i = 0; i < ccwHull.length; i += 1) {
    const from = ccwHull[i];
    const to = ccwHull[(i + 1) % ccwHull.length];
    const matched = profileMatch(from, to);
    if (matched) {
      ccwSources.push(source('edge', matched.edgeIndex, matched.pose === 0 ? t0 : t1));
      continue;
    }
    const trajectoryTag = from.tags.find((tag) =>
      to.tags.some((other) => other.pose !== tag.pose && other.index === tag.index)
    );
    if (trajectoryTag) {
      ccwSources.push(source('vertex', trajectoryTag.index, t0));
      continue;
    }

    // 桥接段：两姿态共线轮廓边之间、由该边扫出的边界中段。几何上每个点
    // 首次成为边界都经由该边两端顶点之一的位移轨迹，取其中最早者，把该段
    // 归到对应的源轮廓顶点。
    let inheritedEdge: number | null = null;
    const collinearWith = (a: HullPoint, b: HullPoint, c: RatPoint) =>
      compareRat(crossRat(subPoints(b.p, a.p), subPoints(c, a.p)), rZero()) === 0;
    for (let step = 1; step < ccwHull.length && inheritedEdge === null; step += 1) {
      for (const direction of [-1, 1]) {
        const j = (i + direction * step + ccwHull.length) % ccwHull.length;
        const a = ccwHull[j];
        const b = ccwHull[(j + 1) % ccwHull.length];
        if (!collinearWith(a, b, from.p)) continue;
        const candidate = profileMatch(a, b);
        if (candidate) {
          inheritedEdge = candidate.edgeIndex;
          break;
        }
      }
    }
    const edgeIndex = inheritedEdge ?? 0;
    // 该轮廓边两端局部顶点；对输出段两端点分别求沿各顶点轨迹的时间参数。
    const endpointIndices = [edgeIndex, (edgeIndex + 1) % m];
    let bestVertex = endpointIndices[0];
    let bestTime: Rat | null = null;
    for (const worldPoint of [from.p, to.p]) {
      for (const localIndex of endpointIndices) {
        const local = { x: rat(boom.vertices[localIndex].x), y: rat(boom.vertices[localIndex].y) };
        let tau = divRat(dotPoints(subPoints(subPoints(worldPoint, q0), local), velocity), velocitySquared);
        tau = compareRat(tau, rZero()) < 0 ? rZero() : compareRat(tau, rOne()) > 0 ? rOne() : tau;
        const time = addRat(t0, mulRat(subRat(t1, t0), tau));
        if (bestTime === null || compareRat(time, bestTime) < 0) {
          bestTime = time;
          bestVertex = localIndex;
        }
      }
    }
    ccwSources.push(source('vertex', bestVertex, bestTime ?? t0));
  }

  // 转为顺时针：逆序顶点；边的来源元数据不依赖方向，直接沿用。
  const cwPoints = ccwHull.slice().reverse();
  const edges: RawEdge[] = [];
  for (let i = 0; i < cwPoints.length; i += 1) {
    const from = cwPoints[i];
    const to = cwPoints[(i + 1) % cwPoints.length];
    // 逆序后 CW 边 (from->to) 对应 CCW 边 (to->from)。
    const ccwIndex = ccwHull.findIndex((point) => pointsEqual(point.p, to.p));
    if (pointsEqual(from.p, to.p)) continue;
    edges.push({ a: from.p, b: to.p, source: ccwSources[ccwIndex], box: false });
  }
  return edges;
}

/** 两条线段的全部精确交点：横交/T 接至多一点；共线重合给出重叠区间两端。 */
function segmentIntersections(e: RawEdge, f: RawEdge): RatPoint[] {
  const a = canonPoint(e.a);
  const b = canonPoint(e.b);
  const c = canonPoint(f.a);
  const d = canonPoint(f.b);
  const u = subPoints(b, a);
  const v = subPoints(d, c);
  const den = crossRat(u, v);

  if (compareRat(den, rZero()) === 0) {
    if (compareRat(crossRat(subPoints(c, a), u), rZero()) !== 0) return [];
    const lengthSquared = dotPoints(u, u);
    const tc = divRat(dotPoints(subPoints(c, a), u), lengthSquared);
    const td = divRat(dotPoints(subPoints(d, a), u), lengthSquared);
    const lo = compareRat(tc, td) <= 0 ? tc : td;
    const hi = compareRat(tc, td) <= 0 ? td : tc;
    const low = compareRat(lo, rZero()) > 0 ? lo : rZero();
    const high = compareRat(hi, rOne()) < 0 ? hi : rOne();
    if (compareRat(low, high) > 0) return [];
    const pLow = addPoints(a, scalePoint(u, low));
    const pHigh = addPoints(a, scalePoint(u, high));
    return pointsEqual(pLow, pHigh) ? [pLow] : [pLow, pHigh];
  }

  const t = divRat(crossRat(subPoints(c, a), v), den);
  const s = divRat(negRat(crossRat(subPoints(c, a), u)), den);
  if (
    compareRat(t, rZero()) < 0 ||
    compareRat(t, rOne()) > 0 ||
    compareRat(s, rZero()) < 0 ||
    compareRat(s, rOne()) > 0
  ) {
    return [];
  }
  return [addPoints(a, scalePoint(u, t))];
}

interface HalfEdge {
  origin: number;
  target: number;
  twin: number;
  /** 与本半边同方向重合的全部源扫掠边（保留重数）。 */
  candidates: SourceRef[];
  box: boolean;
  next: number;
}

const FEATURE_RANK: Record<SourceRef['kind'], number> = { edge: 0, vertex: 1 };

function compareSources(a: SourceRef, b: SourceRef): number {
  const byTime = compareRat(a.firstTime, b.firstTime);
  if (byTime !== 0) return byTime;
  if (a.segment !== b.segment) return a.segment - b.segment;
  if (FEATURE_RANK[a.kind] !== FEATURE_RANK[b.kind]) return FEATURE_RANK[a.kind] - FEATURE_RANK[b.kind];
  return a.index - b.index;
}

function angleSort(points: RatPoint[], halfEdges: HalfEdge[], list: number[]): void {
  const halfPlane = (v: RatPoint): 0 | 1 => {
    const positive = compareRat(v.y, rZero()) > 0;
    const zero = compareRat(v.y, rZero()) === 0;
    return positive || (zero && compareRat(v.x, rZero()) >= 0) ? 0 : 1;
  };
  list.sort((idA, idB) => {
    const a = subPoints(points[halfEdges[idA].target], points[halfEdges[idA].origin]);
    const b = subPoints(points[halfEdges[idB].target], points[halfEdges[idB].origin]);
    const ha = halfPlane(a);
    const hb = halfPlane(b);
    if (ha !== hb) return ha - hb;
    const cross = compareRat(crossRat(a, b), rZero());
    if (cross !== 0) return -cross; // cross>0：a 极角更小
    return idA - idB;
  });
}

function buildArrangement(rawEdges: RawEdge[]): {
  points: RatPoint[];
  halfEdges: HalfEdge[];
  ccwNext: number[];
} {
  // 1) 收集所有交点（包围盒边严格在外，不参与求交）。
  const splitPoints: RatPoint[][] = rawEdges.map((edge) => [canonPoint(edge.a), canonPoint(edge.b)]);
  for (let i = 0; i < rawEdges.length; i += 1) {
    if (rawEdges[i].box) continue;
    for (let j = i + 1; j < rawEdges.length; j += 1) {
      if (rawEdges[j].box) continue;
      const hits = segmentIntersections(rawEdges[i], rawEdges[j]);
      for (const hit of hits) {
        splitPoints[i].push(hit);
        splitPoints[j].push(hit);
      }
    }
  }

  const pointMap = new Map<string, number>();
  const points: RatPoint[] = [];
  const pointId = (p: RatPoint): number => {
    const canonical = canonPoint(p);
    const key = pointKey(canonical);
    const existing = pointMap.get(key);
    if (existing !== undefined) return existing;
    const id = points.length;
    pointMap.set(key, id);
    points.push(canonical);
    return id;
  };

  // 2) 每条原边沿参数排序切分；几何上重合的同向子段合并为同一条半边，
  //    但保留全部来源候选（输出时做稳定裁决）。
  const halfEdges: HalfEdge[] = [];
  const pairByLowHigh = new Map<string, number>();

  const ensurePair = (a: number, b: number, box: boolean): number => {
    const low = a < b ? a : b;
    const high = a < b ? b : a;
    const key = `${low}->${high}`;
    const forward = pairByLowHigh.get(key);
    if (forward !== undefined) {
      return halfEdges[forward].origin === a ? forward : halfEdges[forward].twin;
    }
    const id = halfEdges.length;
    halfEdges.push({ origin: a, target: b, twin: id + 1, candidates: [], box, next: -1 });
    halfEdges.push({ origin: b, target: a, twin: id, candidates: [], box, next: -1 });
    pairByLowHigh.set(key, low === a ? id : id + 1);
    return id;
  };

  rawEdges.forEach((edge, edgeIndex) => {
    const a = canonPoint(edge.a);
    const b = canonPoint(edge.b);
    const u = subPoints(b, a);
    const lengthSquared = dotPoints(u, u);
    const along = (p: RatPoint): Rat => divRat(dotPoints(subPoints(canonPoint(p), a), u), lengthSquared);
    const unique = new Map<string, RatPoint>();
    for (const p of splitPoints[edgeIndex]) unique.set(pointKey(p), canonPoint(p));
    const ordered = [...unique.values()].sort((p, q) => compareRat(along(p), along(q)));
    for (let i = 0; i < ordered.length - 1; i += 1) {
      if (pointsEqual(ordered[i], ordered[i + 1])) continue;
      const id = ensurePair(pointId(ordered[i]), pointId(ordered[i + 1]), edge.box);
      if (!edge.box) halfEdges[id].candidates.push(edge.source);
    }
  });

  // 3) 顶点处按极角逆时针排序出边；面在有向边右侧时，到达 v 后沿 twin
  //    的逆时针下一条出边继续。
  const outgoing = new Map<number, number[]>();
  halfEdges.forEach((he, id) => {
    const list = outgoing.get(he.origin) ?? [];
    list.push(id);
    outgoing.set(he.origin, list);
  });
  outgoing.forEach((list) => angleSort(points, halfEdges, list));

  halfEdges.forEach((he, id) => {
    const list = outgoing.get(he.target)!;
    const twinIndex = list.indexOf(he.twin);
    he.next = list[(twinIndex + 1) % list.length];
  });

  const ccwNext = new Array<number>(halfEdges.length).fill(-1);
  outgoing.forEach((list) => {
    list.forEach((id, index) => {
      ccwNext[id] = list[(index + 1) % list.length];
    });
  });

  return { points, halfEdges, ccwNext };
}

/** 顺时针包围盒，使全部几何严格位于其内部。 */
function buildBoundingBox(rawEdges: RawEdge[]): RawEdge[] {
  let minX = canonPoint(rawEdges[0].a).x;
  let maxX = minX;
  let minY = canonPoint(rawEdges[0].a).y;
  let maxY = minY;
  for (const edge of rawEdges) {
    for (const p of [edge.a, edge.b]) {
      const c = canonPoint(p);
      if (compareRat(c.x, minX) < 0) minX = c.x;
      if (compareRat(c.x, maxX) > 0) maxX = c.x;
      if (compareRat(c.y, minY) < 0) minY = c.y;
      if (compareRat(c.y, maxY) > 0) maxY = c.y;
    }
  }
  const tl: RatPoint = { x: subRat(minX, rOne()), y: addRat(maxY, rOne()) };
  const tr: RatPoint = { x: addRat(maxX, rOne()), y: addRat(maxY, rOne()) };
  const br: RatPoint = { x: addRat(maxX, rOne()), y: subRat(minY, rOne()) };
  const bl: RatPoint = { x: subRat(minX, rOne()), y: subRat(minY, rOne()) };
  return [
    { a: tl, b: tr, source: SYNTHETIC_SOURCE, box: true },
    { a: tr, b: br, source: SYNTHETIC_SOURCE, box: true },
    { a: br, b: bl, source: SYNTHETIC_SOURCE, box: true },
    { a: bl, b: tl, source: SYNTHETIC_SOURCE, box: true }
  ];
}

export function computeEnvelope(
  boom: ValidBoom,
  boomIndex: 0 | 1,
  startValue: bigint,
  endValue: bigint
): EnvelopeResult {
  const start = rat(startValue);
  const end = rat(endValue);

  // 分段时间：区间端点 + 严格落在内部的本吊杆关键帧；端点外复用端点保持姿态。
  const breaks = [startValue];
  for (const frame of boom.keyframes) {
    if (frame.t > startValue && frame.t < endValue) breaks.push(frame.t);
  }
  breaks.push(endValue);
  breaks.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const sourceSegmentRings: RawEdge[][] = [];
  if (startValue === endValue) {
    sourceSegmentRings.push(buildSegmentRing(boom, boomIndex, start, start, 0));
  } else {
    for (let i = 0; i < breaks.length - 1; i += 1) {
      sourceSegmentRings.push(buildSegmentRing(boom, boomIndex, rat(breaks[i]), rat(breaks[i + 1]), i));
    }
  }
  const rawEdges = sourceSegmentRings.flat().concat(buildBoundingBox(sourceSegmentRings.flat()));
  const { points, halfEdges, ccwNext } = buildArrangement(rawEdges);

  // 4) 枚举面边界组件（next 环；多连通面的各组件分别成环）。
  const cycles: number[][] = [];
  const cycleOf = new Array<number>(halfEdges.length).fill(-1);
  halfEdges.forEach((startHE, startId) => {
    if (cycleOf[startId] !== -1) return;
    const cycle: number[] = [];
    let current = startId;
    do {
      cycleOf[current] = cycles.length;
      cycle.push(current);
      current = halfEdges[current].next;
    } while (current !== startId);
    cycles.push(cycle);
  });

  // 5) 每个边界组件右侧是否被覆盖：取首边中点 m，沿其右侧法向做符号
  //    无穷小平移 q=m+ε·(uy,-ux)，对全部源扫掠环做水平射线绕数。
  //    ε→0⁺ 的边界情形全部用符号判定，不做浮点：
  //      - 源边端点纵坐标等于 m.y 时，按 -ε·ux 的符号决定上下；
  //      - 交点横坐标等于 m.x（源边与当前边共线）时，按 ε·uy 决定左右。
  //    源环均为顺时针，内部绕数为 -1；折返/自覆盖给出 -2、-3…，非零即覆盖。
  const belowAtMidY = (value: Rat, ux: Rat): boolean => {
    const order = compareRat(value, rZero());
    if (order !== 0) return order < 0;
    return compareRat(ux, rZero()) < 0; // value < -ε·ux ⇔ ux<0
  };

  const coverageRight = cycles.map((cycle): number => {
    const first = halfEdges[cycle[0]];
    const a = points[first.origin];
    const b = points[first.target];
    const ux = subRat(b.x, a.x);
    const uy = subRat(b.y, a.y);
    const mx = mulRat(addRat(a.x, b.x), rat(1n, 2n));
    const my = mulRat(addRat(a.y, b.y), rat(1n, 2n));

    let winding = 0;
    for (const ring of sourceSegmentRings) {
      for (const edge of ring) {
        const pa = canonPoint(edge.a);
        const pb = canonPoint(edge.b);
        const ay = subRat(pa.y, my);
        const by = subRat(pb.y, my);
        const aBelow = belowAtMidY(ay, ux);
        const bBelow = belowAtMidY(by, ux);
        if (aBelow === bBelow) continue;
        const edgeDx = subRat(pb.x, pa.x);
        const edgeDy = subRat(pb.y, pa.y);
        const xIntersect = addRat(pa.x, mulRat(negRat(ay), divRat(edgeDx, edgeDy)));
        const xOrder = compareRat(xIntersect, mx);
        let toTheRight: boolean;
        if (xOrder !== 0) {
          toTheRight = xOrder > 0;
        } else {
          // 退化情形（源边恰好穿过中点高度上的 mx）：交点随 ε 平移的系数
          // 为 -ux·dx_e/dy_e，需与探测点 ε·uy 精确比较，不转浮点。
          const shiftedCoefficient = negRat(divRat(mulRat(ux, edgeDx), edgeDy));
          toTheRight = compareRat(shiftedCoefficient, uy) > 0;
        }
        if (!toTheRight) continue;
        // 射线向右：顺时针环内部打到的是向下的边（起点在上），贡献 -1；
        // 覆盖判定只关心绕数非零，折返/自覆盖产生的 ±2、±3 同样归一。
        winding += aBelow ? 1 : -1;
      }
    }
    return winding;
  });

  const coveredRightOf = (id: number): boolean => coverageRight[cycleOf[id]] !== 0;

  // 并集边界定向：被覆盖区在右侧、未覆盖区在左侧。
  const boundaryOriented = (id: number): boolean => {
    const he = halfEdges[id];
    return coveredRightOf(id) && !coveredRightOf(he.twin);
  };

  // 到达 v 后从 twin(h) 起逆时针旋转，越过两侧均覆盖的内部边，取第一条
  // 满足边界定向的出边作为下一条边界边。
  const boundarySuccessor = (id: number): number => {
    let current = ccwNext[halfEdges[id].twin];
    while (!boundaryOriented(current)) {
      current = ccwNext[current];
    }
    return current;
  };

  const orientedLoops: number[][][] = [];
  const visited = new Set<number>();
  halfEdges.forEach((he, id) => {
    if (he.box || !boundaryOriented(id) || visited.has(id)) return;
    const edges: number[] = [];
    let current = id;
    do {
      visited.add(current);
      edges.push(current);
      current = boundarySuccessor(current);
    } while (current !== id);

    // 点接触（ pinch ）会让两个环只在顶点接触而串成 8 字形，在重复顶点拆开。
    const subcycles: number[][] = [];
    const openIndex = new Map<number, number>();
    let cycle: number[] = [];
    for (const edgeId of edges) {
      const origin = halfEdges[edgeId].origin;
      const open = openIndex.get(origin);
      if (open !== undefined) {
        subcycles.push(cycle.slice(open).concat(edgeId));
        for (const used of cycle.slice(open)) openIndex.delete(halfEdges[used].origin);
        cycle = cycle.slice(0, open);
      }
      openIndex.set(origin, cycle.length);
      cycle.push(edgeId);
    }
    if (cycle.length > 0) subcycles.push(cycle);
    orientedLoops.push(subcycles);
  });

  // 按有向面积符号分类：负为顺时针外环，正为逆时针孔洞；零面积退化环丢弃。
  const signedArea2 = (edges: number[]): Rat => {
    let acc = rZero();
    for (const heId of edges) {
      const he = halfEdges[heId];
      const a = points[he.origin];
      const b = points[he.target];
      acc = addRat(acc, subRat(mulRat(a.x, b.y), mulRat(a.y, b.x)));
    }
    return acc;
  };

  const rawLoops: Array<{ kind: 'outer' | 'hole'; edges: number[] }> = [];
  for (const subcycles of orientedLoops) {
    for (const edges of subcycles) {
      const area2Value = signedArea2(edges);
      const order = compareRat(area2Value, rZero());
      if (order === 0) continue;
      rawLoops.push({ kind: order < 0 ? 'outer' : 'hole', edges });
    }
  }

  // 精确面积 = -1/2 · Σ 各环有向二倍面积（外环 CW 为负，孔洞 CCW 为正）。
  let totalArea2 = rZero();
  for (const loop of rawLoops) totalArea2 = addRat(totalArea2, signedArea2(loop.edges));
  const area = negRat(divRat(totalArea2, rat(2n)));

  // 环从字典序最小顶点起排，外环/孔洞分别按最小顶点稳定排序。
  const finalizeLoop = (loop: { kind: 'outer' | 'hole'; edges: number[] }): EnvelopeLoop => {
    const vertices = loop.edges.map((heId) => points[halfEdges[heId].origin]);
    let minIndex = 0;
    for (let i = 1; i < vertices.length; i += 1) {
      if (comparePointsLex(vertices[i], vertices[minIndex]) < 0) minIndex = i;
    }
    return {
      kind: loop.kind,
      vertices: vertices.slice(minIndex).concat(vertices.slice(0, minIndex)),
      edgeIds: loop.edges.slice(minIndex).concat(loop.edges.slice(0, minIndex))
    };
  };

  const outerLoops = rawLoops
    .filter((loop) => loop.kind === 'outer')
    .map(finalizeLoop)
    .sort((a, b) => comparePointsLex(a.vertices[0], b.vertices[0]));
  const holes = rawLoops
    .filter((loop) => loop.kind === 'hole')
    .map(finalizeLoop)
    .sort((a, b) => comparePointsLex(a.vertices[0], b.vertices[0]));

  // 每条输出边在全部同向重合来源中按最早时刻、段序、特征类、序号裁决，
  // 保证来源唯一且确定。
  const edges: EnvelopeEdge[] = [];
  const assignEdges = (loop: EnvelopeLoop) => {
    loop.edgeIds.forEach((heId, position) => {
      const he = halfEdges[heId];
      const candidates = he.candidates.length > 0 ? he.candidates : halfEdges[he.twin].candidates;
      const best = candidates.slice().sort(compareSources)[0] ?? SYNTHETIC_SOURCE;
      const id = edges.length;
      loop.edgeIds[position] = id;
      edges.push({
        id,
        from: points[he.origin],
        to: points[he.target],
        boom: boomIndex,
        segment: best.segment,
        segmentStart: best.segmentStart,
        segmentEnd: best.segmentEnd,
        feature: { kind: best.kind, index: best.index },
        firstTime: best.firstTime
      });
    });
  };
  outerLoops.forEach(assignEdges);
  holes.forEach(assignEdges);

  return { boom: boomIndex, start, end, area, outerLoops, holes, edges };
}

export interface EnvelopeFieldError {
  path: 'envelope.start' | 'envelope.end';
  message: string;
}

export interface EnvelopeRequest {
  boom: 0 | 1;
  start: bigint;
  end: bigint;
}

const INTEGER_PATTERN = /^[+-]?\d+$/;

export function validateEnvelopeRequest(
  boomText: string,
  startText: string,
  endText: string,
  interval: { start: Rat; end: Rat }
): { request: EnvelopeRequest | null; errors: EnvelopeFieldError[] } {
  const errors: EnvelopeFieldError[] = [];
  let startValue: bigint | null = null;
  let endValue: bigint | null = null;

  if (!INTEGER_PATTERN.test(startText.trim())) {
    errors.push({ path: 'envelope.start', message: '起始毫秒必须是整数' });
  } else {
    startValue = BigInt(startText.trim());
  }
  if (!INTEGER_PATTERN.test(endText.trim())) {
    errors.push({ path: 'envelope.end', message: '结束毫秒必须是整数' });
  } else {
    endValue = BigInt(endText.trim());
  }

  if (startValue !== null && endValue !== null && startValue > endValue) {
    errors.push({ path: 'envelope.start', message: '起始时刻不得晚于结束时刻' });
  }
  if (startValue !== null) {
    const value = rat(startValue);
    if (compareRat(value, interval.start) < 0 || compareRat(value, interval.end) > 0) {
      errors.push({
        path: 'envelope.start',
        message: `起始时刻必须位于共同校核区间 [${formatRat(interval.start)}, ${formatRat(interval.end)}] ms 内`
      });
    }
  }
  if (endValue !== null) {
    const value = rat(endValue);
    if (compareRat(value, interval.start) < 0 || compareRat(value, interval.end) > 0) {
      errors.push({
        path: 'envelope.end',
        message: `结束时刻必须位于共同校核区间 [${formatRat(interval.start)}, ${formatRat(interval.end)}] ms 内`
      });
    }
  }

  if (errors.length > 0) return { request: null, errors };
  const boom: 0 | 1 = boomText === '1' ? 1 : 0;
  return { request: { boom, start: startValue!, end: endValue! }, errors: [] };
}
