import {
  Alert,
  Button,
  Fieldset,
  Heading,
  Paragraph,
  Radio,
  Textarea,
  Textfield,
  ToggleGroup,
} from '@digdir/designsystemet-react';
import { Fragment } from 'react';
import { SidePanel } from '../../components/SidePanel';
import { useT, type PlainKey } from '../../i18n';
import { blocks, type Flow, type OnError, type Step } from '../../data/stepflows';
import { SelectField, type Option } from './fields';
import {
  columnSources,
  controlName,
  maxRepeat,
  omit,
  refParts,
  refVisible,
  type Analysis,
} from './model';
import { ParamFields } from './ParamFields';
import { TemplateText } from './TemplateText';

interface Props {
  draft: Step;
  setDraft: (next: Step) => void;
  base: Analysis;
  errors: string[];
  flows: Record<string, Flow>;
  onApply: () => void;
  onClose: () => void;
  onAddAfter: () => void;
  onRemove: () => void;
}

const loopErrorOptions: [OnError, PlainKey, PlainKey][] = [
  ['stop', 'stepflows.loopErrorStop', 'stepflows.loopErrorStopHelp'],
  ['skip', 'stepflows.loopErrorSkip', 'stepflows.loopErrorSkipHelp'],
];

const shownValue = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

const withCurrent = (options: Option[], value: string): Option[] =>
  value && !options.some((o) => o.value === value)
    ? [{ value, label: value }, ...options]
    : options;

const errorOptions: [OnError, PlainKey, PlainKey][] = [
  ['stop', 'stepflows.stepErrorStop', 'stepflows.stepErrorStopHelp'],
  ['skip', 'stepflows.stepErrorSkip', 'stepflows.stepErrorSkipHelp'],
  ['use-default', 'stepflows.stepErrorDefault', 'stepflows.stepErrorDefaultHelp'],
];

export const StepPanel = ({
  draft: d,
  setDraft,
  base,
  errors,
  flows,
  onApply,
  onClose,
  onAddAfter,
  onRemove,
}: Props) => {
  const t = useT();
  const visible = base.visibleAt[d.id] ?? [];
  const refOptions = (list: string[]): Option[] =>
    list.map((r) => {
      const info = base.refs[r];
      return { value: r, label: `${info?.label ?? r}${info?.type ? ` (${info.type})` : ''}` };
    });

  const refChoices = refOptions(visible.filter((r) => r !== 'loop'));
  const inputFields = (
    inputs: [string, string, boolean][],
    values: Record<string, string>,
    raw: Record<string, unknown> | undefined,
    set: (v: Record<string, string>, raw: Record<string, unknown> | undefined) => void,
  ) =>
    inputs.map(([n, type, required]) => {
      const v = values[n] ?? '';
      const fixed = raw?.[n];
      const mode = fixed !== undefined ? 'text' : 'ref';
      const err =
        required && !v && fixed === undefined
          ? t('stepflows.chooseInputSource', { name: n })
          : v && !refParts(v).every((r) => refVisible(r, visible))
            ? t('stepflows.valueMissing')
            : '';
      const without = () => ({
        in: Object.fromEntries(Object.entries(values).filter(([k]) => k !== n)),
        raw: Object.fromEntries(Object.entries(raw ?? {}).filter(([k]) => k !== n)),
      });
      const setMode = (next: string) => {
        if (next === mode) return;
        const rest = without();
        if (next === 'text') rest.raw[n] = '';
        set(rest.in, Object.keys(rest.raw).length ? rest.raw : undefined);
      };
      const choose = (value: string) => {
        const rest = without();
        if (value) rest.in[n] = value;
        set(rest.in, Object.keys(rest.raw).length ? rest.raw : undefined);
      };
      const setJson = (text: string) => {
        const parsed = (() => {
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return text;
          }
        })();
        set(values, { ...raw, [n]: parsed });
      };
      return (
        <Fieldset key={n} data-size="sm" className="input-source">
          <Fieldset.Legend>
            {n}{' '}
            <span className="meta">
              {t(required ? 'stepflows.inputMetaRequired' : 'stepflows.inputMeta', { type })}
            </span>
          </Fieldset.Legend>
          <ToggleGroup
            data-size="sm"
            aria-label={t('stepflows.sourceOf', { name: n })}
            value={mode}
            onChange={setMode}
          >
            <ToggleGroup.Item value="ref">{t('stepflows.fromStep')}</ToggleGroup.Item>
            <ToggleGroup.Item value="text">{t('stepflows.fixedValue')}</ToggleGroup.Item>
          </ToggleGroup>
          {mode === 'ref' ? (
            <SelectField
              id={`in-${n}`}
              size="sm"
              label={t('stepflows.valueFromStep')}
              description={t('stepflows.directLink')}
              value={v}
              placeholder={t('stepflows.choose')}
              options={withCurrent(refChoices, v)}
              error={err}
              onChange={choose}
            />
          ) : typeof fixed === 'string' ? (
            <TemplateText
              id={`in-${n}-tekst`}
              value={fixed}
              visible={visible}
              refs={refChoices}
              onChange={(text) => set(values, { ...raw, [n]: text })}
            />
          ) : (
            <Textarea
              id={`in-${n}-tekst`}
              aria-label={t('stepflows.valueFor', { name: n })}
              rows={3}
              value={JSON.stringify(fixed, null, 2)}
              onChange={(e) => setJson(e.target.value)}
            />
          )}
        </Fieldset>
      );
    });

  const kindLabel = d.kind === 'block' ? t('stepflows.stepKind') : t(controlName[d.kind]);

  return (
    <SidePanel
      title={d.label || d.id}
      eyebrow={t('stepflows.eyebrow', { kind: kindLabel, id: d.id })}
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" onClick={onApply}>
            {t('stepflows.apply')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('stepflows.cancel')}
          </Button>
          <Button variant="tertiary" onClick={onAddAfter}>
            {t('stepflows.addBelow')}
          </Button>
          <Button variant="tertiary" data-color="danger" onClick={onRemove}>
            {t('stepflows.removeStep')}
          </Button>
        </>
      }
    >
      {errors.length ? (
        <Alert data-color="danger" data-size="sm">
          <ul className="bullets">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <Textfield
        id="p-navn"
        label={t('stepflows.stepName')}
        value={d.label}
        onChange={(e) => setDraft({ ...d, label: e.target.value })}
      />

      {d.kind === 'block'
        ? (() => {
            const b = blocks[d.block];
            const blockOptions: Option[] = [
              ...(d.block && !b
                ? [{ value: d.block, label: t('stepflows.unknownSuffix', { block: d.block }) }]
                : []),
              ...Object.entries(blocks).map(([k, x]) => ({ value: k, label: x.name })),
            ];
            const known = new Set(b?.params.map((param) => param.name) ?? []);
            const extra = b ? Object.keys(d.p).filter((k) => !known.has(k)) : [];
            return (
              <>
                <SelectField
                  id="p-blokk"
                  label={t('stepflows.blockLabel')}
                  {...(b?.desc ? { description: b.desc } : {})}
                  value={d.block}
                  options={blockOptions}
                  {...(d.block ? {} : { placeholder: t('stepflows.choose') })}
                  error={
                    b
                      ? ''
                      : d.block
                        ? t('stepflows.blockGone', { block: d.block })
                        : t('stepflows.chooseBlock')
                  }
                  onChange={(block) =>
                    setDraft({
                      kind: 'block',
                      id: d.id,
                      label: d.label,
                      block,
                      in: {},
                      p: {},
                      err: d.err,
                      ...(d.def === undefined ? {} : { def: d.def }),
                    })
                  }
                />
                {b ? (
                  <Fieldset>
                    <Fieldset.Legend>{t('stepflows.inputLegend')}</Fieldset.Legend>
                    <Fieldset.Description>
                      {t('stepflows.inputHelp', { placeholder: '{{steg.verdi}}' })}
                    </Fieldset.Description>
                    <div className="stack-sm">
                      {inputFields(b.inputs, d.in, d.raw, (v, raw) => {
                        setDraft({ ...omit(d, 'raw'), in: v, ...(raw ? { raw } : {}) });
                      })}
                    </div>
                  </Fieldset>
                ) : null}
                {b && (b.params.length || extra.length) ? (
                  <Fieldset>
                    <Fieldset.Legend>{t('stepflows.paramsLegend')}</Fieldset.Legend>
                    <div className="stack-sm">
                      <ParamFields
                        block={b}
                        values={d.p}
                        columnSources={columnSources(d, base)}
                        onChange={(p) => setDraft({ ...d, p })}
                      />
                      {extra.length ? (
                        <section className="stack-xs" aria-labelledby="p-andre-h">
                          <Heading level={3} data-size="2xs" id="p-andre-h">
                            {t('stepflows.extraParams')}
                          </Heading>
                          <Alert data-color="warning" data-size="sm">
                            {t('stepflows.extraParamsNote')}
                          </Alert>
                          <dl className="param-extra">
                            {extra.map((k) => (
                              <Fragment key={k}>
                                <dt>
                                  <code>{k}</code>
                                </dt>
                                <dd>{shownValue(d.p[k])}</dd>
                              </Fragment>
                            ))}
                          </dl>
                        </section>
                      ) : null}
                    </div>
                  </Fieldset>
                ) : null}
                <Fieldset>
                  <Fieldset.Legend>{t('stepflows.onFailLegend')}</Fieldset.Legend>
                  {errorOptions.map(([value, label, desc]) => (
                    <Radio
                      key={value}
                      name="vedfeil"
                      value={value}
                      label={t(label)}
                      description={t(desc)}
                      checked={d.err === value}
                      onChange={() => setDraft({ ...d, err: value })}
                    />
                  ))}
                  {d.err === 'use-default' ? (
                    <div className="indented">
                      <Textfield
                        id="p-def"
                        data-size="sm"
                        label={t('stepflows.defaultValue')}
                        value={d.def ?? ''}
                        aria-invalid={d.def ? undefined : true}
                        onChange={(e) => setDraft({ ...omit(d, 'defRaw'), def: e.target.value })}
                      />
                    </div>
                  ) : null}
                </Fieldset>
              </>
            );
          })()
        : null}

      {d.kind === 'repeat' ? (
        <>
          <SelectField
            id="p-til"
            label={t('stepflows.repeatUntil')}
            value={d.until.ref}
            placeholder={t('stepflows.choose')}
            options={withCurrent(
              refOptions(
                d.steps.flatMap((s) =>
                  s.kind === 'block' && blocks[s.block]
                    ? (blocks[s.block]?.outputs ?? []).map(([o]) =>
                        o ? `steps.${s.id}.${o}` : `steps.${s.id}`,
                      )
                    : [],
                ),
              ),
              d.until.ref,
            )}
            onChange={(ref) => setDraft({ ...d, until: { ref, val: d.until.val } })}
          />
          <div className="narrow-field">
            <Textfield
              id="p-er"
              label={t('stepflows.repeatIs')}
              value={d.until.val}
              onChange={(e) => setDraft({ ...d, until: { ref: d.until.ref, val: e.target.value } })}
            />
          </div>
          <div className="narrow-field">
            <Textfield
              id="p-maks"
              label={t('stepflows.maxRounds')}
              description={t('stepflows.maxRoundsHelp', { max: maxRepeat })}
              inputMode="numeric"
              value={d.max === '' ? '' : String(d.max)}
              aria-invalid={d.max === '' || d.max < 1 || d.max > maxRepeat ? true : undefined}
              onChange={(e) =>
                setDraft({ ...d, max: e.target.value === '' ? '' : Number(e.target.value) })
              }
            />
          </div>
        </>
      ) : null}

      {d.kind === 'foreach' ? (
        <>
          <SelectField
            id="p-over"
            label={t('stepflows.foreachIn')}
            value={d.over}
            placeholder={t('stepflows.choose')}
            options={withCurrent(refOptions(visible), d.over)}
            onChange={(over) => setDraft({ ...d, over })}
          />
          <div className="narrow-field">
            <Textfield
              id="p-som"
              label={t('stepflows.itemName')}
              value={d.as}
              onChange={(e) => setDraft({ ...d, as: e.target.value.replace(/[^\wæøå-]/g, '') })}
            />
          </div>
          <Fieldset>
            <Fieldset.Legend>{t('stepflows.itemFails')}</Fieldset.Legend>
            {loopErrorOptions.map(([value, label, desc]) => (
              <Radio
                key={value}
                name="vedfeil-element"
                value={value}
                label={t(label)}
                description={t(desc)}
                checked={(d.err ?? 'stop') === value}
                onChange={() => setDraft({ ...omit(d, 'def', 'defRaw'), err: value })}
              />
            ))}
          </Fieldset>
        </>
      ) : null}

      {d.kind === 'branch'
        ? (() => {
            const source = /^steps\.([^.]+)\.label$/.exec(d.on)?.[1];
            const src = source ? base.all.find((x) => x.id === source) : undefined;
            const known =
              src?.kind === 'block' && Array.isArray(src.p.labels) ? src.p.labels.join(', ') : '';
            return (
              <>
                <SelectField
                  id="p-on"
                  label={t('stepflows.switchOn')}
                  value={d.on}
                  placeholder={t('stepflows.choose')}
                  options={withCurrent(refOptions(visible), d.on)}
                  onChange={(on) => setDraft({ ...d, on })}
                />
                <Fieldset>
                  <Fieldset.Legend>{t('stepflows.casesLegend')}</Fieldset.Legend>
                  {known ? (
                    <Fieldset.Description>
                      {t('stepflows.possibleValues', { values: known })}
                    </Fieldset.Description>
                  ) : null}
                  {d.cases.map((c, ci) => (
                    <div key={ci} className="case-row">
                      <Textfield
                        id={`case-${ci}`}
                        data-size="sm"
                        label={t('stepflows.whenValue')}
                        value={c.when}
                        onChange={(e) =>
                          setDraft({
                            ...d,
                            cases: d.cases.map((x, j) =>
                              j === ci ? { when: e.target.value, steps: x.steps } : x,
                            ),
                          })
                        }
                      />
                      <Button
                        variant="tertiary"
                        data-size="sm"
                        aria-label={t('stepflows.removeCaseLabel', { when: c.when })}
                        onClick={() =>
                          setDraft({ ...d, cases: d.cases.filter((_, j) => j !== ci) })
                        }
                      >
                        {t('stepflows.remove')}
                      </Button>
                    </div>
                  ))}
                  <div>
                    <Button
                      variant="secondary"
                      data-size="sm"
                      onClick={() =>
                        setDraft({
                          ...d,
                          cases: [...d.cases, { when: t('stepflows.newValue'), steps: [] }],
                        })
                      }
                    >
                      {t('stepflows.addCase')}
                    </Button>
                  </div>
                  <Paragraph data-size="xs" className="meta">
                    {t('stepflows.elseNote')}
                  </Paragraph>
                </Fieldset>
              </>
            );
          })()
        : null}

      {d.kind === 'sub' ? (
        <>
          <SelectField
            id="p-sub"
            label={t('stepflows.subLabel')}
            value={d.flow}
            options={Object.values(flows)
              .filter((x) => x.sub)
              .map((x) => ({ value: x.id, label: `${x.name} v${x.version}` }))}
            onChange={(flow) => setDraft({ ...omit(d, 'version', 'raw'), flow, in: {} })}
          />
          {inputFields(
            (flows[d.flow]?.input ?? []).map(
              ([n, type]) => [n, type, true] as [string, string, boolean],
            ),
            d.in,
            d.raw,
            (v, raw) => setDraft({ ...omit(d, 'raw'), in: v, ...(raw ? { raw } : {}) }),
          )}
        </>
      ) : null}
    </SidePanel>
  );
};
