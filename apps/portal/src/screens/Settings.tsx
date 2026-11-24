import {
  Alert,
  Field,
  Heading,
  Label,
  Select,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import { useT } from '../i18n';
import { BackLink } from '../components/BackLink';
import { useInServicePage } from './service/context';
import {
  exampleDatasetNames,
  exampleServiceNames,
  highRiskServices,
  norwayOnlyServices,
  slug,
  type SettingRow,
} from '../data/settings';
import { navigate, useAsync } from '../hooks';
import type { ScreenProps, SettingsContext } from '../screen';
import { useRights } from '../Shell';
import { ErrorState, Loading } from '../states';
import { mergeRows, type Ctx } from './settings/model';
import { settingLabel } from './settings/text';
import { SettingPanel, type LogEntry } from './settings/SettingPanel';
import { SettingsGrid } from './settings/SettingsGrid';
import { AllSettingsTable } from './settings/AllSettingsTable';
import { LiveTransfer } from './settings/LiveTransfer';
import { Transfer } from './settings/Transfer';
import { WrittenStandard, writtenStandardRow } from './settings/WrittenStandard';
import { CommonSettings } from './settings/CommonSettings';
import './settings.css';

interface Loaded {
  rows: SettingRow[];
  categories: string[];
  target: string;
  draftVersion: number;
  highRisk: boolean;
  norwayOnly: boolean;
}

const noDirtyGuard = () => undefined;

const nameFromSlug = (list: string[], id: string) => list.find((n) => slug(n) === id);

const View = ({
  api,
  tenant,
  tenantName,
  route,
  context,
  section,
  loaded,
  live,
}: ScreenProps & {
  context: SettingsContext;
  section: 'common' | 'all';
  loaded: Loaded;
}) => {
  const t = useT();
  const embedded = useInServicePage();
  const serviceNames = live ? [] : exampleServiceNames;
  const datasetNames = live ? [] : exampleDatasetNames;
  const [rows, setRows] = useState(loaded.rows);
  const [panel, setPanelState] = useState(route.query.get('setting') ?? undefined);
  const setPanel = (next?: string) => {
    setPanelState(next);
    const [path = '', search = ''] = window.location.hash.replace(/^#/, '').split('?');
    const query = new URLSearchParams(search);
    if (next) query.set('setting', next);
    else query.delete('setting');
    window.history.replaceState(
      window.history.state,
      '',
      `#${path}${query.size ? `?${query.toString()}` : ''}`,
    );
  };
  const [log, setLog] = useState<LogEntry[]>([]);
  const [flash, setFlash] = useState('');
  const [draftMsg, setDraftMsg] = useState('');
  const tab = route.query.get('tab') === 'transfer' ? 'transfer' : 'grid';
  const ctx: Ctx = {
    kind: context.kind,
    target: loaded.target,
    tenantName,
    highRisk: loaded.highRisk,
    norwayOnly: loaded.norwayOnly,
  };
  const id = context.kind === 'tenant' ? undefined : context.id;
  const base =
    context.kind === 'service'
      ? `/services/${encodeURIComponent(context.id)}/settings`
      : context.kind === 'dataset'
        ? `/datasets/${encodeURIComponent(context.id)}/settings`
        : '/settings';
  const back =
    context.kind === 'service'
      ? { label: loaded.target, href: `#/services/${encodeURIComponent(context.id)}` }
      : context.kind === 'dataset'
        ? { label: loaded.target, href: `#/datasets/${encodeURIComponent(context.id)}` }
        : undefined;
  const title = t('settings.titleTenant', {
    name: context.kind === 'tenant' ? tenantName : loaded.target,
  });
  const intro =
    context.kind === 'tenant'
      ? t('settings.introTenant', { name: tenantName })
      : t('settings.introLayered');
  const targets =
    context.kind === 'service'
      ? { label: t('settings.targetService'), list: serviceNames, area: 'services' }
      : context.kind === 'dataset'
        ? { label: t('settings.targetDataset'), list: datasetNames, area: 'datasets' }
        : undefined;
  const selected = rows.find((r) => r.id === panel);
  const standard = context.kind === 'service' ? writtenStandardRow(rows) : undefined;
  const panelView = selected ? (
    <SettingPanel
      key={selected.id}
      api={api}
      live={live}
      tenant={tenant}
      serviceId={context.kind === 'service' ? context.id : undefined}
      datasetId={context.kind === 'dataset' ? context.id : undefined}
      setting={selected}
      ctx={ctx}
      names={{ services: serviceNames, datasets: datasetNames }}
      draftVersion={loaded.draftVersion}
      log={log.filter((l) => l.id === selected.id)}
      onClose={() => setPanel()}
      onSaved={(row, entry, kind, what) => {
        setRows((all) => all.map((r) => (r.id === row.id ? row : r)));
        setLog((all) => [entry, ...all]);
        if (kind === 'draft') {
          setFlash('');
          setDraftMsg(t('settings.draftSaved', { version: loaded.draftVersion }));
        } else setFlash(t('settings.savedFlash', { label: settingLabel(t, row), what }));
      }}
    />
  ) : null;
  const transfer = live ? (
    <LiveTransfer api={api} tenant={tenant} tenantName={tenantName} onFlash={setFlash} />
  ) : (
    <Transfer rows={rows} tenantName={tenantName} onFlash={setFlash} />
  );
  const flashView = (
    <div aria-live="polite" className="settings-flash">
      {flash ? (
        <Alert data-color="success" data-size="sm">
          {flash}
        </Alert>
      ) : null}
    </div>
  );

  if (context.kind === 'tenant' && section === 'all') {
    return (
      <div className="settings-page stack">
        {flashView}
        <p>{t('settings.allIntro')}</p>
        <AllSettingsTable
          rows={rows}
          categories={loaded.categories}
          ctx={ctx}
          selected={panel}
          onOpen={setPanel}
        />
        <section aria-labelledby="settings-transfer-h" className="stack-sm">
          <Heading level={2} data-size="xs" id="settings-transfer-h">
            {t('settings.transferHeading')}
          </Heading>
          {transfer}
        </section>
        {panelView}
      </div>
    );
  }

  if (context.kind === 'tenant') {
    return (
      <div className="settings-page stack">
        <div className="settings-header">
          <div className="settings-title">
            <Heading level={1} data-size="md">
              {t('settings.heading')}
            </Heading>
            <p className="lead">{t('settings.introOrganisation', { name: tenantName })}</p>
          </div>
        </div>
        {flashView}
        <CommonSettings
          api={api}
          tenant={tenant}
          live={live}
          rows={rows}
          onSaved={setRows}
          onDirty={noDirtyGuard}
        />
        {panelView}
      </div>
    );
  }

  return (
    <div className="settings-page stack">
      {draftMsg && id ? (
        <Alert role="status" data-color="success" data-size="sm">
          {draftMsg}{' '}
          <a href={`#/services/${encodeURIComponent(id)}/quality?tab=publish`}>
            {t('settings.goToPublish')}
          </a>
        </Alert>
      ) : null}
      {embedded || !back ? null : <BackLink label={back.label} href={back.href} />}
      <div className="settings-header">
        <div className="settings-title">
          {embedded ? null : (
            <Heading level={1} data-size="md">
              {title}
            </Heading>
          )}
          <p className="lead">{intro}</p>
        </div>
        {targets && !embedded ? (
          <Field className="target-select">
            <Label htmlFor="settings-target">{targets.label}</Label>
            <Select
              id="settings-target"
              value={loaded.target}
              onChange={(e) => navigate(`/${targets.area}/${slug(e.target.value)}/settings`)}
            >
              {[...new Set([loaded.target, ...targets.list])].map((n) => (
                <Select.Option key={n} value={n}>
                  {n}
                </Select.Option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
      <Tabs
        value={tab}
        onChange={(v) => {
          setFlash('');
          navigate(v === 'transfer' ? `${base}?tab=transfer` : base);
        }}
      >
        <TabsList aria-label={t('settings.tabsLabel')}>
          <TabsTab value="grid">{t('settings.tabGrid')}</TabsTab>
          <TabsTab value="transfer">{t('settings.tabTransfer')}</TabsTab>
        </TabsList>
        {flashView}
        <TabsPanel value="grid">
          {standard ? (
            <WrittenStandard
              api={api}
              tenant={tenant}
              tenantName={tenantName}
              live={live}
              row={standard}
              {...(context.kind === 'service'
                ? { service: { id: context.id, name: loaded.target } }
                : {})}
              onSaved={(row, message) => {
                setRows((all) => all.map((r) => (r.id === row.id ? row : r)));
                setFlash(message);
              }}
            />
          ) : null}
          <SettingsGrid
            rows={rows}
            categories={loaded.categories}
            ctx={ctx}
            selected={panel}
            onOpen={setPanel}
          />
        </TabsPanel>
        <TabsPanel value="transfer">{transfer}</TabsPanel>
      </Tabs>
      {panelView}
    </div>
  );
};

const TenantSettingsLoading = ({
  tenantName,
  onRetry,
}: {
  tenantName: string;
  onRetry: () => void;
}) => {
  const t = useT();
  return (
    <div className="settings-page stack">
      <div className="settings-header">
        <div className="settings-title">
          <Heading level={1} data-size="md">
            {t('settings.heading')}
          </Heading>
          <p className="lead">{t('settings.introOrganisation', { name: tenantName })}</p>
        </div>
      </div>
      <Loading label={t('settings.loading')} shape="form" onRetry={onRetry} />
    </div>
  );
};

/** `section: 'all'` is the table of every setting key, shown under Utviklerverktøy. */
export const Settings = ({
  section = 'common',
  ...props
}: ScreenProps & { context: SettingsContext; section?: 'common' | 'all' }) => {
  const { api, tenant, context, live } = props;
  const t = useT();
  const embedded = useInServicePage();
  const id = context.kind === 'tenant' ? '' : context.id;
  const canExport = useRights().has('manage-services');
  const [state, retry] = useAsync(
    async (signal): Promise<Loaded> => {
      if (context.kind === 'tenant' && live && canExport)
        api.exportTenant(tenant, signal).catch(() => undefined);
      const catalogLoad = api.settingsCatalog(signal);
      if (context.kind === 'service') {
        const [catalog, effective, definition] = await Promise.all([
          catalogLoad,
          api.effectiveSettings(tenant, id, signal),
          api.getDefinition(tenant, 'Service', id, signal).catch(() => undefined),
        ]);
        const spec = (definition?.latest.definition.spec ?? {}) as {
          riskClass?: string;
          model?: { residency?: string };
        };
        const name =
          (definition?.latest.definition.metadata as { name?: string } | undefined)?.name ??
          (live ? undefined : nameFromSlug(exampleServiceNames, id)) ??
          id;
        return {
          ...mergeRows(catalog, effective, name, live),
          target: name,
          draftVersion: (definition?.latest.version ?? (live ? 0 : 7)) + 1,
          highRisk: (!live && highRiskServices.includes(name)) || spec.riskClass === 'high',
          norwayOnly:
            (!live && norwayOnlyServices.includes(name)) || spec.model?.residency === 'norway',
        };
      }
      if (context.kind === 'dataset') {
        const [catalog, dataset] = await Promise.all([
          catalogLoad,
          api.getDataset(id, signal).catch(() => undefined),
        ]);
        const name =
          (live ? undefined : nameFromSlug(exampleDatasetNames, id)) ?? dataset?.name ?? id;
        return {
          ...mergeRows(catalog, undefined, name, live),
          target: name,
          draftVersion: 1,
          highRisk: false,
          norwayOnly: false,
        };
      }
      const [catalog, effective] = await Promise.all([
        catalogLoad,
        live ? api.tenantEffectiveSettings(tenant, signal) : undefined,
      ]);
      return {
        ...mergeRows(catalog, effective, '', live),
        target: '',
        draftVersion: 1,
        highRisk: false,
        norwayOnly: false,
      };
    },
    [api, tenant, context.kind, id, live],
  );
  if (state.status === 'loading')
    return context.kind === 'tenant' && section === 'common' ? (
      <TenantSettingsLoading tenantName={props.tenantName} onRetry={retry} />
    ) : (
      <Loading label={t('settings.loading')} shape="form" onRetry={retry} />
    );
  if (state.status === 'error')
    return (
      <div className="stack">
        {embedded || section === 'all' ? null : (
          <Heading level={1} data-size="md">
            {t('settings.heading')}
          </Heading>
        )}
        {context.kind === 'tenant' ? (
          <>
            <Heading level={2} data-size="xs">
              {t('settings.loadFailedTitle')}
            </Heading>
            <p>
              {section === 'all'
                ? t('settings.loadFailedNoDefaults')
                : t('settings.loadFailedNoForm')}
            </p>
          </>
        ) : null}
        <ErrorState error={state.error} onRetry={retry} />
      </div>
    );
  return <View key={`${context.kind}-${id}`} {...props} section={section} loaded={state.data} />;
};
