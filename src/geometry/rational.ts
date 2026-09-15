export interface Rat {
  n: bigint;
  d: bigint;
}

const ZERO_RAT: Rat = { n: 0n, d: 1n };
const ONE_RAT: Rat = { n: 1n, d: 1n };

export function rat(n: bigint | number | string, d: bigint | number | string = 1n): Rat {
  const numerator = typeof n === 'bigint' ? n : BigInt(n);
  let denominator = typeof d === 'bigint' ? d : BigInt(d);
  if (denominator === 0n) throw new Error('Zero denominator in rational number');
  if (numerator === 0n) denominator = 1n;
  if (denominator < 0n) return { n: -numerator, d: -denominator };
  return { n: numerator, d: denominator };
}

export function rZero(): Rat {
  return ZERO_RAT;
}

export function rOne(): Rat {
  return ONE_RAT;
}

export function isRat(value: unknown): value is Rat {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Rat).n === 'bigint' &&
    typeof (value as Rat).d === 'bigint'
  );
}

export function ratFromNumber(value: number): Rat {
  if (!Number.isFinite(value)) throw new Error('Only finite numbers can be converted to rational');
  if (Number.isInteger(value)) return rat(BigInt(value));

  let text = value.toString(10);
  let exponent = 0;
  const exponentMatch = /e([+-]?\d+)$/i.exec(text);
  if (exponentMatch) {
    exponent = Number.parseInt(exponentMatch[1], 10);
    text = text.slice(0, exponentMatch.index);
  }

  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [integer, fraction = ''] = unsigned.split('.');
  const digits = BigInt(`${integer}${fraction}`);
  const numerator = negative ? -digits : digits;
  const exponentAdjust = exponent - fraction.length;

  if (exponentAdjust >= 0) return rat(numerator * 10n ** BigInt(exponentAdjust));
  return rat(numerator, 10n ** BigInt(-exponentAdjust));
}

export function reduce(x: Rat): Rat {
  if (x.n === 0n) return { n: 0n, d: 1n };
  const g = gcdAbs(x.n, x.d);
  return { n: x.n / g, d: x.d / g };
}

function gcdAbs(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const z = x % y;
    x = y;
    y = z;
  }
  return x === 0n ? 1n : x;
}

export function addRat(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function subRat(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function mulRat(a: Rat, b: Rat): Rat {
  return rat(a.n * b.n, a.d * b.d);
}

export function divRat(a: Rat, b: Rat): Rat {
  if (b.n === 0n) throw new Error('Division by zero rational');
  return rat(a.n * b.d, a.d * b.n);
}

export function negRat(a: Rat): Rat {
  return { n: -a.n, d: a.d };
}

export function signRat(a: Rat): -1 | 0 | 1 {
  if (a.n === 0n) return 0;
  return a.n < 0n === a.d < 0n ? 1 : -1;
}

export function compareRat(a: Rat, b: Rat): -1 | 0 | 1 {
  const left = a.n * b.d;
  const right = b.n * a.d;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function minRat(a: Rat, b: Rat): Rat {
  return compareRat(a, b) < 0 ? a : b;
}

export function maxRat(a: Rat, b: Rat): Rat {
  return compareRat(a, b) > 0 ? a : b;
}

export function ratToNumber(a: Rat): number {
  return Number(a.n) / Number(a.d);
}

export function formatRat(value: Rat): string {
  const x = reduce(value);
  if (x.d === 1n) return x.n.toString(10);
  return `${x.n}/${x.d}`;
}

export interface RatPoint {
  x: Rat;
  y: Rat;
}

export interface IntPoint {
  x: bigint;
  y: bigint;
}

export function intPoint(x: bigint | number, y: bigint | number): IntPoint {
  return { x: BigInt(x), y: BigInt(y) };
}

export function toRatPoint(p: IntPoint): RatPoint {
  return { x: rat(p.x), y: rat(p.y) };
}

export function crossInt(a: IntPoint, b: IntPoint): bigint {
  return a.x * b.y - a.y * b.x;
}

export function subInt(a: IntPoint, b: IntPoint): IntPoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function crossRat(a: RatPoint, b: RatPoint): Rat {
  return subRat(mulRat(a.x, b.y), mulRat(a.y, b.x));
}

export function subRatPoint(a: RatPoint, b: RatPoint): RatPoint {
  return { x: subRat(a.x, b.x), y: subRat(a.y, b.y) };
}

export function addRatPoint(a: RatPoint, b: RatPoint): RatPoint {
  return { x: addRat(a.x, b.x), y: addRat(a.y, b.y) };
}

export function scaleRatPoint(a: RatPoint, k: Rat): RatPoint {
  return { x: mulRat(a.x, k), y: mulRat(a.y, k) };
}

/** f(s)=a*s+b */
export interface Affine {
  a: Rat;
  b: Rat;
}

export function affine(a: Rat | bigint | number, b: Rat | bigint | number): Affine {
  return {
    a: typeof a === 'object' ? a : rat(a),
    b: typeof b === 'object' ? b : rat(b)
  };
}

export function evalAffine(f: Affine, s: Rat): Rat {
  return addRat(mulRat(f.a, s), f.b);
}

export function negAffine(f: Affine): Affine {
  return { a: negRat(f.a), b: negRat(f.b) };
}

export function addAffine(f: Affine, g: Affine): Affine {
  return { a: addRat(f.a, g.a), b: addRat(f.b, g.b) };
}

export interface AffineInterval {
  low: Rat;
  high: Rat;
  feasible: boolean;
}

/** Intersect s in [0,1] with every affine inequality f(s) <= 0. */
export function solveAffineInequalities(functions: Affine[]): AffineInterval | null {
  let low = rZero();
  let high = rOne();

  for (const f of functions) {
    const aSign = signRat(f.a);
    if (aSign === 0) {
      if (signRat(f.b) > 0) return null;
      continue;
    }
    const bound = divRat(negRat(f.b), f.a);
    if (aSign > 0) {
      high = minRat(high, bound);
    } else {
      low = maxRat(low, bound);
    }
    if (compareRat(low, high) > 0) return null;
  }
  return { low, high, feasible: compareRat(low, high) <= 0 };
}
