import { it } from 'vitest';
import { computeEnvelope } from './src/geometry/envelope';

it('debug', () => {
  const squareCW = [
    { x: -30n, y: 15n }, { x: 30n, y: 15n }, { x: 30n, y: -15n }, { x: -30n, y: -15n }
  ];
  const r = computeEnvelope(
    { vertices: squareCW, keyframes: [{ t: 0n, x: 200n, y: 200n }, { t: 1000n, x: 300n, y: 200n }] },
    0, 0n, 1000n
  );
  console.log('area', r.area, 'outers', r.outerLoops.length, 'holes', r.holes.length, 'edges', r.edges.length);
});
