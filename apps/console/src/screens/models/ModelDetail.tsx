import {
  Button,
  Checkbox,
  Fieldset,
  FieldsetLegend,
  Heading,
  Label,
  Link,
  Paragraph,
  Select,
  SelectOption,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import { ApiError } from '../../api';
import { maturityLabel } from '../../descriptors';
import { useT, type PlainKey } from '../../i18n';
import { operationName } from '../../model-operations';
import { EmptyState } from '../../states';
import { useTenantNames } from '../../tenant-names';
import type { Capability, ModelClassification, OperatorModel, Residency } from '../../types';
import { DialogError, ReasonDialog, TableRegion, VisuallyHidden } from '../../ui';
import {
  boundOf,
  familiesOf,
  kindMaturity,
  modelsHref,
  originOf,
  type ApiOrigin,
  type AreaProps,
} from './area-data';
import { BindDialog, type Binding } from './BindDialog';
import { Crumbs } from './ConnectionDetail';
import { capabilityLabel, PriceDialog, residencyLabel } from './Endpoints';
import { ModelStatus } from './ModelList';
import { ParametersDialog, parameterNames, RejectedHint, ruleText } from './Parameters';
import { priceText } from './prices';

export const originLabel: Record<ApiOrigin, PlainKey> = {
  'built-in': 'apis.originBuiltIn',
  'built-in-described': 'apis.originBuiltInDescribed',
  bundled: 'apis.originBundled',
  uploaded: 'apis.originUploaded',
};

type Change = 'residency' | 'capabilities' | 'enable' | 'retire';

const residencies = Object.keys(residencyLabel) as Residency[];
const capabilities = Object.keys(capabilityLabel) as Capability[];

const detailOf = (error: unknown) =>
  error instanceof ApiError ? (error.problem?.errors ?? []).map((e) => e.message) : [];

export const ModelDetail = ({ api, data, done, id }: AreaProps & { id: string }) => {
  const t = useT();
  const f = useFormat();
  const tenantName = useTenantNames(api);
  const [change, setChange] = useState<Change | undefined>();
  const [residency, setResidency] = useState<Residency>('global');
  const [chosen, setChosen] = useState<Capability[]>([]);
  const [binding, setBinding] = useState<Binding | undefined>();
  const [pricing, setPricing] = useState<OperatorModel | undefined>();
  const [parameters, setParameters] = useState<OperatorModel | undefined>();
  const model = data.models.find((m) => m.id === id);
  if (!model)
    return (
      <>
        <Crumbs trail={[{ label: id }]} />
        <EmptyState title={t('models.notFound', { id })}>
          <Link href={modelsHref({ tab: 'models' })}>{t('models.backToList')}</Link>
        </EmptyState>
      </>
    );
  const families = familiesOf(data.connections?.find((c) => c.id === model.endpoint));
  const bound = Object.entries(boundOf(model));
  const apiOf = (apiId: string) => data.apis?.find((a) => a.id === apiId);
  const open = (next: Change) => {
    setResidency(model.residency);
    setChosen(model.capabilities);
    setChange(next);
  };

  const classify = async (classification: ModelClassification, reason: string) => {
    try {
      await api.classifyModel(model.id, classification, reason);
    } catch (error) {
      throw new DialogError(
        [t('models.saveFailed', { model: model.deployment }), ...detailOf(error)].join(' '),
      );
    }
  };

  const changes: Record<
    Change,
    { title: string; text?: PlainKey; cta: PlainKey; run: (reason: string) => Promise<void> }
  > = {
    residency: {
      title: t('models.residencyTitle', { model: model.deployment }),
      text: 'models.residencyText',
      cta: 'models.saveChange',
      run: async (reason) => {
        if (residency === model.residency) throw new DialogError(t('models.unchanged'));
        await classify({ residency }, reason);
        done(t('models.saved', { model: model.deployment }));
      },
    },
    capabilities: {
      title: t('models.capabilitiesTitle', { model: model.deployment }),
      cta: 'models.saveChange',
      run: async (reason) => {
        await classify({ capabilities: chosen }, reason);
        done(t('models.saved', { model: model.deployment }));
      },
    },
    enable: {
      title: t('models.enableTitle', { model: model.deployment }),
      text: 'models.enableText',
      cta: 'models.enable',
      run: async (reason) => {
        await classify({ enabled: true }, reason);
        done(t('models.enabledDone', { model: model.deployment }));
      },
    },
    retire: {
      title: t('models.retireTitle', { model: model.deployment }),
      text: 'models.retireText',
      cta: 'models.retire',
      run: async (reason) => {
        await classify({ enabled: false }, reason);
        done(t('models.retired', { model: model.deployment }));
      },
    },
  };
  const current = change ? changes[change] : undefined;

  return (
    <>
      <Crumbs
        trail={[
          { label: model.endpoint, href: modelsHref({ connection: model.endpoint }) },
          { label: model.deployment },
        ]}
      />
      <div className="page-head-row">
        <div className="page-header">
          <span className="eyebrow">{t('models.eyebrow')}</span>
          <Heading level={1} data-size="lg">
            {model.deployment}
          </Heading>
          <ModelStatus model={model} />
        </div>
        <Button
          variant="secondary"
          data-color={model.enabled ? 'danger' : 'accent'}
          onClick={() => open(model.enabled ? 'retire' : 'enable')}
        >
          {model.enabled ? t('models.retire') : t('models.enable')}
        </Button>
      </div>
      <section className="card stack" aria-labelledby="model-facts-h">
        <Heading level={2} data-size="xs" id="model-facts-h">
          {t('models.factsTitle')}
        </Heading>
        <dl className="def-list">
          <dt>{t('models.colConnection')}</dt>
          <dd>
            <Link href={modelsHref({ connection: model.endpoint })}>{model.endpoint}</Link>
          </dd>
          <dt>{t('models.id')}</dt>
          <dd>
            <code>{model.id}</code>
          </dd>
          <dt>{t('endpoints.deployment')}</dt>
          <dd>{model.deployment}</dd>
          <dt>{t('endpoints.family')}</dt>
          <dd>{model.family ?? '–'}</dd>
          <dt>{t('models.colSource')}</dt>
          <dd>
            {model.origin === 'discovered' ? t('models.discoveredAuto') : t('models.fromCatalog')}
          </dd>
          <dt>{t('models.colResidency')}</dt>
          <dd>
            <span className="actions-row">
              {t(residencyLabel[model.residency])}
              <Button variant="tertiary" data-size="sm" onClick={() => open('residency')}>
                {t('models.change')} <VisuallyHidden>{t('models.colResidency')}</VisuallyHidden>
              </Button>
            </span>
            <span className="meta">{t('models.globalStandardHint')}</span>
          </dd>
          <dt>{t('models.colCan')}</dt>
          <dd>
            <span className="actions-row">
              {model.capabilities.map((c) => t(capabilityLabel[c])).join(', ') || '–'}
              <Button variant="tertiary" data-size="sm" onClick={() => open('capabilities')}>
                {t('models.change')} <VisuallyHidden>{t('models.colCan')}</VisuallyHidden>
              </Button>
            </span>
          </dd>
          <dt>{t('models.colPrice')}</dt>
          <dd>
            <span className="actions-row">
              {priceText(model.price, f, t)}
              <Button variant="tertiary" data-size="sm" onClick={() => setPricing(model)}>
                {t('models.setPrice')}
              </Button>
            </span>
          </dd>
          <dt>{t('modelParameters.open')}</dt>
          <dd>
            <span className="actions-row">
              {parameterNames
                .flatMap((n) => {
                  const rule = model.parameters?.[n];
                  return rule ? [ruleText(t, n, rule)] : [];
                })
                .join(', ') || '–'}
              <Button variant="tertiary" data-size="sm" onClick={() => setParameters(model)}>
                {t('models.change')} <VisuallyHidden>{t('modelParameters.open')}</VisuallyHidden>
              </Button>
            </span>
            <RejectedHint model={model} />
          </dd>
        </dl>
      </section>
      <section className="card stack" aria-labelledby="model-apis-h">
        <div className="card-head">
          <Heading level={2} data-size="xs" id="model-apis-h">
            {t('models.apisTitle')}
          </Heading>
          <Button
            variant="secondary"
            data-size="sm"
            disabled={!data.apis}
            onClick={() => setBinding({ model })}
          >
            {t('models.addKind')}
          </Button>
        </div>
        <Paragraph data-size="sm">
          {t('models.apisIntro', {
            connection: model.endpoint,
            families: families?.join(', ') ?? '–',
          })}
        </Paragraph>
        {bound.length === 0 ? (
          <Paragraph data-size="sm">{t('models.noKinds')}</Paragraph>
        ) : (
          <TableRegion label={t('models.apisTitle')}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">{t('models.kind')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('apis.colApi')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('apis.colSource')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('apis.colMaturity')}</TableHeaderCell>
                  <TableHeaderCell scope="col">
                    <VisuallyHidden>{t('models.colActions')}</VisuallyHidden>
                  </TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {bound.map(([kind, apiId]) => {
                  const found = apiOf(apiId);
                  const maturity = kindMaturity(data.kinds?.data, kind);
                  return (
                    <TableRow key={kind}>
                      <TableHeaderCell scope="row">{operationName(kind, t)}</TableHeaderCell>
                      <TableCell>
                        <Link href={modelsHref({ api: apiId })}>
                          <code>{apiId}</code>
                        </Link>
                      </TableCell>
                      <TableCell>
                        {found ? t(originLabel[originOf(found, data.descriptors)]) : '–'}
                      </TableCell>
                      <TableCell>
                        {maturity === 'built-in' ? (
                          <span className="meta">{t('apis.kindBuiltIn')}</span>
                        ) : maturity ? (
                          <Tag
                            data-size="sm"
                            data-color={maturity === 'production' ? 'success' : 'warning'}
                          >
                            {t(maturityLabel[maturity])}
                          </Tag>
                        ) : (
                          '–'
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          disabled={!data.apis}
                          aria-label={t('models.changeApiFor', { kind: operationName(kind, t) })}
                          onClick={() => setBinding({ model, kind })}
                        >
                          {t('models.change')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableRegion>
        )}
      </section>
      <section className="card stack" aria-labelledby="model-usage-h">
        <Heading level={2} data-size="xs" id="model-usage-h">
          {model.usage
            ? t('models.affectedCount', { count: model.usage.length })
            : t('models.affected')}
        </Heading>
        {model.usage?.length ? (
          <ul className="service-list">
            {model.usage.map((u) => (
              <li key={`${u.tenant}/${u.service}/${u.role}`}>
                <span>
                  <strong>{u.service}</strong> · {tenantName(u.tenant)}
                </span>
                <span className="meta">{u.role}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Paragraph data-size="sm">
            {model.usage ? t('models.usageNone') : t('models.usageUnknown')}
          </Paragraph>
        )}
      </section>
      <ReasonDialog
        open={Boolean(current)}
        title={current?.title ?? ''}
        text={current?.text ? t(current.text) : undefined}
        confirmLabel={current ? t(current.cta) : ''}
        onClose={() => setChange(undefined)}
        {...(current ? { onConfirm: current.run } : {})}
      >
        {change === 'residency' ? (
          <div className="field">
            <Label htmlFor="model-residency-change">{t('models.colResidency')}</Label>
            <Select
              id="model-residency-change"
              value={residency}
              onChange={(e) => setResidency(e.target.value as Residency)}
            >
              {residencies.map((r) => (
                <SelectOption key={r} value={r}>
                  {t(residencyLabel[r])}
                </SelectOption>
              ))}
            </Select>
          </div>
        ) : null}
        {change === 'capabilities' ? (
          <Fieldset>
            <FieldsetLegend>{t('models.colCan')}</FieldsetLegend>
            {capabilities.map((c) => (
              <Checkbox
                key={c}
                label={t(capabilityLabel[c])}
                checked={chosen.includes(c)}
                onChange={(e) =>
                  setChosen((all) => (e.target.checked ? [...all, c] : all.filter((x) => x !== c)))
                }
              />
            ))}
          </Fieldset>
        ) : null}
        {change === 'retire' ? (
          <div className="stack-sm">
            <span className="label-strong">
              {model.usage
                ? t('models.affectedCount', { count: model.usage.length })
                : t('models.affected')}
            </span>
            {model.usage?.length ? (
              <ul className="service-list">
                {model.usage.map((u) => (
                  <li key={`${u.tenant}/${u.service}/${u.role}`}>
                    <span>
                      <strong>{u.service}</strong> · {tenantName(u.tenant)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Paragraph data-size="sm">{t('models.usageUnknown')}</Paragraph>
            )}
          </div>
        ) : null}
      </ReasonDialog>
      <BindDialog
        api={api}
        binding={binding}
        apis={data.apis ?? []}
        families={families}
        onClose={() => setBinding(undefined)}
        onSaved={(saved) => done(t('models.bindSaved', { model: saved.deployment }))}
      />
      <PriceDialog
        api={api}
        model={pricing}
        onClose={() => setPricing(undefined)}
        onSaved={(saved) => done(t('models.priceSaved', { model: saved.deployment }))}
      />
      <ParametersDialog
        api={api}
        model={parameters}
        onClose={() => setParameters(undefined)}
        onSaved={(saved) => done(t('modelParameters.saved', { model: saved.deployment }))}
      />
    </>
  );
};
