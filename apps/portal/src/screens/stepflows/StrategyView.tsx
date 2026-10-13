import {
  Alert,
  Button,
  Checkbox,
  Fieldset,
  Heading,
  Paragraph,
  Switch,
  Table,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import {
  agentTrace,
  recommendation,
  type Strategy,
  type StrategyField,
} from '../../data/stepflows';
import { useFormat } from '@genai/i18n/react';
import { useT } from '../../i18n';
import { SelectField } from './fields';
import type { Flash } from './FlowEditor';

type Values = Record<string, StrategyField['def']>;

export const StrategyView = ({
  strategy: s,
  onFlash,
  onUse,
}: {
  strategy: Strategy;
  onFlash: (flash: Flash) => void;
  onUse: (id: Strategy['id']) => void;
}) => {
  const t = useT();
  const fmt = useFormat();
  const [values, setValues] = useState<Record<string, Values>>({});
  const current: Values = {
    ...Object.fromEntries(s.fields.map((f) => [f.id, f.def])),
    ...values[s.id],
  };
  const set = (k: string, v: StrategyField['def']) =>
    setValues((all) => ({ ...all, [s.id]: { ...all[s.id], [k]: v } }));
  const errorOf = (f: StrategyField) => {
    if (f.type !== 'int') return '';
    const v = current[f.id];
    const n = Number(v);
    if (v === '' || Number.isNaN(n) || !Number.isInteger(n)) return t('stepflows.intError');
    if (n < (f.min ?? 0) || n > (f.max ?? Infinity))
      return t('stepflows.intBetween', { min: f.min ?? 0, max: f.max ?? 0 });
    return '';
  };
  const bad = s.fields.some((f) => errorOf(f));
  const steps = Number(current.maks_steg ?? 8);

  return (
    <div className="stack-md">
      <section aria-labelledby="str-h" className="strategy-head">
        <div className="row-wrap">
          <Heading level={2} data-size="xs" id="str-h">
            {s.name}
          </Heading>
          {s.tags.map(([l, c]) => (
            <Tag key={l} data-size="sm" data-color={c}>
              {l}
            </Tag>
          ))}
        </div>
        <Paragraph>{s.desc}</Paragraph>
        <Paragraph data-size="sm">
          <strong>{t('stepflows.pickWhen')}</strong> {s.when}
        </Paragraph>
        {s.note ? (
          <Alert data-color="info" data-size="sm">
            {s.note}
          </Alert>
        ) : null}
      </section>

      <section aria-labelledby="slik-h" className="stack-sm">
        <Heading level={2} data-size="2xs" id="slik-h">
          {t('stepflows.howItRuns')}
        </Heading>
        <ol className="pipeline">
          {s.pipeline.map(([icon, title, description, repeats], i) => (
            <li key={title}>
              {i > 0 ? (
                <span aria-hidden="true" className={`pipeline-line${repeats ? ' dashed' : ''}`} />
              ) : null}
              <span className={`pipeline-card${repeats ? ' repeats' : ''}`}>
                <span aria-hidden="true" className="flow-icon small">
                  {icon}
                </span>
                <span className="flow-text">
                  <strong className="small">{title}</strong>
                  <span className="meta">{description}</span>
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      {s.id === 'auto' ? (
        <section aria-labelledby="reco-h" className="recommendation">
          <Heading level={2} data-size="2xs" id="reco-h">
            {t('stepflows.recommends', { pick: recommendation.pick })}
          </Heading>
          <Paragraph data-size="sm">{recommendation.why}</Paragraph>
          <div
            tabIndex={0}
            role="region"
            aria-label={t('stepflows.compareLabel')}
            className="scroll-x"
          >
            <Table data-size="sm" className="reco-table">
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell scope="col">{t('stepflows.colStrategy')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col" className="right">
                    {t('stepflows.colTestSet')}
                  </Table.HeaderCell>
                  <Table.HeaderCell scope="col" className="right">
                    {t('stepflows.colPer1000')}
                  </Table.HeaderCell>
                  <Table.HeaderCell scope="col" className="right">
                    {t('stepflows.colLatency')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {recommendation.rows.map(([n, score, cost, time], i) => (
                  <Table.Row key={n} className={i === 1 ? 'strong' : undefined}>
                    <Table.HeaderCell scope="row">{n}</Table.HeaderCell>
                    <Table.Cell className="right">{score}</Table.Cell>
                    <Table.Cell className="right">{cost}</Table.Cell>
                    <Table.Cell className="right">{time}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
          <div>
            <Button
              data-size="sm"
              onClick={() => {
                onUse('agent');
                onFlash({
                  text: t('stepflows.pickedFlash'),
                  color: 'success',
                });
              }}
            >
              {t('stepflows.usePick', { pick: recommendation.pick })}
            </Button>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="inn-h" className="stack-sm">
        <Heading level={2} data-size="2xs" id="inn-h">
          {t('stepflows.settings')}
        </Heading>
        <p className="meta">{t('stepflows.settingsNote')}</p>
        {s.fields.map((f) => {
          const help = `${f.help}${f.type === 'int' ? `${f.help ? ' ' : ''}${t('stepflows.helpBetween', { min: f.min ?? 0, max: f.max ?? 0 })}` : ''}`;
          const id = `sf-${f.id}`;
          const v = current[f.id];
          return (
            <div key={f.id} className="strategy-field">
              {f.type === 'tools' ? (
                <Fieldset>
                  <Fieldset.Legend>{f.label}</Fieldset.Legend>
                  <Fieldset.Description>{f.help}</Fieldset.Description>
                  {(f.tools ?? []).map(([label, reach]) => {
                    const list = Array.isArray(v) ? v : [];
                    return (
                      <Checkbox
                        key={label}
                        label={label}
                        description={reach}
                        checked={list.includes(label)}
                        onChange={() =>
                          set(
                            f.id,
                            list.includes(label)
                              ? list.filter((x) => x !== label)
                              : [...list, label],
                          )
                        }
                      />
                    );
                  })}
                </Fieldset>
              ) : f.type === 'enum' ? (
                <SelectField
                  id={id}
                  label={f.label}
                  {...(help ? { description: help } : {})}
                  value={String(v)}
                  options={(f.options ?? []).map((o) => ({ value: o, label: o }))}
                  onChange={(x) => set(f.id, x)}
                />
              ) : f.type === 'int' ? (
                <div className="narrow-field wide">
                  <Textfield
                    id={id}
                    label={f.label}
                    description={help}
                    inputMode="numeric"
                    value={String(v)}
                    error={errorOf(f) || undefined}
                    onChange={(e) => set(f.id, e.target.value === '' ? '' : Number(e.target.value))}
                  />
                </div>
              ) : (
                <Switch
                  label={f.label}
                  description={f.help}
                  checked={!!v}
                  onChange={() => set(f.id, !v)}
                />
              )}
            </div>
          );
        })}
      </section>

      {s.id === 'agent' ? (
        <section aria-labelledby="tr-h" className="stack-sm">
          <div className="row-wrap">
            <Heading level={2} data-size="2xs" id="tr-h">
              {t('stepflows.lastRun')}
            </Heading>
            <Tag data-size="sm" data-color="success">
              {t('stepflows.runStatusDone')}
            </Tag>
            <span className="small">
              {t('stepflows.traceSummary', {
                count: agentTrace.length,
                max: Number.isFinite(steps) ? steps : 8,
                time: fmt.decimal(4.7),
                tokens: fmt.number(4470),
              })}
            </span>
            <a href="#/log/opg_7f2kq9d1" className="small">
              {t('stepflows.openTimeline')}
            </a>
          </div>
          <ol className="trace-list">
            {agentTrace.map(([action, detail, meta], i) => (
              <li key={i}>
                <span className="meta trace-n">{t('stepflows.traceStep', { n: i + 1 })}</span>
                <span className="trace-d">
                  <strong>{action}</strong> {detail}
                </span>
                <span className="meta">{meta}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="actions">
        <Button
          onClick={() =>
            onFlash(
              bad
                ? { text: t('stepflows.fixSettings'), color: 'warning' }
                : {
                    text: t('stepflows.strategySaved', { name: s.name }),
                    color: 'success',
                  },
            )
          }
        >
          {t('stepflows.save')}
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            onFlash({
              text:
                s.id === 'agent'
                  ? t('stepflows.strategyTestAgent')
                  : t('stepflows.strategyTestDone'),
              color: 'success',
            })
          }
        >
          {t('stepflows.runTest')}
        </Button>
      </div>
    </div>
  );
};
