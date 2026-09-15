import { describe, expect, it } from 'vitest';
import { analyzeCollisions } from './collision';
import { validateScene } from './validation';
import type { SceneDraft } from '../model';
import type { ValidBoom, ValidPolygon, ValidScene } from './validation';
import { formatRat } from './rational';

const squareCW = [
  { x: -30n, y: 15n },
  { x: 30n, y: 15n },
  { x: 30n, y: -15n },
  { x: -30n, y: -15n }
];

const farForbidden: ValidPolygon = {
  vertices: [
    { x: 900n, y: 100n },
    { x: 900n, y: 400n },
    { x: 1200n, y: 400n },
    { x: 1200n, y: 100n }
  ]
};

function boom(vertices: ValidBoom['vertices'], keyframes: ValidBoom['keyframes']): ValidBoom {
  return { vertices, keyframes };
}

function scene(booms: [ValidBoom, ValidBoom], forbidden = farForbidden): ValidScene {
  return { booms, forbidden };
}

const staticFrame = (x: bigint, y: bigint) => [{ t: 0n, x, y }];

describe('polygon and keyframe validation', () => {
  const validVertex = () => ({ x: '0', y: '0' });

  function draft(mutate: (draft: SceneDraft) => void): SceneDraft {
    const value: SceneDraft = {
      booms: [
        { vertices: squareCW.map((p) => ({ x: p.x.toString(), y: p.y.toString() })), keyframes: [{ t: '0', x: '0', y: '0' }] },
        { vertices: squareCW.map((p) => ({ x: p.x.toString(), y: p.y.toString() })), keyframes: [{ t: '0', x: '100', y: '0' }] }
      ],
      forbidden: { vertices: farForbidden.vertices.map((p) => ({ x: p.x.toString(), y: p.y.toString() })) }
    };
    mutate(value);
    return value;
  }

  it('accepts at least three distinct strictly clockwise convex integer vertices', () => {
    const result = validateScene(draft(() => {}));
    expect(result.errors).toEqual([]);
    expect(result.scene).not.toBeNull();
  });

  it('rejects fewer than three vertices, duplicates, collinear triples and counter-clockwise order', () => {
    const tooFew = validateScene(draft((d) => { d.forbidden.vertices.splice(2); }));
    expect(tooFew.scene).toBeNull();
    expect(tooFew.errors[0].message).toContain('三个');

    const duplicate = validateScene(draft((d) => { d.forbidden.vertices[2] = { ...validVertex() }; d.forbidden.vertices[3] = { ...validVertex() }; }));
    expect(duplicate.errors.some((e) => e.message.includes('重复'))).toBe(true);

    const collinear = validateScene(draft((d) => {
      d.forbidden.vertices = [{ x: '0', y: '0' }, { x: '10', y: '0' }, { x: '20', y: '0' }, { x: '20', y: '20' }];
    }));
    expect(collinear.errors.some((e) => e.message.includes('严格右转') || e.message.includes('严格顺时针'))).toBe(true);

    const ccw = validateScene(draft((d) => {
      d.forbidden.vertices = [{ x: '0', y: '0' }, { x: '20', y: '0' }, { x: '20', y: '20' }, { x: '0', y: '20' }];
    }));
    expect(ccw.errors.some((e) => e.message.includes('顺时针'))).toBe(true);
  });

  it('rejects non-integer and non strictly increasing keyframe times', () => {
    const badTime = validateScene(draft((d) => { d.booms[0].keyframes[0].t = '1.5'; }));
    expect(badTime.errors[0].path).toBe('booms.0.keyframes.0.t');

    const increasing = validateScene(draft((d) => {
      d.booms[0].keyframes = [{ t: '10', x: '0', y: '0' }, { t: '10', x: '20', y: '0' }];
    }));
    expect(increasing.errors.some((e) => e.message.includes('严格递增'))).toBe(true);
  });
});

describe('exact continuous collision detection', () => {
  it('reports safety only when every pair remains strictly separated over the closed interval', () => {
    const report = analyzeCollisions(scene([
      boom(squareCW, [{ t: 0n, x: 0n, y: 200n }, { t: 1000n, x: 100n, y: 200n }]),
      boom(squareCW, [{ t: 0n, x: 500n, y: 200n }, { t: 1000n, x: 400n, y: 200n }])
    ]));
    expect(report.safe).toBe(true);
    expect(report.time).toBeNull();
    expect(report.contacts).toEqual([]);
  });

  it('finds a reduced rational first edge contact without sampling', () => {
    const report = analyzeCollisions(scene([
      boom(squareCW, [{ t: 0n, x: 100n, y: 200n }, { t: 1000n, x: 200n, y: 200n }]),
      boom(squareCW, [{ t: 0n, x: 280n, y: 200n }, { t: 1000n, x: 180n, y: 200n }])
    ]));
    expect(report.safe).toBe(false);
    expect(formatRat(report.time!)).toBe('600');
    expect(report.contacts).toHaveLength(7);
    expect(report.contacts.map((contact) => contact.edges)).toEqual([
      [1, 1], [1, 4], [2, 1], [2, 3], [2, 4], [3, 3], [3, 4]
    ]);
    expect(report.contacts[4]).toMatchObject({
      pair: [1, 2],
      edges: [2, 4],
      kind: 'edge-overlap'
    });
    expect(report.contacts[0].kind).toBe('vertex-vertex');
    expect(report.contacts[6].kind).toBe('vertex-vertex');
    expect(report.contacts[4].points.map((point) => [formatRat(point.x), formatRat(point.y)])).toEqual([
      ['190', '215'],
      ['190', '185']
    ]);
  });

  it('uses a reduced fractional millisecond time', () => {
    const report = analyzeCollisions(scene([
      boom(squareCW, [{ t: 0n, x: 0n, y: 200n }, { t: 3n, x: 1n, y: 200n }]),
      boom(squareCW, [{ t: 2n, x: 61n, y: 200n }, { t: 5n, x: 52n, y: 200n }])
    ]));
    expect(report.safe).toBe(false);
    expect(formatRat(report.time!)).toBe('21/10');
  });

  it('detects a vertex touching the interior of an edge', () => {
    const triangle = [
      { x: 0n, y: 10n },
      { x: 10n, y: -10n },
      { x: -10n, y: -10n }
    ];
    const report = analyzeCollisions(scene([
      boom(triangle, [{ t: 0n, x: 100n, y: 100n }]),
      boom(triangle, [{ t: 0n, x: 100n, y: 200n }, { t: 1000n, x: 100n, y: 80n }])
    ]));
    expect(report.safe).toBe(false);
    expect(formatRat(report.time!)).toBe('2000/3');
    expect(report.contacts).toHaveLength(2);
    expect(report.contacts.map((contact) => contact.edges)).toEqual([[1, 2], [3, 2]]);
    expect(report.contacts.every((contact) => contact.kind === 'vertex-edge')).toBe(true);
  });

  it('detects boom contact with a static forbidden zone', () => {
    const forbidden: ValidPolygon = {
      vertices: [
        { x: 300n, y: 100n },
        { x: 300n, y: 300n },
        { x: 500n, y: 300n },
        { x: 500n, y: 100n }
      ]
    };
    const report = analyzeCollisions(scene([
      boom(squareCW, [{ t: 0n, x: 200n, y: 200n }, { t: 1000n, x: 300n, y: 200n }]),
      boom(squareCW, staticFrame(800n, 200n))
    ], forbidden));
    expect(report.safe).toBe(false);
    expect(formatRat(report.time!)).toBe('700');
    expect(report.contacts[0]).toMatchObject({ pair: [1, 3], edges: [1, 1], kind: 'vertex-edge' });
    expect(report.contacts.map((contact) => contact.edges)).toContainEqual([2, 1]);
  });

  it('handles pre-first-frame and post-last-frame endpoint holding over the common closed interval', () => {
    const forbidden: ValidPolygon = {
      vertices: [
        { x: 220n, y: 185n },
        { x: 220n, y: 215n },
        { x: 260n, y: 215n },
        { x: 260n, y: 185n }
      ]
    };
    const report = analyzeCollisions(scene([
      boom(squareCW, [{ t: 100n, x: 190n, y: 200n }, { t: 200n, x: 400n, y: 200n }]),
      boom(squareCW, staticFrame(800n, 200n))
    ], forbidden));
    expect(report.safe).toBe(false);
    expect(formatRat(report.time!)).toBe('0');
    expect(report.contacts[0].pair).toEqual([1, 3]);
  });

  it('orders contacts at the same earliest time by object pair before edge numbers', () => {
    const forbidden: ValidPolygon = {
      vertices: [
        { x: 300n, y: 100n },
        { x: 300n, y: 300n },
        { x: 500n, y: 300n },
        { x: 500n, y: 100n }
      ]
    };
    const report = analyzeCollisions(scene([
      boom(squareCW, [{ t: 0n, x: 200n, y: 200n }, { t: 1000n, x: 300n, y: 200n }]),
      boom(squareCW, [{ t: 0n, x: 600n, y: 200n }, { t: 1000n, x: 500n, y: 200n }])
    ], forbidden));
    expect(formatRat(report.time!)).toBe('700');
    const pairs = report.contacts.map((contact) => contact.pair.join(','));
    expect(pairs[0]).toBe('1,3');
    expect(pairs[pairs.length - 1]).toBe('2,3');
    const orderedKeys = report.contacts.map((contact) => [...contact.pair, ...contact.edges]);
    expect(orderedKeys).toEqual([...orderedKeys].sort((a, b) => {
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
      return 0;
    }));
  });

  it('returns the minimum edge numbers when overlap already exists at interval start without boundary intersection', () => {
    const forbidden: ValidPolygon = {
      vertices: [
        { x: 0n, y: 0n },
        { x: 0n, y: 100n },
        { x: 100n, y: 100n },
        { x: 100n, y: 0n }
      ]
    };
    const report = analyzeCollisions(scene([
      boom(squareCW, [{ t: 0n, x: 50n, y: 50n }]),
      boom(squareCW, staticFrame(500n, 50n))
    ], forbidden));
    expect(report.safe).toBe(false);
    expect(formatRat(report.time!)).toBe('0');
    expect(report.contacts[0]).toMatchObject({ pair: [1, 3], edges: [1, 1], kind: 'initial-overlap' });
  });
});
