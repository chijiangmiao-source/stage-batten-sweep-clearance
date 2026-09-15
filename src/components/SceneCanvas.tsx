import { useEffect, useMemo, useRef } from 'react';
import type { CollisionReport } from '../geometry/collision';
import type { ValidScene } from '../geometry/validation';
import { ratToNumber, type RatPoint } from '../geometry/rational';

interface CanvasProps {
  scene: ValidScene | null;
  currentPoses: [RatPoint[], RatPoint[]] | null;
  report: CollisionReport | null;
  playhead: number;
  onForbiddenVertexMove: (index: number, x: bigint, y: bigint) => void;
  onKeyframePositionMove: (boomIndex: 0 | 1, frameIndex: number, x: bigint, y: bigint) => void;
}

const COLORS = ['#2563eb', '#7c3aed', '#dc2626'];
const NAMES = ['1 号吊杆', '2 号吊杆', '禁区'];
const HIT_RADIUS = 9;

// Only entities with unambiguous world coordinates are directly draggable:
// forbidden-zone vertices (static world points) and keyframe anchors (world
// translation points). Boom outline vertices live in each boom's local frame,
// so they are edited precisely through the integer form fields instead.
type DragTarget =
  | { type: 'forbidden'; index: number }
  | { type: 'keyframe'; boomIndex: 0 | 1; frameIndex: number };

interface Transform {
  unproject: (screenX: number, screenY: number) => { x: number; y: number };
}

export function SceneCanvas({
  scene,
  currentPoses,
  report,
  playhead,
  onForbiddenVertexMove,
  onKeyframePositionMove
}: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transformRef = useRef<Transform | null>(null);
  const dragRef = useRef<DragTarget | null>(null);
  const callbacksRef = useRef({ onForbiddenVertexMove, onKeyframePositionMove });
  callbacksRef.current = { onForbiddenVertexMove, onKeyframePositionMove };

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
  }, [scene, report, currentPoses]);

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
    transformRef.current = { unproject };

    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    const grid = 50;
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
    ctx.fillText('俯视画布（mm，Y 轴向上）；拖动红色禁区顶点或方形关键帧锚点可按整数直接编辑，吊杆外形请用下方整数表单', 16, height - 14);
  }, [scene, currentPoses, report, playhead, bounds, handles]);

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
    if (!target) return;
    dragRef.current = target;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const target = dragRef.current;
    const transform = transformRef.current;
    const canvas = canvasRef.current;
    if (!target || !transform || !canvas) {
      if (canvas && !dragRef.current) canvas.style.cursor = locateHandle(event) ? 'grab' : 'default';
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
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released.
    }
  };

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="两根吊杆和静态禁区的俯视画布，可拖动禁区顶点与关键帧锚点"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  );
}
