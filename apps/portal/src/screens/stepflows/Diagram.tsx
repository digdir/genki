import { Button, Tag } from '@digdir/designsystemet-react';
import { Icon, icons } from '../../components/Icon';
import { useT, type PlainKey } from '../../i18n';
import { blocks, type Flow, type RunState, type Step } from '../../data/stepflows';
import { controlName, errorLabel, type Analysis, type Guide, type Row } from './model';

const runLook: Record<RunState, ['success' | 'warning' | 'danger' | 'neutral', PlainKey]> = {
  ok: ['success', 'stepflows.runOk'],
  warn: ['warning', 'stepflows.runWarn'],
  fail: ['danger', 'stepflows.runFail'],
  wait: ['warning', 'stepflows.runWait'],
  none: ['neutral', 'stepflows.runNone'],
};

interface RunInfo {
  color: 'success' | 'warning' | 'danger' | 'neutral';
  label: string;
  time: string;
  tokens: string;
  note: string;
  notRun: boolean;
}

const Guides = ({ guides }: { guides: Guide[] }) => (
  <>
    {guides.map((g, i) => (
      <span key={i} aria-hidden="true" className="flow-guide">
        <span style={{ borderLeft: `2px ${g.style} ${g.color}` }} />
      </span>
    ))}
  </>
);

const RunBar = ({ run }: { run: RunInfo }) => {
  const t = useT();
  return (
    <div className="flow-run">
      <Tag data-size="sm" data-color={run.color}>
        {run.label}
      </Tag>
      {run.time ? <span>{run.time}</span> : null}
      {run.tokens ? <span>{t('stepflows.tokens', { tokens: run.tokens })}</span> : null}
      {run.note ? <span className="meta">{run.note}</span> : null}
    </div>
  );
};

interface Props {
  flow: Flow;
  analysis: Analysis;
  overlay: boolean;
  subOpen: Record<string, boolean>;
  onToggleSub: (id: string) => void;
  onOpen: (id: string) => void;
  onAdd: () => void;
  readOnly?: boolean;
}

export const Diagram = ({
  flow,
  analysis: a,
  overlay,
  subOpen,
  onToggleSub,
  onOpen,
  onAdd,
  readOnly = false,
}: Props) => {
  const t = useT();
  const refName = (r: string) => a.refs[r]?.label ?? r;
  const runOf = (id: string): RunInfo | null => {
    if (!overlay || !flow.run) return null;
    const r = flow.run.steps[id];
    if (!r)
      return {
        color: 'neutral',
        label: t('stepflows.runNone'),
        time: '',
        tokens: '',
        note: '',
        notRun: true,
      };
    const [color, label] = runLook[r[2]];
    return {
      color,
      label: t(label),
      time: r[0],
      tokens: r[1],
      note: r[3] ?? '',
      notRun: r[2] === 'none',
    };
  };
  const errText = (id: string) => {
    const e = readOnly ? [] : (a.errors.get(id) ?? []);
    return e.length > 1
      ? t('stepflows.moreErrors', { first: e[0] ?? '', count: e.length - 1 })
      : (e[0] ?? '');
  };
  const unknownText = (id: string) => {
    const n = readOnly ? 0 : (a.unknownParams[id]?.length ?? 0);
    return n === 0 ? '' : t('stepflows.unknownParams', { count: n });
  };
  const inputsText = (input: Record<string, string>) => {
    const e = Object.entries(input).filter(([, v]) => v);
    return e.length
      ? t('stepflows.inputsFrom', { sources: e.map(([, v]) => refName(v)).join('; ') })
      : '';
  };
  const paramsText = (s: Extract<Step, { kind: 'block' }>) => {
    const b = blocks[s.block];
    if (!b) return '';
    return b.params
      .map((param) => {
        const v = s.p[param.name];
        if (v === undefined || v === '') return null;
        const text =
          param.type === 'columns' && Array.isArray(v)
            ? t('stepflows.columnCount', { count: v.length })
            : param.type === 'bool'
              ? v
                ? t('stepflows.yes')
                : t('stepflows.no')
              : Array.isArray(v) && v.every((x) => typeof x === 'string')
                ? v.join(', ')
                : typeof v === 'object' && v !== null
                  ? t('stepflows.setInYaml')
                  : String(v as string | number).replace('.', ',');
        return `${param.label}: ${text}`;
      })
      .filter(Boolean)
      .join(' · ');
  };
  const last = flow.steps.at(-1);
  const outText = !last
    ? t('stepflows.outNoSteps')
    : last.kind === 'branch'
      ? t('stepflows.outBranch')
      : last.kind === 'block' && blocks[last.block]?.outputs[0]
        ? t('stepflows.outStep', {
            label: last.label,
            output: blocks[last.block]?.outputs[0]?.[0] || t('stepflows.refResults'),
          })
        : t('stepflows.outLast');

  const renderRow = (r: Row) => {
    if (r.kind === 'step') {
      const s = r.step;
      const b = blocks[s.block];
      const e = errText(s.id);
      const run = runOf(s.id);
      const failed = run?.color === 'danger';
      const content = (
        <>
          <span aria-hidden="true" className={b ? 'flow-icon' : 'flow-icon unknown'}>
            {b ? b.icon : '?'}
          </span>
          <span className="flow-text">
            <span className="row-wrap">
              <span className="flow-label">{s.label || s.id}</span>
              <span className="meta">
                {b
                  ? b.name
                  : s.block
                    ? t('stepflows.unknownBlockName', { block: s.block })
                    : t('stepflows.noBlock')}
              </span>
              {unknownText(s.id) ? (
                <Tag data-size="sm" data-color="warning">
                  {unknownText(s.id)}
                </Tag>
              ) : null}
            </span>
            {paramsText(s) ? <span className="small">{paramsText(s)}</span> : null}
            {inputsText(s.in) ? <span className="meta">{inputsText(s.in)}</span> : null}
            {e ? (
              <span className="flow-error">
                <Icon d={icons.warning} size={16} strokeWidth={2} />
                {e}
              </span>
            ) : null}
            {s.err !== 'stop' ? (
              <span className="meta">
                {s.err === 'use-default'
                  ? t('stepflows.onErrorDefault', {
                      action: t(errorLabel[s.err]),
                      value: s.def ?? '',
                    })
                  : t('stepflows.onErrorLine', { action: t(errorLabel[s.err]) })}
              </span>
            ) : null}
          </span>
        </>
      );
      return (
        <div
          className={`flow-card${e || failed ? ' has-error' : ''}${r.readonly ? ' readonly' : ''}${run?.notRun ? ' not-run' : ''}`}
        >
          {r.readonly || readOnly ? (
            <div
              className="flow-card-main"
              aria-label={t('stepflows.subStepLabel', { label: s.label || s.id })}
              role="group"
            >
              {content}
            </div>
          ) : (
            <button
              type="button"
              className="flow-card-main"
              aria-label={t('stepflows.editStep', { label: s.label || s.id })}
              onClick={() => onOpen(s.id)}
            >
              {content}
            </button>
          )}
          {run ? <RunBar run={run} /> : null}
        </div>
      );
    }
    if (r.kind === 'sub') {
      const s = r.step;
      const e = errText(s.id);
      const run = runOf(s.id);
      const open = !!subOpen[s.id];
      if (readOnly)
        return (
          <div className="flow-card readonly">
            <div
              className="flow-card-main"
              role="group"
              aria-label={t('stepflows.subStepLabel', { label: s.label })}
            >
              <span aria-hidden="true" className="flow-icon neutral">
                ⇣
              </span>
              <span className="flow-text">
                <span className="flow-label">{s.label}</span>
                <span className="meta">{t('stepflows.subKind', { name: s.flow })}</span>
              </span>
            </div>
          </div>
        );
      return (
        <div className={`flow-card${e ? ' has-error' : ''}`}>
          <button
            type="button"
            className="flow-card-main"
            aria-label={t('stepflows.editSub', { label: s.label })}
            onClick={() => onOpen(s.id)}
          >
            <span aria-hidden="true" className="flow-icon neutral">
              ⇣
            </span>
            <span className="flow-text">
              <span className="row-wrap">
                <span className="flow-label">{s.label}</span>
                <span className="meta">
                  {t('stepflows.subKind', {
                    name: r.flow ? `${r.flow.name} v${r.flow.version}` : s.flow,
                  })}
                </span>
              </span>
              {r.flow ? (
                <span className="small">
                  {t('stepflows.subSteps', { count: r.flow.steps.length })}
                </span>
              ) : null}
              {inputsText(s.in) ? <span className="meta">{inputsText(s.in)}</span> : null}
              {e ? <span className="flow-error">{e}</span> : null}
            </span>
          </button>
          {run ? <RunBar run={run} /> : null}
          <div className="flow-sub-toggle">
            <Button
              variant="tertiary"
              data-size="sm"
              aria-expanded={open}
              onClick={() => onToggleSub(s.id)}
            >
              {open ? t('stepflows.hideSub') : t('stepflows.showSub')}
            </Button>
          </div>
        </div>
      );
    }
    if (r.kind === 'control') {
      const s = r.step;
      const e = errText(s.id);
      const run = runOf(s.id);
      const text =
        s.kind === 'repeat'
          ? t('stepflows.repeatText', {
              ref: s.until.ref ? refName(s.until.ref) : '?',
              value: s.until.val || '?',
              max: s.max === '' ? '?' : s.max,
            })
          : s.kind === 'foreach'
            ? t('stepflows.foreachText', {
                list: s.over ? refName(s.over) : '?',
                name: s.as || '?',
              })
            : t('stepflows.branchText', { value: s.on ? refName(s.on) : '?' });
      const color = s.kind === 'repeat' ? 'warning' : s.kind === 'foreach' ? 'info' : 'accent';
      if (readOnly)
        return (
          <div className={`flow-control ${s.kind}`}>
            <span className="row-wrap">
              <Tag data-size="sm" data-color={color}>
                {t(controlName[s.kind])}
              </Tag>
              <span className="flow-label">{s.label}</span>
            </span>
            <span className="small">{text}</span>
          </div>
        );
      return (
        <button
          type="button"
          className={`flow-control ${s.kind}${e ? ' has-error' : ''}`}
          aria-label={t('stepflows.editControl', {
            kind: t(controlName[s.kind]).toLowerCase(),
            label: s.label,
          })}
          onClick={() => onOpen(s.id)}
        >
          <span className="row-wrap">
            <Tag data-size="sm" data-color={color}>
              {t(controlName[s.kind])}
            </Tag>
            <span className="flow-label">{s.label}</span>
          </span>
          <span className="small">{text}</span>
          {e ? <span className="flow-error">{e}</span> : null}
          {run ? (
            <span className="row-wrap small">
              <Tag data-size="sm" data-color={run.color}>
                {run.label}
              </Tag>
              {run.time} {run.note}
            </span>
          ) : null}
        </button>
      );
    }
    if (r.kind === 'case') {
      const taken =
        overlay && flow.run && flow.run.steps[r.branch.id]?.[3] === r.when
          ? t('stepflows.taken')
          : '';
      return (
        <span className={`flow-case${r.err ? ' has-error' : taken ? ' taken' : ''}`}>
          {r.label}
          {r.err ? <span className="flow-case-note">· {r.err}</span> : null}
          {taken ? <span className="flow-case-note">· {taken}</span> : null}
        </span>
      );
    }
    return (
      <span className="flow-end">
        <Icon d="M4 12a8 8 0 1 0 3-6.2 M4 4v4h4" size={16} strokeWidth={1.8} />
        {r.label}
      </span>
    );
  };

  return (
    <ol aria-label={t('stepflows.diagramLabel')} className="flow-diagram">
      <li className="flow-pill-row">
        <span className="flow-pill">
          <strong>{t('stepflows.start')}</strong> ·{' '}
          {t('stepflows.startInput', {
            inputs: flow.input.map(([n, type]) => `${n} (${type})`).join(', '),
          })}
        </span>
      </li>
      {a.rows.map((r, i) => (
        <li key={`${r.kind}-${'step' in r ? r.step.id : r.label}-${i}`} className="flow-row">
          <Guides guides={r.guides} />
          <div className="flow-cell">
            <span aria-hidden="true" className="flow-connector" />
            {renderRow(r)}
          </div>
        </li>
      ))}
      <li className="flow-end-row">
        <span aria-hidden="true" className="flow-connector" />
        <span className="flow-pill">
          <strong>{t('stepflows.endPill', { out: outText })}</strong>
        </span>
        {readOnly ? null : (
          <Button variant="secondary" data-size="sm" onClick={onAdd}>
            <Icon d={icons.plus} size={18} />
            {t('stepflows.addStep')}
          </Button>
        )}
      </li>
    </ol>
  );
};
