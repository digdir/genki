import {
  Alert,
  Button,
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
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import { useT } from '../../i18n';
import { operationName } from '../../model-operations';
import { EmptyState } from '../../states';
import type { OperatorModel, RefreshResult } from '../../types';
import { ReasonDialog, TableRegion } from '../../ui';
import { priceText } from './prices';
import {
  allModels,
  boundOf,
  filterModels,
  isUnconfirmed,
  modelsHref,
  type AreaProps,
  type ModelFilter,
} from './area-data';
import { ModelForm, residencyLabel } from './Endpoints';

export const KindTags = ({ model }: { model: OperatorModel }) => {
  const t = useT();
  const bound = Object.entries(boundOf(model));
  if (bound.length === 0) return <span className="meta">{t('models.noKinds')}</span>;
  return (
    <span className="tag-row">
      {bound.map(([kind, api]) => (
        <Tag key={kind} data-size="sm" data-color="neutral">
          {operationName(kind, t)} · {api}
        </Tag>
      ))}
    </span>
  );
};

export const ModelStatus = ({ model }: { model: OperatorModel }) => {
  const t = useT();
  return (
    <span className="tag-row">
      <Tag data-size="sm" data-color={model.enabled ? 'success' : 'neutral'}>
        {model.enabled ? t('models.enabled') : t('models.disabled')}
      </Tag>
      {isUnconfirmed(model) ? (
        <Tag data-size="sm" data-color="warning">
          {t('models.unconfirmed')}
        </Tag>
      ) : null}
    </span>
  );
};

export const ModelList = ({ api, data, done }: AreaProps) => {
  const t = useT();
  const f = useFormat();
  const [filter, setFilter] = useState<ModelFilter>(allModels);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState<RefreshResult | undefined>();
  const [adding, setAdding] = useState(false);
  const set = (change: Partial<ModelFilter>) => setFilter((all) => ({ ...all, ...change }));
  const connections = [
    ...new Set([
      ...(data.connections ?? []).map((c) => c.id),
      ...data.models.map((m) => m.endpoint),
    ]),
  ].sort();
  const kinds = [...new Set(data.models.flatMap((m) => Object.keys(boundOf(m))))].sort();
  const shown = filterModels(data.models, filter);

  return (
    <section className="stack" aria-labelledby="models-h">
      <div className="card-head">
        <Heading level={2} data-size="xs" id="models-h">
          {t('models.tabModels')}
        </Heading>
        <span className="row-actions">
          <Button variant="secondary" data-size="sm" onClick={() => setRefreshing(true)}>
            {t('models.refresh')}
          </Button>
          <Button
            variant="secondary"
            data-size="sm"
            disabled={!data.connections?.length}
            onClick={() => setAdding(true)}
          >
            {t('endpoints.addModel')}
          </Button>
        </span>
      </div>
      <Paragraph data-size="sm">
        {t.rich('models.discoveredNote', { strong: (c) => <strong>{c}</strong> })}
      </Paragraph>
      {refreshed ? (
        <Alert data-color={refreshed.failed.length > 0 ? 'warning' : 'success'} role="status">
          <Paragraph>{t('models.discovered', { count: refreshed.discovered })}</Paragraph>
          {refreshed.failed.length > 0 ? (
            <>
              <Paragraph>{t('models.providersFailed')}</Paragraph>
              <ul>
                {refreshed.failed.map((x) => (
                  <li key={x.endpoint}>
                    {x.endpoint}: {x.error}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Alert>
      ) : null}
      {data.models.length === 0 ? (
        <EmptyState title={t('models.noneTitle')}>
          <Paragraph>{t('models.noneText')}</Paragraph>
        </EmptyState>
      ) : (
        <>
          <div className="filters">
            <Textfield
              label={t('models.search')}
              type="search"
              value={filter.text}
              onChange={(e) => set({ text: e.target.value })}
            />
            <div className="field">
              <Label htmlFor="models-connection">{t('models.filterConnection')}</Label>
              <Select
                id="models-connection"
                value={filter.connection}
                onChange={(e) => set({ connection: e.target.value })}
              >
                <SelectOption value="">{t('models.filterAll')}</SelectOption>
                {connections.map((c) => (
                  <SelectOption key={c} value={c}>
                    {c}
                  </SelectOption>
                ))}
              </Select>
            </div>
            <div className="field">
              <Label htmlFor="models-kind">{t('models.filterKind')}</Label>
              <Select
                id="models-kind"
                value={filter.kind}
                onChange={(e) => set({ kind: e.target.value })}
              >
                <SelectOption value="">{t('models.filterAll')}</SelectOption>
                {kinds.map((k) => (
                  <SelectOption key={k} value={k}>
                    {operationName(k, t)}
                  </SelectOption>
                ))}
              </Select>
            </div>
            <div className="field">
              <Label htmlFor="models-confirmed">{t('models.filterConfirmed')}</Label>
              <Select
                id="models-confirmed"
                value={filter.confirmed}
                onChange={(e) => set({ confirmed: e.target.value as ModelFilter['confirmed'] })}
              >
                <SelectOption value="all">{t('models.filterAll')}</SelectOption>
                <SelectOption value="confirmed">{t('models.filterConfirmedOnly')}</SelectOption>
                <SelectOption value="unconfirmed">{t('models.unconfirmed')}</SelectOption>
              </Select>
            </div>
          </div>
          <Paragraph data-size="sm" aria-live="polite">
            {t('models.shown', { count: shown.length, total: data.models.length })}
          </Paragraph>
          <TableRegion label={t('models.tableLabel')}>
            <Table className="models-table">
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">{t('models.colModel')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('models.colConnection')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('models.colResidency')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('models.colPrice')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('models.colKinds')}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {shown.map((m) => (
                  <TableRow key={m.id}>
                    <TableHeaderCell scope="row">
                      <span className="two-line">
                        <Link href={modelsHref({ model: m.id })}>
                          <strong>{m.deployment}</strong>
                        </Link>
                        <span className="meta model-id">{m.id}</span>
                        <ModelStatus model={m} />
                      </span>
                    </TableHeaderCell>
                    <TableCell>
                      <span className="two-line">
                        <Link href={modelsHref({ connection: m.endpoint })}>{m.endpoint}</Link>
                        <span className="meta">
                          {m.origin === 'discovered'
                            ? t('models.discoveredAuto')
                            : t('models.fromCatalog')}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>{t(residencyLabel[m.residency])}</TableCell>
                    <TableCell className="nowrap">{priceText(m.price, f, t)}</TableCell>
                    <TableCell>
                      <KindTags model={m} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableRegion>
        </>
      )}
      <ReasonDialog
        open={refreshing}
        title={t('models.refresh')}
        text={t('models.refreshText')}
        confirmLabel={t('models.refresh')}
        onClose={() => setRefreshing(false)}
        onConfirm={async (reason) => {
          setRefreshed(await api.refreshModels(reason));
          done(t('models.refreshed'));
        }}
      />
      {adding && data.connections ? (
        <ModelForm
          api={api}
          endpoints={data.connections}
          apis={data.apis}
          onClose={() => setAdding(false)}
          onSaved={(saved) => {
            setAdding(false);
            done(t('models.saved', { model: saved.deployment }));
          }}
        />
      ) : null}
    </section>
  );
};
