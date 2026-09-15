import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import type { SceneDraft, FieldError } from './model';
import { validateScene } from './geometry/validation';
import { analyzeCollisions, poseAtTime } from './geometry/collision';
import { compareRat, formatRat, rat, ratFromNumber, ratToNumber, type Rat, type RatPoint } from './geometry/rational';
import {
  computeEnvelope,
  validateEnvelopeRequest,
  type EnvelopeFieldError,
  type EnvelopeRequest,
  type EnvelopeResult
} from './geometry/envelope';
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

  // 占用包络请求：输入文本始终保留（即使非法），只有点击“确认”且校验通过
  // 后才生成 confirmedRequest；包络本身随场景编辑自动重算。
  const [envelopeDraft, setEnvelopeDraft] = useState({ boom: '0', start: '0', end: '1000' });
  const [envelopeErrors, setEnvelopeErrors] = useState<EnvelopeFieldError[]>([]);
  const [confirmedRequest, setConfirmedRequest] = useState<EnvelopeRequest | null>(null);
  const [selectedEnvelopeEdge, setSelectedEnvelopeEdge] = useState<number | null>(null);

  // 请求只在确认瞬间校验通过；场景编辑若使共同校核区间变化，旧请求可能
  // 越界——此时随当前 report 区间重新校验，越界即移除包络（不碰碰撞结论）。
  const requestStillValid = useMemo(() => {
    if (!confirmedRequest || !report) return false;
    const start = rat(confirmedRequest.start);
    const end = rat(confirmedRequest.end);
    return (
      compareRat(start, report.interval.start) >= 0 &&
      compareRat(end, report.interval.end) <= 0 &&
      compareRat(start, end) <= 0
    );
  }, [confirmedRequest, report]);

  const envelope = useMemo<EnvelopeResult | null>(() => {
    if (!validation.scene || !confirmedRequest || !requestStillValid) return null;
    return computeEnvelope(
      validation.scene.booms[confirmedRequest.boom],
      confirmedRequest.boom,
      confirmedRequest.start,
      confirmedRequest.end
    );
  }, [validation.scene, confirmedRequest, requestStillValid]);

  // 场景编辑后旧选中边可能不再存在；清掉选中态（包络本身随场景自动重算）。
  useEffect(() => {
    setSelectedEnvelopeEdge(null);
  }, [validation.scene]);

  const envelopeErrorsByPath = useMemo(
    () => new Map(envelopeErrors.map((error) => [error.path, error])),
    [envelopeErrors]
  );
  const selectedEnvelopeEdgeData = useMemo(
    () => (envelope && selectedEnvelopeEdge !== null
      ? envelope.edges.find((edge) => edge.id === selectedEnvelopeEdge) ?? null
      : null),
    [envelope, selectedEnvelopeEdge]
  );

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

  const confirmEnvelope = () => {
    if (!report) return;
    const { request, errors } = validateEnvelopeRequest(
      envelopeDraft.boom,
      envelopeDraft.start,
      envelopeDraft.end,
      report.interval
    );
    setEnvelopeErrors(errors);
    if (errors.length > 0 || !request) {
      // 非法时保留文本、移除包络；碰撞结论不受影响。
      setConfirmedRequest(null);
      setSelectedEnvelopeEdge(null);
      return;
    }
    setConfirmedRequest(request);
    setSelectedEnvelopeEdge(null);
  };

  useEffect(() => {
    const first = envelopeErrors[0];
    if (!first) return;
    document.getElementById(fieldId(first.path))?.focus();
  }, [envelopeErrors]);

  const handleEnvelopeEdgeClick = useCallback((edgeId: number) => {
    setSelectedEnvelopeEdge(edgeId);
    setPlaying(false);
  }, []);

  // 选中边后回放跳到其首次出现的最早精确时刻（通过 rational->number，
  // 与既有回放时间管线一致；点击信息卡同步展示精确值）。
  useEffect(() => {
    if (selectedEnvelopeEdgeData) setPlayhead(ratToNumber(selectedEnvelopeEdgeData.firstTime));
  }, [selectedEnvelopeEdgeData]);

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
            envelope={envelope}
            selectedEnvelopeEdge={selectedEnvelopeEdge}
            onForbiddenVertexMove={moveForbiddenVertex}
            onKeyframePositionMove={moveKeyframePosition}
            onEnvelopeEdgeClick={handleEnvelopeEdgeClick}
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

          <div className="envelope-controls">
            <label>
              吊杆
              <select
                aria-label="包络吊杆"
                value={envelopeDraft.boom}
                onChange={(event) => setEnvelopeDraft((value) => ({ ...value, boom: event.target.value }))}
              >
                <option value="0">1 号吊杆</option>
                <option value="1">2 号吊杆</option>
              </select>
            </label>
            <EnvelopeField
              label="起始毫秒"
              path="envelope.start"
              value={envelopeDraft.start}
              error={envelopeErrorsByPath.get('envelope.start')}
              interval={report?.interval}
              onChange={(text) => {
                setEnvelopeErrors([]);
                setEnvelopeDraft((draftValue) => ({ ...draftValue, start: text }));
              }}
            />
            <EnvelopeField
              label="结束毫秒"
              path="envelope.end"
              value={envelopeDraft.end}
              error={envelopeErrorsByPath.get('envelope.end')}
              interval={report?.interval}
              onChange={(text) => {
                setEnvelopeErrors([]);
                setEnvelopeDraft((draftValue) => ({ ...draftValue, end: text }));
              }}
            />
            <button className="confirm-envelope" disabled={!report} onClick={confirmEnvelope}>
              确认计算占用包络
            </button>
          </div>
        </div>

        <div className="result-panel" aria-live="polite">
          {envelope ? (
            <article className="result envelope">
              <h2>占用包络</h2>
              <p data-testid="envelope-summary">
                吊杆 {envelope.boom + 1} · 区间 [{formatRat(envelope.start)}, {formatRat(envelope.end)}] ms
              </p>
              <p>
                精确面积：<strong data-testid="envelope-area">{formatRat(envelope.area)}</strong> mm²
                ；外环 <strong data-testid="envelope-outers">{envelope.outerLoops.length}</strong> 个，
                孔洞 <strong data-testid="envelope-holes">{envelope.holes.length}</strong> 个。
              </p>
              {selectedEnvelopeEdgeData ? (
                <dl className="envelope-edge-info" data-testid="envelope-edge-info">
                  <dt>最早时刻</dt>
                  <dd>{formatRat(selectedEnvelopeEdgeData.firstTime)} ms（回放已跳转）</dd>
                  <dt>源关键帧段</dt>
                  <dd>
                    第 {selectedEnvelopeEdgeData.segment + 1} 段 ·
                    [{formatRat(selectedEnvelopeEdgeData.segmentStart)},{' '}
                    {formatRat(selectedEnvelopeEdgeData.segmentEnd)}] ms
                  </dd>
                  <dt>源轮廓特征</dt>
                  <dd>
                    {selectedEnvelopeEdgeData.feature.kind === 'edge'
                      ? `轮廓边 E${selectedEnvelopeEdgeData.feature.index + 1}`
                      : `轮廓顶点 V${selectedEnvelopeEdgeData.feature.index + 1}`}
                  </dd>
                </dl>
              ) : (
                <p className="envelope-hint">点击画布上的青色包络边，回放跳到该边首次出现的最早精确时刻，并高亮对应源轮廓特征。</p>
              )}
            </article>
          ) : null}
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

function EnvelopeField({
  label,
  path,
  value,
  error,
  interval,
  onChange
}: {
  label: string;
  path: 'envelope.start' | 'envelope.end';
  value: string;
  error?: FieldError;
  interval?: { start: Rat; end: Rat };
  onChange: (value: string) => void;
}) {
  return (
    <label className={`number-field envelope-field ${error ? 'invalid' : ''}`} htmlFor={fieldId(path)}>
      <span>
        {label}
        {interval ? `（共同区间 ${formatRat(interval.start)}–${formatRat(interval.end)}）` : ''}
      </span>
      <input
        id={fieldId(path)}
        inputMode="numeric"
        value={value}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${fieldId(path)}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? <small id={`${fieldId(path)}-error`}>{error.message}</small> : null}
    </label>
  );
}
