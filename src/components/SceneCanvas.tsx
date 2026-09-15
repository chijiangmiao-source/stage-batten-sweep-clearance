import { useEffect, useMemo, useRef } from 'react';
import type { CollisionReport } from '../geometry/collision';
import { poseAtTime } from '../geometry/collision';
import type { ValidScene } from '../geometry/validation';
import { ratToNumber, type RatPoint } from '../geometry/rational';
import type { EnvelopeResult } from '../geometry/envelope';

interface CanvasProps {
  scene: ValidScene | null;
  currentPoses: [RatPoint[], RatPoint[]] | null;
  report: CollisionReport | null;
  playhead: number;
  envelope: EnvelopeResult | null;
  selectedEnvelopeEdge: number | null;
  onForbiddenVertexMove: (index: number, x: bigint, y: bigint) => void;
  onKeyframePositionMove: (boomIndex: 0 | 1, frameIndex: number, x: bigint, y: bigint) => void;
  onEnvelopeEdgeClick: (edgeId: number) => void;
}

const COLORS = ['#2563eb', '#7c3aed', '#dc2626'];
const NAMES = ['1 号吊杆', '2 号吊杆', '禁区'];
const HIT_RADIUS = 9;
const ENVELOPE_COLOR = '#0891b2';
const ENVELOPE_HIGHLIGHT = '#f59e0b';

// Only entities with unambiguous world coordinates are directly draggable:
// forbidden-zone vertices (static world points) and keyframe anchors (world
// translation points). Boom outline vertices live in each boom's local frame,
// so they are edited precisely through the integer form fields instead.
type DragTarget =
  | { type: 'forbidden'; index: number }
  | { type: 'keyframe'; boomIndex: 0 | 1; frameIndex: number };

interface Transform {
  unproject: (screenX: number, screenY: number) => { x: number; y: number };
  /** 屏幕像素换算到世界毫米，用于点击容差。 */
  screenToWorld: number;
}

interface ProjectedEdge {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function SceneCanvas({
  scene,
  currentPoses,
  report,
  playhead,
  envelope,
  selectedEnvelopeEdge,
  onForbiddenVertexMove,
  onKeyframePositionMove,
  onEnvelopeEdgeClick
}: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transformRef = useRef<Transform | null>(null);
  const dragRef = useRef<DragTarget | null>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const envelopeEdgesRef = useRef<ProjectedEdge[]>([]);
  const callbacksRef = useRef({ onForbiddenVertexMove, onKeyframePositionMove, onEnvelopeEdgeClick });
  callbacksRef.current = { onForbiddenVertexMove, onKeyframePositionMove, onEnvelopeEdgeClick };

  const bounds = useMemo(() => {
    if (!scene) return { minX: -100, minY: -100, maxX: 900, maxY: 500 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const include = (x: number, y: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };

    scene.forbidden.vertices.forEach((p) => include(Number(p.x), Number(p.y)));
    scene.booms.forEach((boom) => {
      boom.keyframes.forEach((frame) => include(Number(frame.x), Number(frame.y)));
    });
    if (currentPoses) {
      currentPoses.forEach((pose) => pose.forEach((p) => include(ratToNumber(p.x), ratToNumber(p.y))));
    }
    envelope?.edges.forEach((edge) => {
      include(ratToNumber(edge.from.x), ratToNumber(edge.from.y));
      include(ratToNumber(edge.to.x), ratToNumber(edge.to.y));
    });
    report?.contacts.forEach((contact) => {
      contact.points.forEach((point) => include(ratToNumber(point.x), ratToNumber(point.y)));
    });
    if (!Number.isFinite(minX)) {
      minX = -100;
      minY = -100;
      maxX = 900;
      maxY = 500;
    }
    const padding = 90;
    return { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding };
  }, [scene, report, currentPoses, envelope]);

  // Draggable world-coordinate handles.
  const handles = useMemo(() => {
    if (!scene) {
      return {
        forbidden: [] as Array<{ x: number; y: number; index: number }>,
        keyframes: [[], []] as [
          Array<{ x: number; y: number; index: number; boomIndex: 0 | 1 }>,
          Array<{ x: number; y: number; index: number; boomIndex: 0 | 1 }>
        ]
      };
    }
    return {
      forbidden: scene.forbidden.vertices.map((p, index) => ({
        x: Number(p.x),
        y: Number(p.y),
        index
      })),
      keyframes: scene.booms.map((boom, boomIndex) =>
        boom.keyframes.map((frame, frameIndex) => ({
          x: Number(frame.x),
          y: Number(frame.y),
          index: frameIndex,
          boomIndex: boomIndex as 0 | 1
        }))
      ) as [
        Array<{ x: number; y: number; index: number; boomIndex: 0 | 1 }>,
        Array<{ x: number; y: number; index: number; boomIndex: 0 | 1 }>
      ]
    };
  }, [scene]);

  // 被选中包络边对应的源轮廓特征（在该边最早时刻的姿态下）。
  const highlight = useMemo(() => {
    if (!envelope || !scene || selectedEnvelopeEdge === null) return null;
    const edge = envelope.edges.find((value) => value.id === selectedEnvelopeEdge);
    if (!edge || edge.segment < 0) return null;
    const pose = poseAtTime(scene.booms[envelope.boom], edge.firstTime);
    return { edge, pose };
  }, [envelope, scene, selectedEnvelopeEdge]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(320, parent.clientWidth);
    const height = 560;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const worldWidth = Math.max(1, bounds.maxX - bounds.minX);
    const worldHeight = Math.max(1, bounds.maxY - bounds.minY);
    const scale = Math.min((width - 32) / worldWidth, (height - 32) / worldHeight);
    const offsetX = 16 + (width - 32 - worldWidth * scale) / 2;
    const offsetY = 16 + (height - 32 - worldHeight * scale) / 2;
    const project = (x: number, y: number): [number, number] => [
      offsetX + (x - bounds.minX) * scale,
      height - offsetY - (y - bounds.minY) * scale
    ];
    const unproject = (screenX: number, screenY: number) => ({
      x: (screenX - offsetX) / scale + bounds.minX,
      y: (height - offsetY - screenY) / scale + bounds.minY
    });
    transformRef.current = { unproject, screenToWorld: 1 / scale };

    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    // Adaptive spacing: fixed 50 mm spacing would draw tens of millions of lines
    // for very large scenes and freeze the browser. Pick a 1/2/5 × 10^k spacing so
    // the larger world dimension never needs more than ~24 grid lines.
    const targetCells = 24;
    const rough = Math.max(worldWidth, worldHeight) / targetCells;
    const power = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1e-9))));
    const candidates = [power, 2 * power, 5 * power, 10 * power];
    const grid = candidates.find((candidate) => candidate >= rough) ?? 10 * power;
    for (let x = Math.ceil(bounds.minX / grid) * grid; x <= bounds.maxX; x += grid) {
      const [sx] = project(x, 0);
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, height);
      ctx.stroke();
    }
    for (let y = Math.ceil(bounds.minY / grid) * grid; y <= bounds.maxY; y += grid) {
      const [, sy] = project(0, y);
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(width, sy);
      ctx.stroke();
    }

    const drawPolygon = (points: Array<{ x: number; y: number }>, color: string, fill: string, name: string) => {
      if (points.length === 0) return;
      ctx.beginPath();
      points.forEach((point, index) => {
        const [x, y] = project(point.x, point.y);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.stroke();
      const [labelX, labelY] = project(points[0].x, points[0].y);
      ctx.fillStyle = color;
      ctx.font = '13px system-ui';
      ctx.fillText(name, labelX + 4, labelY - 6);
    };

    if (scene) {
      drawPolygon(
        scene.forbidden.vertices.map((p) => ({ x: Number(p.x), y: Number(p.y) })),
        COLORS[2],
        'rgba(220,38,38,0.14)',
        NAMES[2]
      );
      if (currentPoses) {
        currentPoses.forEach((pose, index) => {
          drawPolygon(
            pose.map((p) => ({ x: ratToNumber(p.x), y: ratToNumber(p.y) })),
            COLORS[index],
            index === 0 ? 'rgba(37,99,235,0.15)' : 'rgba(124,58,237,0.15)',
            NAMES[index]
          );
        });
      }
    }

    // 占用包络叠加：外环与孔洞用带绕数的同一路径填充，孔洞自然镂空。
    const projectedEnvelopeEdges: ProjectedEdge[] = [];
    if (envelope) {
      const trace = (loop: { vertices: RatPoint[] }) => {
        loop.vertices.forEach((point, index) => {
          const [x, y] = project(ratToNumber(point.x), ratToNumber(point.y));
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
      };
      ctx.beginPath();
      envelope.outerLoops.forEach(trace);
      envelope.holes.forEach(trace);
      ctx.fillStyle = 'rgba(8,145,178,0.14)';
      ctx.fill('evenodd');

      envelope.edges.forEach((edge) => {
        const [x1, y1] = project(ratToNumber(edge.from.x), ratToNumber(edge.from.y));
        const [x2, y2] = project(ratToNumber(edge.to.x), ratToNumber(edge.to.y));
        projectedEnvelopeEdges.push({ id: edge.id, x1, y1, x2, y2 });
        const selected = edge.id === selectedEnvelopeEdge;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = selected ? ENVELOPE_HIGHLIGHT : ENVELOPE_COLOR;
        ctx.lineWidth = selected ? 4.5 : 2.5;
        ctx.stroke();
      });
      ctx.fillStyle = ENVELOPE_COLOR;
      ctx.font = 'bold 12px system-ui';
      if (envelope.outerLoops[0]) {
        const anchor = envelope.outerLoops[0].vertices[0];
        const [ax, ay] = project(ratToNumber(anchor.x), ratToNumber(anchor.y));
        ctx.fillText(`吊杆 ${envelope.boom + 1} 占用包络`, ax, ay - 8);
      }
    }
    envelopeEdgesRef.current = projectedEnvelopeEdges;
    (canvas as HTMLCanvasElement & {
      __envelopeEdges?: Array<{ id: number; x1: number; y1: number; x2: number; y2: number; firstTime: number }>;
    }).__envelopeEdges = envelope
      ? projectedEnvelopeEdges.map((projected) => {
          const edge = envelope.edges.find((value) => value.id === projected.id)!;
          return { ...projected, firstTime: ratToNumber(edge.firstTime) };
        })
      : [];

    // 高亮被选中包络边的源轮廓特征（在最早时刻姿态下）。
    if (highlight) {
      const { edge, pose } = highlight;
      const feature = edge.feature;
      ctx.strokeStyle = ENVELOPE_HIGHLIGHT;
      ctx.fillStyle = ENVELOPE_HIGHLIGHT;
      ctx.lineWidth = 4;
      if (feature.kind === 'edge') {
        const a = pose[feature.index];
        const b = pose[(feature.index + 1) % pose.length];
        const [x1, y1] = project(ratToNumber(a.x), ratToNumber(a.y));
        const [x2, y2] = project(ratToNumber(b.x), ratToNumber(b.y));
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      } else {
        const p = pose[feature.index];
        const [x, y] = project(ratToNumber(p.x), ratToNumber(p.y));
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Forbidden vertices: round red handles.
    handles.forbidden.forEach((handle) => {
      const [x, y] = project(handle.x, handle.y);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = COLORS[2];
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = COLORS[2];
      ctx.font = 'bold 11px system-ui';
      ctx.fillText(`V${handle.index + 1}`, x + 8, y - 7);
    });
    // Keyframe anchors: square per-boom handles.
    handles.keyframes.forEach((frames, boomIndex) => {
      frames.forEach((handle) => {
        const [x, y] = project(handle.x, handle.y);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = COLORS[boomIndex];
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.rect(x - 6, y - 6, 12, 12);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = COLORS[boomIndex];
        ctx.font = 'bold 11px system-ui';
        ctx.fillText(`K${handle.index + 1}`, x + 8, y + 4);
      });
    });

    if (report && !report.safe) {
      const atContact = report.time !== null && Math.abs(playhead - ratToNumber(report.time)) < 0.01;
      ctx.strokeStyle = atContact ? '#f59e0b' : '#f97316';
      ctx.fillStyle = atContact ? '#f59e0b' : '#f97316';
      ctx.lineWidth = 4;
      report.contacts.forEach((contact) => {
        if (contact.points.length === 1) {
          const [x, y] = project(ratToNumber(contact.points[0].x), ratToNumber(contact.points[0].y));
          ctx.beginPath();
          ctx.arc(x, y, atContact ? 8 : 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = 'bold 13px system-ui';
          ctx.fillText('接触', x + 10, y - 10);
        } else if (contact.points.length === 2) {
          const [x1, y1] = project(ratToNumber(contact.points[0].x), ratToNumber(contact.points[0].y));
          const [x2, y2] = project(ratToNumber(contact.points[1].x), ratToNumber(contact.points[1].y));
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      });
    }

    ctx.fillStyle = '#475569';
    ctx.font = '12px system-ui';
    ctx.fillText('俯视画布（mm，Y 轴向上）；拖动红色禁区顶点或方形关键帧锚点可按整数直接编辑，点击青色包络边可跳转到其最早时刻', 16, height - 14);
  }, [scene, currentPoses, report, playhead, bounds, handles, envelope, selectedEnvelopeEdge, highlight]);

  const locateHandle = (event: React.PointerEvent<HTMLCanvasElement>): DragTarget | null => {
    const canvas = canvasRef.current;
    const transform = transformRef.current;
    if (!canvas || !transform) return null;
    const rect = canvas.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const pointer = transform.unproject(screenX, screenY);
    const distanceTo = (point: { x: number; y: number }) => Math.hypot(pointer.x - point.x, pointer.y - point.y);
    const origin = transform.unproject(screenX, screenY);
    const shifted = transform.unproject(screenX + HIT_RADIUS, screenY);
    const worldHit = Math.abs(shifted.x - origin.x);

    for (let boomIndex = 0; boomIndex < handles.keyframes.length; boomIndex += 1) {
      for (const handle of handles.keyframes[boomIndex]) {
        if (distanceTo(handle) <= worldHit) {
          return { type: 'keyframe', boomIndex: boomIndex as 0 | 1, frameIndex: handle.index };
        }
      }
    }
    for (let index = 0; index < handles.forbidden.length; index += 1) {
      if (distanceTo(handles.forbidden[index]) <= worldHit) return { type: 'forbidden', index };
    }
    return null;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const target = locateHandle(event);
    if (target) {
      dragRef.current = target;
      event.currentTarget.setPointerCapture(event.pointerId);
      downRef.current = null;
    } else {
      downRef.current = { x: event.clientX, y: event.clientY };
    }
  };

  const nearestEnvelopeEdge = (event: React.PointerEvent<HTMLCanvasElement>): number | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    let best: { id: number; distance: number } | null = null;
    for (const edge of envelopeEdgesRef.current) {
      const dx = edge.x2 - edge.x1;
      const dy = edge.y2 - edge.y1;
      const lengthSquared = dx * dx + dy * dy || 1;
      let t = ((sx - edge.x1) * dx + (sy - edge.y1) * dy) / lengthSquared;
      t = Math.max(0, Math.min(1, t));
      const distance = Math.hypot(sx - (edge.x1 + t * dx), sy - (edge.y1 + t * dy));
      if (!best || distance < best.distance) best = { id: edge.id, distance };
    }
    return best && best.distance <= 10 ? best.id : null;
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const target = dragRef.current;
    const transform = transformRef.current;
    const canvas = canvasRef.current;
    if (!target || !transform || !canvas) {
      if (canvas && !dragRef.current) {
        canvas.style.cursor = locateHandle(event) ? 'grab' : nearestEnvelopeEdge(event) !== null ? 'pointer' : 'default';
      }
      return;
    }
    canvas.style.cursor = 'grabbing';
    const rect = canvas.getBoundingClientRect();
    const world = transform.unproject(event.clientX - rect.left, event.clientY - rect.top);
    const x = BigInt(Math.round(world.x));
    const y = BigInt(Math.round(world.y));
    if (target.type === 'forbidden') {
      callbacksRef.current.onForbiddenVertexMove(target.index, x, y);
    } else {
      callbacksRef.current.onKeyframePositionMove(target.boomIndex, target.frameIndex, x, y);
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const wasDragging = dragRef.current;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released.
    }
    const down = downRef.current;
    downRef.current = null;
    if (wasDragging || !down) return;

    // 未拖动手柄且基本未移动的点击：命中最近的包络边。
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) return;
    const edgeId = nearestEnvelopeEdge(event);
    if (edgeId !== null) callbacksRef.current.onEnvelopeEdgeClick(edgeId);
  };

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="两根吊杆和静态禁区的俯视画布，可拖动禁区顶点与关键帧锚点，可点击包络边跳转"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  );
}
