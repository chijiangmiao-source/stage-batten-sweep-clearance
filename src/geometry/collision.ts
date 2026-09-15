import {
  addAffine,
  addRat,
  affine,
  compareRat,
  crossRat,
  divRat,
  evalAffine,
  formatRat,
  maxRat,
  minRat,
  mulRat,
  negAffine,
  negRat,
  rat,
  rOne,
  rZero,
  solveAffineInequalities,
  subRat,
  subRatPoint,
  type Affine,
  type IntPoint,
  type Rat,
  type RatPoint
} from './rational';
import type { ValidBoom, ValidScene } from './validation';

export interface GeometryContact {
  pair: [number, number];
  edges: [number, number];
  kind: 'vertex-vertex' | 'vertex-edge' | 'edge-edge' | 'edge-overlap' | 'initial-overlap';
  description: string;
  points: RatPoint[];
}

export interface CollisionReport {
  interval: { start: Rat; end: Rat };
  safe: boolean;
  time: Rat | null;
  contacts: GeometryContact[];
}

interface MovingPolygon {
  id: number;
  vertices: IntPoint[];
}

interface MotionPiece {
  start: Rat;
  end: Rat;
  q: [RatPoint, RatPoint][];
}

interface Candidate {
  pair: [number, number];
  edges: [number, number];
  timeLow: Rat;
  collinear: boolean;
  piece: MotionPiece;
  polygonA: MovingPolygon;
  polygonB: MovingPolygon;
}

const pairDefinitions: Array<[number, number]> = [
  [0, 1],
  [0, 2],
  [1, 2]
];

export function framePosition(boom: ValidBoom, time: Rat): RatPoint {
  const frames = boom.keyframes;
  if (compareRat(time, rat(frames[0].t)) <= 0) {
    return { x: rat(frames[0].x), y: rat(frames[0].y) };
  }
  const last = frames[frames.length - 1];
  if (compareRat(time, rat(last.t)) >= 0) {
    return { x: rat(last.x), y: rat(last.y) };
  }
  for (let i = 0; i < frames.length - 1; i += 1) {
    const a = frames[i];
    const b = frames[i + 1];
    const ta = rat(a.t);
    const tb = rat(b.t);
    if (compareRat(time, ta) >= 0 && compareRat(time, tb) <= 0) {
      const u = divRat(subRat(time, ta), subRat(tb, ta));
      return {
        x: addRat(rat(a.x), mulRat(subRat(rat(b.x), rat(a.x)), u)),
        y: addRat(rat(a.y), mulRat(subRat(rat(b.y), rat(a.y)), u))
      };
    }
  }
  return { x: rat(last.x), y: rat(last.y) };
}

export function poseAtTime(boom: ValidBoom, time: Rat): RatPoint[] {
  const q = framePosition(boom, time);
  return boom.vertices.map((v) => ({ x: addRat(q.x, rat(v.x)), y: addRat(q.y, rat(v.y)) }));
}

function toRatPoint(p: IntPoint): RatPoint {
  return { x: rat(p.x), y: rat(p.y) };
}

function addPoints(a: RatPoint, b: RatPoint): RatPoint {
  return { x: addRat(a.x, b.x), y: addRat(a.y, b.y) };
}

function edgeAt(polygon: MovingPolygon, index: number): [IntPoint, IntPoint] {
  return [polygon.vertices[index], polygon.vertices[(index + 1) % polygon.vertices.length]];
}

function edgeLabel(objectId: number, edgeIndex: number): string {
  return `${objectId + 1} 号对象边 E${edgeIndex + 1}`;
}

function vertexLabel(objectId: number, vertexIndex: number): string {
  return `${objectId + 1} 号对象顶点 V${vertexIndex + 1}`;
}

function pointText(p: RatPoint): string {
  return `(${formatRat(p.x)}, ${formatRat(p.y)}) mm`;
}

function buildMotionPieces(scene: ValidScene, intervalStart: Rat, intervalEnd: Rat): MotionPiece[] {
  const allFrameTimes = scene.booms
    .flatMap((boom) => boom.keyframes.map((frame) => frame.t))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const interiorTimes = Array.from(new Set(allFrameTimes.map((t) => t.toString())), (value) => rat(BigInt(value)))
    .filter((time) => compareRat(time, intervalStart) > 0 && compareRat(time, intervalEnd) < 0);
  const times = [intervalStart, ...interiorTimes, intervalEnd];

  const pieces: MotionPiece[] = [];
  for (let i = 0; i < times.length - 1; i += 1) {
    const start = times[i];
    const end = times[i + 1];
    pieces.push({
      start,
      end,
      q: scene.booms.map((boom) => [framePosition(boom, start), framePosition(boom, end)]) as [
        RatPoint,
        RatPoint
      ][]
    });
  }
  return pieces;
}

function combineAffineWithVector(
  p: [Affine, Affine],
  vector: IntPoint,
  operation: 'cross' | 'dot'
): Affine {
  const xPart = { a: mulRat(p[0].a, rat(operation === 'cross' ? vector.y : vector.x)), b: mulRat(p[0].b, rat(operation === 'cross' ? vector.y : vector.x)) };
  const yPart = { a: mulRat(p[1].a, rat(operation === 'cross' ? vector.x : vector.y)), b: mulRat(p[1].b, rat(operation === 'cross' ? vector.x : vector.y)) };
  return addAffine(xPart, operation === 'cross' ? negAffine(yPart) : yPart);
}

function crossAffineWithVector(p: [Affine, Affine], vector: IntPoint): Affine {
  return combineAffineWithVector(p, vector, 'cross');
}

function dotAffineWithVector(p: [Affine, Affine], vector: IntPoint): Affine {
  return combineAffineWithVector(p, vector, 'dot');
}

function appendRatioInequality(list: Affine[], numerator: Affine, denominator: bigint): void {
  list.push(denominator > 0n ? numerator : negAffine(numerator));
}

function segmentPairFeasibility(
  a0: RatPoint,
  velocityA: RatPoint,
  u: IntPoint,
  c0: RatPoint,
  velocityC: RatPoint,
  v: IntPoint
): { low: Rat; high: Rat; collinear: boolean } | null {
  const denominator = u.x * v.y - u.y * v.x;
  const r0 = subRatPoint(c0, a0);
  const rv = subRatPoint(velocityC, velocityA);

  if (denominator !== 0n) {
    const r: [Affine, Affine] = [affine(rv.x, r0.x), affine(rv.y, r0.y)];
    const alphaNumerator = crossAffineWithVector(r, v);
    const betaNumerator = crossAffineWithVector(r, u);
    const denominatorRat = rat(denominator);

    const inequalities: Affine[] = [];
    const constant = (value: Rat): Affine => affine(rZero(), value);
    appendRatioInequality(inequalities, negAffine(alphaNumerator), denominator);
    appendRatioInequality(
      inequalities,
      addAffine(alphaNumerator, constant(negRat(denominatorRat))),
      denominator
    );
    appendRatioInequality(inequalities, negAffine(betaNumerator), denominator);
    appendRatioInequality(
      inequalities,
      addAffine(betaNumerator, constant(negRat(denominatorRat))),
      denominator
    );

    const interval = solveAffineInequalities(inequalities);
    return interval && compareRat(interval.low, interval.high) <= 0
      ? { low: interval.low, high: interval.high, collinear: false }
      : null;
  }

  const r: [Affine, Affine] = [affine(rv.x, r0.x), affine(rv.y, r0.y)];
  const lineDistance = crossAffineWithVector(r, u);
  const projection = dotAffineWithVector(r, u);
  const lengthSquared = u.x * u.x + u.y * u.y;
  const vProjection = v.x * u.x + v.y * u.y;

  const overlapInequalities: Affine[] = [];
  const constant = (value: Rat): Affine => affine(rZero(), value);
  if (vProjection >= 0n) {
    overlapInequalities.push(addAffine(projection, constant(rat(-lengthSquared))));
    overlapInequalities.push(negAffine(addAffine(projection, constant(rat(vProjection)))));
  } else {
    overlapInequalities.push(
      addAffine(addAffine(projection, constant(rat(vProjection))), constant(rat(-lengthSquared)))
    );
    overlapInequalities.push(negAffine(projection));
  }

  if (lineDistance.a.n === 0n) {
    if (lineDistance.b.n !== 0n) return null;
    const interval = solveAffineInequalities(overlapInequalities);
    return interval && compareRat(interval.low, interval.high) <= 0
      ? { low: interval.low, high: interval.high, collinear: true }
      : null;
  }

  const root = divRat(negRat(lineDistance.b), lineDistance.a);
  if (compareRat(root, rZero()) < 0 || compareRat(root, rOne()) > 0) return null;
  for (const expression of overlapInequalities) {
    if (compareRat(evalAffine(expression, root), rZero()) > 0) return null;
  }
  return { low: root, high: root, collinear: true };
}

function polygonForObject(scene: ValidScene, id: number): MovingPolygon {
  return {
    id,
    vertices: id === 2 ? scene.forbidden.vertices : scene.booms[id].vertices
  };
}

function candidatesForPair(scene: ValidScene, piece: MotionPiece, pairIndex: number): Candidate[] {
  const [ai, bi] = pairDefinitions[pairIndex];
  const polygonA = polygonForObject(scene, ai);
  const polygonB = polygonForObject(scene, bi);
  const qA0 = ai === 2 ? { x: rZero(), y: rZero() } : piece.q[ai][0];
  const qA1 = ai === 2 ? { x: rZero(), y: rZero() } : piece.q[ai][1];
  const qB0 = bi === 2 ? { x: rZero(), y: rZero() } : piece.q[bi][0];
  const qB1 = bi === 2 ? { x: rZero(), y: rZero() } : piece.q[bi][1];
  const velocityA = subRatPoint(qA1, qA0);
  const velocityB = subRatPoint(qB1, qB0);

  const candidates: Candidate[] = [];
  for (let edgeA = 0; edgeA < polygonA.vertices.length; edgeA += 1) {
    const [u0, u1] = edgeAt(polygonA, edgeA);
    const u: IntPoint = { x: u1.x - u0.x, y: u1.y - u0.y };
    const edgeStartA = addPoints(qA0, toRatPoint(u0));

    for (let edgeB = 0; edgeB < polygonB.vertices.length; edgeB += 1) {
      const [v0, v1] = edgeAt(polygonB, edgeB);
      const v: IntPoint = { x: v1.x - v0.x, y: v1.y - v0.y };
      const edgeStartC = addPoints(qB0, toRatPoint(v0));
      const feasible = segmentPairFeasibility(edgeStartA, velocityA, u, edgeStartC, velocityB, v);
      if (!feasible) continue;

      const duration = subRat(piece.end, piece.start);
      candidates.push({
        pair: [ai, bi],
        edges: [edgeA, edgeB],
        timeLow: reduce(addRat(piece.start, mulRat(duration, feasible.low))),
        collinear: feasible.collinear,
        piece,
        polygonA,
        polygonB
      });
    }
  }
  return candidates;
}

function reduce(value: Rat): Rat {
  if (value.n === 0n) return { n: 0n, d: 1n };
  const a = value.n < 0n ? -value.n : value.n;
  const b = value.d < 0n ? -value.d : value.d;
  const g = gcdBig(a, b);
  return { n: value.n / g, d: value.d / g };
}

function gcdBig(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const z = x % y;
    x = y;
    y = z;
  }
  return x || 1n;
}

function poseInPiece(piece: MotionPiece, objectId: number, time: Rat): RatPoint {
  if (objectId === 2) return { x: rZero(), y: rZero() };
  const duration = subRat(piece.end, piece.start);
  const s = compareRat(duration, rZero()) === 0 ? rZero() : divRat(subRat(time, piece.start), duration);
  const [p0, p1] = piece.q[objectId];
  return {
    x: addRat(p0.x, mulRat(subRat(p1.x, p0.x), s)),
    y: addRat(p0.y, mulRat(subRat(p1.y, p0.y), s))
  };
}

function pointOnEdge(start: RatPoint, edge: IntPoint, parameter: Rat): RatPoint {
  return {
    x: reduce(addRat(start.x, mulRat(rat(edge.x), parameter))),
    y: reduce(addRat(start.y, mulRat(rat(edge.y), parameter)))
  };
}

function isEndpoint(parameter: Rat): 0 | 1 | null {
  if (compareRat(parameter, rZero()) === 0) return 0;
  if (compareRat(parameter, rOne()) === 0) return 1;
  return null;
}

function buildContact(candidate: Candidate, time: Rat): GeometryContact {
  const [ai, bi] = candidate.pair;
  const [edgeAIndex, edgeBIndex] = candidate.edges;
  const qA = poseInPiece(candidate.piece, ai, time);
  const qB = poseInPiece(candidate.piece, bi, time);
  const [a0Point, a1Point] = edgeAt(candidate.polygonA, edgeAIndex);
  const [b0Point, b1Point] = edgeAt(candidate.polygonB, edgeBIndex);
  const u: IntPoint = { x: a1Point.x - a0Point.x, y: a1Point.y - a0Point.y };
  const v: IntPoint = { x: b1Point.x - b0Point.x, y: b1Point.y - b0Point.y };
  const edgeStartA = addPoints(qA, toRatPoint(a0Point));
  const edgeStartB = addPoints(qB, toRatPoint(b0Point));

  if (candidate.collinear) {
    const relative = subRatPoint(edgeStartB, edgeStartA);
    const c = addRat(mulRat(relative.x, rat(u.x)), mulRat(relative.y, rat(u.y)));
    const k = rat(u.x * u.x + u.y * u.y);
    const h = rat(v.x * u.x + v.y * u.y);
    const cEnd = addRat(c, h);
    const low = maxRat(rZero(), minRat(c, cEnd));
    const high = minRat(k, maxRat(c, cEnd));
    const p1 = pointOnEdge(edgeStartA, u, divRat(low, k));
    const p2 = pointOnEdge(edgeStartA, u, divRat(high, k));
    const samePoint = compareRat(low, high) === 0;
    if (samePoint) {
      const alongB = subRatPoint(p1, edgeStartB);
      const betaOnB = divRat(
        addRat(mulRat(alongB.x, rat(v.x)), mulRat(alongB.y, rat(v.y))),
        rat(v.x * v.x + v.y * v.y)
      );
      const alphaOnA = divRat(low, k);
      const aEnd = isEndpoint(alphaOnA);
      const bEnd = isEndpoint(betaOnB);
      let kind: GeometryContact['kind'] = 'vertex-edge';
      let description: string;
      if (aEnd !== null && bEnd !== null) {
        kind = 'vertex-vertex';
        const va = aEnd === 0 ? edgeAIndex : (edgeAIndex + 1) % candidate.polygonA.vertices.length;
        const vb = bEnd === 0 ? edgeBIndex : (edgeBIndex + 1) % candidate.polygonB.vertices.length;
        description = `${vertexLabel(ai, va)} 与 ${vertexLabel(bi, vb)} 接触于 ${pointText(p1)}`;
      } else if (aEnd !== null) {
        const va = aEnd === 0 ? edgeAIndex : (edgeAIndex + 1) % candidate.polygonA.vertices.length;
        description = `${vertexLabel(ai, va)} 触及 ${edgeLabel(bi, edgeBIndex)} 于 ${pointText(p1)}`;
      } else if (bEnd !== null) {
        const vb = bEnd === 0 ? edgeBIndex : (edgeBIndex + 1) % candidate.polygonB.vertices.length;
        description = `${vertexLabel(bi, vb)} 触及 ${edgeLabel(ai, edgeAIndex)} 于 ${pointText(p1)}`;
      } else {
        description = `${edgeLabel(ai, edgeAIndex)} 与 ${edgeLabel(bi, edgeBIndex)} 首次共线接触于 ${pointText(p1)}`;
      }
      return {
        pair: [ai + 1, bi + 1],
        edges: [edgeAIndex + 1, edgeBIndex + 1],
        kind,
        description,
        points: [p1]
      };
    }
    return {
      pair: [ai + 1, bi + 1],
      edges: [edgeAIndex + 1, edgeBIndex + 1],
      kind: 'edge-overlap',
      description: `${edgeLabel(ai, edgeAIndex)} 与 ${edgeLabel(bi, edgeBIndex)} 共线重合，接触段 ${pointText(p1)} 至 ${pointText(p2)}`,
      points: [p1, p2]
    };
  }

  const relative = subRatPoint(edgeStartB, edgeStartA);
  const denominator = rat(u.x * v.y - u.y * v.x);
  const alpha = divRat(crossRat(relative, toRatPoint(v)), denominator);
  const beta = divRat(crossRat(relative, toRatPoint(u)), denominator);
  const point = pointOnEdge(edgeStartA, u, alpha);
  const alphaEnd = isEndpoint(alpha);
  const betaEnd = isEndpoint(beta);

  let kind: GeometryContact['kind'] = 'edge-edge';
  let description: string;
  if (alphaEnd !== null && betaEnd !== null) {
    kind = 'vertex-vertex';
    const va = alphaEnd === 0 ? edgeAIndex : (edgeAIndex + 1) % candidate.polygonA.vertices.length;
    const vb = betaEnd === 0 ? edgeBIndex : (edgeBIndex + 1) % candidate.polygonB.vertices.length;
    description = `${vertexLabel(ai, va)} 与 ${vertexLabel(bi, vb)} 接触于 ${pointText(point)}`;
  } else if (alphaEnd !== null) {
    kind = 'vertex-edge';
    const va = alphaEnd === 0 ? edgeAIndex : (edgeAIndex + 1) % candidate.polygonA.vertices.length;
    description = `${vertexLabel(ai, va)} 触及 ${edgeLabel(bi, edgeBIndex)} 于 ${pointText(point)}`;
  } else if (betaEnd !== null) {
    kind = 'vertex-edge';
    const vb = betaEnd === 0 ? edgeBIndex : (edgeBIndex + 1) % candidate.polygonB.vertices.length;
    description = `${vertexLabel(bi, vb)} 触及 ${edgeLabel(ai, edgeAIndex)} 于 ${pointText(point)}`;
  } else {
    description = `${edgeLabel(ai, edgeAIndex)} 与 ${edgeLabel(bi, edgeBIndex)} 相交于 ${pointText(point)}`;
  }

  return {
    pair: [ai + 1, bi + 1],
    edges: [edgeAIndex + 1, edgeBIndex + 1],
    kind,
    description,
    points: [point]
  };
}

function strictlyInside(points: RatPoint[], polygon: RatPoint[]): boolean {
  return points.every((p) =>
    polygon.every((startValue, edgeIndex) => {
      const endValue = polygon[(edgeIndex + 1) % polygon.length];
      const edge = subRatPoint(endValue, startValue);
      const relative = subRatPoint(p, startValue);
      return compareRat(crossRat(edge, relative), rZero()) < 0;
    })
  );
}

function findInitialOverlaps(scene: ValidScene, start: Rat, pairsWithBoundaryContact: Set<number>): GeometryContact[] {
  // All three polygons must be in world coordinates: boom vertices are local and
  // only become a world pose after adding the anchor held at the interval start.
  const worldPolygons = [0, 1, 2].map((id) =>
    id === 2
      ? scene.forbidden.vertices.map((p) => toRatPoint(p))
      : poseAtTime(scene.booms[id], start)
  );

  const contacts: GeometryContact[] = [];
  pairDefinitions.forEach(([ai, bi], pairIndex) => {
    if (pairsWithBoundaryContact.has(pairIndex)) return;
    const a = worldPolygons[ai];
    const b = worldPolygons[bi];
    if (strictlyInside(a, b) || strictlyInside(b, a)) {
      contacts.push({
        pair: [ai + 1, bi + 1],
        edges: [1, 1],
        kind: 'initial-overlap',
        description: '校核区间起点已重叠且边界无交点；按规则在该对象对中取双方最小边号 E1/E1',
        points: []
      });
    }
  });
  contacts.sort(compareContacts);
  return contacts.slice(0, 1);
}

function compareContacts(a: GeometryContact, b: GeometryContact): number {
  for (let i = 0; i < 2; i += 1) {
    if (a.pair[i] !== b.pair[i]) return a.pair[i] - b.pair[i];
  }
  for (let i = 0; i < 2; i += 1) {
    if (a.edges[i] !== b.edges[i]) return a.edges[i] - b.edges[i];
  }
  return 0;
}

function contactKey(contact: GeometryContact): string {
  return `${contact.pair[0]}-${contact.pair[1]}:${contact.edges[0]}-${contact.edges[1]}`;
}

function dedupeContacts(contacts: GeometryContact[]): GeometryContact[] {
  return contacts.filter((contact, index, array) => index === 0 || contactKey(contact) !== contactKey(array[index - 1]));
}

export function analyzeCollisions(scene: ValidScene): CollisionReport {
  const firstTimes = scene.booms.map((boom) => boom.keyframes[0].t);
  const lastTimes = scene.booms.map((boom) => boom.keyframes[boom.keyframes.length - 1].t);
  const start = rat(firstTimes.reduce((a, b) => (a < b ? a : b)));
  const end = rat(lastTimes.reduce((a, b) => (a > b ? a : b)));

  const pieces = buildMotionPieces(scene, start, end);
  if (pieces.length === 0) {
    const p0 = { x: rat(scene.booms[0].keyframes[0].x), y: rat(scene.booms[0].keyframes[0].y) };
    const p1 = { x: rat(scene.booms[1].keyframes[0].x), y: rat(scene.booms[1].keyframes[0].y) };
    pieces.push({ start, end: start, q: [[p0, p0], [p1, p1]] });
  }

  const candidates: Candidate[] = [];
  for (const piece of pieces) {
    for (let pairIndex = 0; pairIndex < pairDefinitions.length; pairIndex += 1) {
      candidates.push(...candidatesForPair(scene, piece, pairIndex));
    }
  }

  const contactsAtStart: GeometryContact[] = [];
  if (candidates.some((candidate) => compareRat(candidate.timeLow, start) === 0)) {
    contactsAtStart.push(
      ...candidates
        .filter((candidate) => compareRat(candidate.timeLow, start) === 0)
        .map((candidate) => buildContact(candidate, start))
    );
  }

  const pairsWithBoundaryContact = new Set(
    candidates
      .filter((candidate) => compareRat(candidate.timeLow, start) === 0)
      .map((candidate) => pairDefinitions.findIndex(([a, b]) => a === candidate.pair[0] && b === candidate.pair[1]))
  );
  contactsAtStart.push(...findInitialOverlaps(scene, start, pairsWithBoundaryContact));

  if (contactsAtStart.length > 0) {
    const deduped = dedupeContacts(contactsAtStart.sort(compareContacts));
    return { interval: { start, end }, safe: false, time: start, contacts: deduped };
  }

  if (candidates.length === 0) {
    return { interval: { start, end }, safe: true, time: null, contacts: [] };
  }

  const firstTime = candidates.reduce((best, candidate) =>
    compareRat(candidate.timeLow, best) < 0 ? candidate.timeLow : best
  , candidates[0].timeLow);
  const contacts = dedupeContacts(
    candidates
      .filter((candidate) => compareRat(candidate.timeLow, firstTime) === 0)
      .map((candidate) => buildContact(candidate, firstTime))
      .sort(compareContacts)
  );

  return { interval: { start, end }, safe: false, time: firstTime, contacts };
}
