import { crossInt, intPoint, subInt, type IntPoint } from './rational';
import type { BoomDraft, FieldError, KeyframeDraft, SceneDraft, VertexDraft } from '../model';

export interface ValidPolygon {
  vertices: IntPoint[];
}

export interface ValidKeyframe {
  t: bigint;
  x: bigint;
  y: bigint;
}

export interface ValidBoom {
  vertices: IntPoint[];
  keyframes: ValidKeyframe[];
}

export interface ValidScene {
  booms: [ValidBoom, ValidBoom];
  forbidden: ValidPolygon;
}

function parseSafeInteger(text: string): bigint | null {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  let value: bigint;
  try {
    value = BigInt(trimmed);
  } catch {
    return null;
  }
  return value;
}

function orientation(a: IntPoint, b: IntPoint, c: IntPoint): bigint {
  return crossInt(subInt(b, a), subInt(c, a));
}

export function validatePolygon(
  draft: { vertices: VertexDraft[] },
  pathPrefix: string,
  label: string,
  errors: FieldError[]
): ValidPolygon | null {
  const points: Array<IntPoint | null> = draft.vertices.map((vertex, index) => {
    const x = parseSafeInteger(vertex.x);
    const y = parseSafeInteger(vertex.y);
    if (x === null) {
      errors.push({ path: `${pathPrefix}.vertices.${index}.x`, message: `${label}顶点 ${index + 1} 的 X 必须是安全整数` });
    }
    if (y === null) {
      errors.push({ path: `${pathPrefix}.vertices.${index}.y`, message: `${label}顶点 ${index + 1} 的 Y 必须是安全整数` });
    }
    return x === null || y === null ? null : intPoint(x, y);
  });

  if (points.length < 3) {
    errors.push({ path: `${pathPrefix}.vertices`, message: `${label}至少需要三个顶点` });
  }

  const validPoints = points.filter((p): p is IntPoint => p !== null);
  for (let i = 0; i < validPoints.length; i += 1) {
    for (let j = i + 1; j < validPoints.length; j += 1) {
      if (validPoints[i].x === validPoints[j].x && validPoints[i].y === validPoints[j].y) {
        errors.push({
          path: `${pathPrefix}.vertices.${j}.x`,
          message: `${label}顶点 ${j + 1} 与顶点 ${i + 1} 重复`
        });
      }
    }
  }

  if (validPoints.length >= 3) {
    let area2 = 0n;
    for (let i = 0; i < validPoints.length; i += 1) {
      const a = validPoints[i];
      const b = validPoints[(i + 1) % validPoints.length];
      area2 += a.x * b.y - b.x * a.y;
    }
    if (area2 === 0n) {
      errors.push({ path: `${pathPrefix}.vertices`, message: `${label}面积为零` });
    } else if (area2 > 0n) {
      errors.push({ path: `${pathPrefix}.vertices`, message: `${label}必须按顺时针录入` });
    }

    for (let i = 0; i < validPoints.length; i += 1) {
      const a = validPoints[i];
      const b = validPoints[(i + 1) % validPoints.length];
      const c = validPoints[(i + 2) % validPoints.length];
      if (orientation(a, b, c) >= 0n) {
        errors.push({
          path: `${pathPrefix}.vertices.${(i + 1) % validPoints.length}.x`,
          message: `${label}第 ${i + 1}、${(i + 1) % validPoints.length + 1}、${(i + 2) % validPoints.length + 1} 个连续顶点不是严格右转`
        });
      }
    }

    for (let edgeIndex = 0; edgeIndex < validPoints.length; edgeIndex += 1) {
      const start = validPoints[edgeIndex];
      const end = validPoints[(edgeIndex + 1) % validPoints.length];
      const edge = subInt(end, start);
      for (let vertexIndex = 0; vertexIndex < validPoints.length; vertexIndex += 1) {
        if (vertexIndex === edgeIndex || vertexIndex === (edgeIndex + 1) % validPoints.length) continue;
        if (crossInt(edge, subInt(validPoints[vertexIndex], start)) >= 0n) {
          errors.push({
            path: `${pathPrefix}.vertices.${vertexIndex}.x`,
            message: `${label}不是严格顺时针凸轮廓：顶点 ${vertexIndex + 1} 不在边 E${edgeIndex + 1} 的严格右侧`
          });
        }
      }
    }
  }

  return errors.some((error) => error.path.startsWith(pathPrefix)) ? null : { vertices: validPoints };
}

function validateKeyframes(draft: KeyframeDraft[], pathPrefix: string, label: string, errors: FieldError[]): ValidKeyframe[] | null {
  if (draft.length === 0) {
    errors.push({ path: `${pathPrefix}.keyframes.0.t`, message: `${label}至少需要一个关键帧` });
    return null;
  }

  const frames: Array<{ t: bigint; x: bigint; y: bigint } | null> = draft.map((frame, index) => {
    const t = parseSafeInteger(frame.t);
    const x = parseSafeInteger(frame.x);
    const y = parseSafeInteger(frame.y);
    if (t === null) errors.push({ path: `${pathPrefix}.keyframes.${index}.t`, message: `${label}关键帧 ${index + 1} 的时间必须是整数毫秒` });
    if (x === null) errors.push({ path: `${pathPrefix}.keyframes.${index}.x`, message: `${label}关键帧 ${index + 1} 的 X 必须是整数毫米` });
    if (y === null) errors.push({ path: `${pathPrefix}.keyframes.${index}.y`, message: `${label}关键帧 ${index + 1} 的 Y 必须是整数毫米` });
    return t === null || x === null || y === null ? null : { t, x, y };
  });

  const validFrames = frames.filter((f): f is { t: bigint; x: bigint; y: bigint } => f !== null);
  for (let i = 1; i < validFrames.length; i += 1) {
    if (validFrames[i].t <= validFrames[i - 1].t) {
      errors.push({
        path: `${pathPrefix}.keyframes.${i}.t`,
        message: `${label}关键帧时间必须严格递增`
      });
    }
  }
  return errors.some((error) => error.path.startsWith(`${pathPrefix}.keyframes`)) ? null : validFrames;
}

export function validateScene(scene: SceneDraft): { scene: ValidScene | null; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const polygons = scene.booms.map((boom, index) =>
    validatePolygon(boom, `booms.${index}`, `${index + 1} 号吊杆`, errors)
  );
  const keyframes = scene.booms.map((boom, index) =>
    validateKeyframes(boom.keyframes, `booms.${index}`, `${index + 1} 号吊杆`, errors)
  );
  const forbidden = validatePolygon(scene.forbidden, 'forbidden', '静态禁区', errors);

  if (errors.length > 0) return { scene: null, errors };
  return {
    scene: {
      booms: [0, 1].map((i) => ({
        vertices: polygons[i]!.vertices,
        keyframes: keyframes[i]!
      })) as [ValidBoom, ValidBoom],
      forbidden: forbidden!
    },
    errors: []
  };
}
