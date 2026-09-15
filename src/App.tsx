import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import type { SceneDraft, FieldError } from './model';
import { validateScene } from './geometry/validation';
import { analyzeCollisions, poseAtTime } from './geometry/collision';
import { formatRat, ratFromNumber, ratToNumber, type RatPoint } from './geometry/rational';
import { SceneCanvas } from './components/SceneCanvas';

const initialScene: SceneDraft = {
  booms: [
    {
      vertices: [
        { x: '-30', y: '15' },
        { x: '30', y: '15' },
        { x: '30', y: '-15' },
        { x: '-30', y: '-15' }
      ],
      keyframes: [
        { t: '0', x: '200', y: '200' },
        { t: '1000', x: '300', y: '200' }
      ]
    },
    {
      vertices: [
        { x: '-30', y: '15' },
        { x: '30', y: '15' },
        { x: '30', y: '-15' },
        { x: '-30', y: '-15' }
      ],
      keyframes: [
        { t: '0', x: '600', y: '200' },
        { t: '1000', x: '500', y: '200' }
      ]
    }
  ],
  forbidden: {
    vertices: [
      { x: '300', y: '100' },
      { x: '300', y: '300' },
      { x: '500', y: '300' },
      { x: '500', y: '100' }
    ]
  }
};

function cloneScene(scene: SceneDraft): SceneDraft {
  return JSON.parse(JSON.stringify(scene)) as SceneDraft;
}

function fieldId(path: string): string {
  return `field-${path.replaceAll('.', '-')}`;
}

function updateDraft(scene: SceneDraft, path: string, value: string): SceneDraft {
  const next = cloneScene(scene);
  const parts = path.split('.');
  let target: Record<string, unknown> = next as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i += 1) {
    target = target[parts[i]] as Record<string, unknown>;
  }
  target[parts[parts.length - 1]] = value;
  return next;
}

function NumberField({
  label,
  path,
  value,
  error,
  onChange
}: {
  label: string;
  path: string;
  value: string;
  error?: FieldError;
  onChange: (path: string, value: string) => void;
}) {
  return (
    <label className={`number-field ${error ? 'invalid' : ''}`} htmlFor={fieldId(path)}>
      <span>{label}</span>
      <input
        id={fieldId(path)}
        inputMode="numeric"
        value={value}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${fieldId(path)}-error` : undefined}
        onChange={(event) => onChange(path, event.target.value)}
      />
      {error ? <small id={`${fieldId(path)}-error`}>{error.message}</small> : null}
    </label>
  );
}

export default function App() {
  const [draft, setDraft] = useState<SceneDraft>(initialScene);
  const validation = useMemo(() => validateScene(draft), [draft]);
  const report = useMemo(() => (validation.scene ? analyzeCollisions(validation.scene) : null), [validation.scene]);
  const errorsByPath = useMemo(() => new Map(validation.errors.map((error) => [error.path, error])), [validation.errors]);
  const firstError = validation.errors[0];
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const animationRef = useRef<number | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const startNumber = report ? ratToNumber(report.interval.start) : 0;
  const endNumber = report ? ratToNumber(report.interval.end) : 1000;

  useEffect(() => {
    setPlayhead(startNumber);
  }, [startNumber, endNumber]);

  useEffect(() => {
    if (!firstError) return;
    const element = document.getElementById(fieldId(firstError.path));
    element?.focus();
    element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // Only relocate focus when the offending field changes, not on every keystroke,
    // so the user can keep editing the focused field.
  }, [firstError?.path]);

  useEffect(() => {
    if (!playing || !report) return;
    startedAtRef.current = null;
    const duration = Math.max(1, endNumber - startNumber);
    const tick = (now: number) => {
      if (startedAtRef.current === null) startedAtRef.current = now;
      const elapsed = now - startedAtRef.current;
      const value = startNumber + duration * Math.min(1, elapsed / 4000);
      setPlayhead(value);
      if (elapsed < 4000) {
        animationRef.current = requestAnimationFrame(tick);
      } else {
        setPlaying(false);
      }
    };
    animationRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    };
  }, [playing, report, startNumber, endNumber]);

  const onChange = useCallback((path: string, value: string) => {
    setDraft((current) => updateDraft(current, path, value));
  }, []);

  const addVertex = (path: 'forbidden' | `booms.${0 | 1}`) => {
    setDraft((current) => {
      const next = cloneScene(current);
      if (path === 'forbidden') next.forbidden.vertices.push({ x: '0', y: '0' });
      else next.booms[Number(path.slice(-1))].vertices.push({ x: '0', y: '0' });
      return next;
    });
  };

  const addKeyframe = (boomIndex: 0 | 1) => {
    setDraft((current) => {
      const next = cloneScene(current);
      next.booms[boomIndex].keyframes.push({ t: '0', x: '0', y: '0' });
      return next;
    });
  };

  const moveForbiddenVertex = useCallback((index: number, x: bigint, y: bigint) => {
    setDraft((current) => {
      const next = cloneScene(current);
      next.forbidden.vertices[index] = { x: x.toString(), y: y.toString() };
      return next;
    });
  }, []);

  const moveKeyframePosition = useCallback((boomIndex: 0 | 1, frameIndex: number, x: bigint, y: bigint) => {
    setDraft((current) => {
      const next = cloneScene(current);
      next.booms[boomIndex].keyframes[frameIndex].x = x.toString();
      next.booms[boomIndex].keyframes[frameIndex].y = y.toString();
      return next;
    });
  }, []);

  const currentPoses = useMemo(() => {
    if (!validation.scene) return null;
    const time = ratFromNumber(playhead);
    return validation.scene.booms.map((boom) => poseAtTime(boom, time)) as [RatPoint[], RatPoint[]];
  }, [validation.scene, playhead]);

  return (
    <main className="app-shell">
      <header>
        <h1>舞台吊杆连续碰撞预演</h1>
        <p>精确有理数闭区间校核；不做时间采样，边或顶点的任何接触均判定违规。</p>
      </header>

      <section className="workspace">
        <div className="canvas-panel">
          <SceneCanvas
            scene={validation.scene}
            currentPoses={currentPoses}
            report={report}
            playhead={playhead}
            onForbiddenVertexMove={moveForbiddenVertex}
            onKeyframePositionMove={moveKeyframePosition}
          />
          <div className="playback">
            <button disabled={!report} onClick={() => setPlaying((value) => !value)}>
              {playing ? '暂停' : '回放'}
            </button>
            <button
              disabled={!report || !report.time}
              onClick={() => report?.time && setPlayhead(ratToNumber(report.time))}
            >
              跳到首次接触
            </button>
            <input
              aria-label="回放时间"
              type="range"
              disabled={!report}
              min={startNumber}
              max={endNumber}
              step={(endNumber - startNumber) / 1000 || 1}
              value={playhead}
              onChange={(event) => {
                setPlaying(false);
                setPlayhead(Number(event.target.value));
              }}
            />
            <strong data-testid="playhead">{playhead.toFixed(2)} ms</strong>
          </div>
        </div>

        <div className="result-panel" aria-live="polite">
          {validation.errors.length > 0 ? (
            <article className="result invalid">
              <h2>输入非法</h2>
              <p>旧校核结论已清除。请修正第一个定位字段，全部错误如下：</p>
              <ol>
                {validation.errors.slice(0, 12).map((error) => (
                  <li key={`${error.path}-${error.message}`}>
                    <button onClick={() => document.getElementById(fieldId(error.path))?.focus()}>
                      {error.message}
                    </button>
                  </li>
                ))}
              </ol>
            </article>
          ) : report?.safe ? (
            <article className="result safe">
              <h2>安全</h2>
              <p>闭区间 [{formatRat(report.interval.start)}, {formatRat(report.interval.end)}] ms 内全程严格分离。</p>
            </article>
          ) : report ? (
            <article className="result collision">
              <h2>首次接触</h2>
              <p className="exact-time">时间：<strong>{formatRat(report.time!)} ms</strong>（已约分）</p>
              <div className="contact-list">
                {report.contacts.map((contact) => (
                  <section className="contact" key={`${contact.pair}-${contact.edges}`}>
                    <h3>对象 {contact.pair[0]} ↔ 对象 {contact.pair[1]}</h3>
                    <dl>
                      <dt>边号</dt>
                      <dd>E{contact.edges[0]} / E{contact.edges[1]}</dd>
                      <dt>姿态</dt>
                      <dd>{contact.description}</dd>
                    </dl>
                  </section>
                ))}
              </div>
            </article>
          ) : null}
        </div>
      </section>

      <section className="editors">
        {draft.booms.map((boom, boomIndex) => (
          <EditorCard key={boomIndex} title={`${boomIndex + 1} 号吊杆`}>
            <h3>局部轮廓顶点（顺时针，整数毫米）</h3>
            <div className="grid-inputs">
              {boom.vertices.map((vertex, vertexIndex) => {
                const xPath = `booms.${boomIndex}.vertices.${vertexIndex}.x`;
                const yPath = `booms.${boomIndex}.vertices.${vertexIndex}.y`;
                return (
                  <div className="vertex-row" key={vertexIndex}>
                    <span>V{vertexIndex + 1}</span>
                    <NumberField label="X" path={xPath} value={vertex.x} error={errorsByPath.get(xPath)} onChange={onChange} />
                    <NumberField label="Y" path={yPath} value={vertex.y} error={errorsByPath.get(yPath)} onChange={onChange} />
                  </div>
                );
              })}
            </div>
            <button onClick={() => addVertex(`booms.${boomIndex as 0 | 1}`)}>添加顶点</button>

            <h3>关键帧（严格递增毫秒，整数毫米平移）</h3>
            <div className="grid-inputs">
              {boom.keyframes.map((frame, frameIndex) => {
                const base = `booms.${boomIndex}.keyframes.${frameIndex}`;
                return (
                  <div className="keyframe-row" key={frameIndex}>
                    <span>K{frameIndex + 1}</span>
                    <NumberField label="t" path={`${base}.t`} value={frame.t} error={errorsByPath.get(`${base}.t`)} onChange={onChange} />
                    <NumberField label="X" path={`${base}.x`} value={frame.x} error={errorsByPath.get(`${base}.x`)} onChange={onChange} />
                    <NumberField label="Y" path={`${base}.y`} value={frame.y} error={errorsByPath.get(`${base}.y`)} onChange={onChange} />
                  </div>
                );
              })}
            </div>
            <button onClick={() => addKeyframe(boomIndex as 0 | 1)}>添加关键帧</button>
          </EditorCard>
        ))}

        <EditorCard title="静态禁区">
          <h3>世界坐标顶点（顺时针，整数毫米）</h3>
          <div className="grid-inputs">
            {draft.forbidden.vertices.map((vertex, vertexIndex) => {
              const xPath = `forbidden.vertices.${vertexIndex}.x`;
              const yPath = `forbidden.vertices.${vertexIndex}.y`;
              return (
                <div className="vertex-row" key={vertexIndex}>
                  <span>V{vertexIndex + 1}</span>
                  <NumberField label="X" path={xPath} value={vertex.x} error={errorsByPath.get(xPath)} onChange={onChange} />
                  <NumberField label="Y" path={yPath} value={vertex.y} error={errorsByPath.get(yPath)} onChange={onChange} />
                </div>
              );
            })}
          </div>
          <button onClick={() => addVertex('forbidden')}>添加顶点</button>
        </EditorCard>
      </section>
    </main>
  );
}

function EditorCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="editor-card">
      <h2>{title}</h2>
      {children}
    </article>
  );
}
