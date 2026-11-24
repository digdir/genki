import { Alert, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useEffect, useRef } from 'react';
import { ApiError } from '../api';
import {
  exampleDefinitions,
  exampleMessages,
  exampleTemplate,
  exampleVersions,
  serviceRows,
  type ServiceRow,
} from '../data/services';
import { applySpec, asServiceDefinition, forTenant } from '../data/service-definition';
import { channelKeys, channelOn, jobOf } from '../data/service-form';
import { usePortalFormat } from '../format';
import { navigate, useAsync } from '../hooks';
import { useT, type PlainKey } from '../i18n';
import type { ScreenProps } from '../screen';
import { rightLabel, useRights } from '../Shell';
import { EmptyState, ErrorState, Loading } from '../states';
import { listedServiceCount, rememberServiceNames } from '../listed-services';
import { modelLabel } from '../models';
import { StrategyCatalogue } from '../strategy-catalogue';
import { ServiceLoading } from './service/ServiceLoading';
import { productionEnvironment } from '../api/environments';
import { availableSections, editionOf, editionView, locate, servicePath } from './service/sections';
import { Builder, newDraftId, newServiceInit, type BuilderInit } from './services/Builder';
import { ServiceList, type ListedService } from './services/ServiceList';
import { startKeys } from './services/SetupTab';
import './services.css';

const tweaks: Record<string, string> = {
  liste: '/services',
  ny: '/services/new',
  'uttrekk-samtale': '/services/soknadsuttrekk/setup',
  'uttrekk-inn-og-ut': '/services/soknadsuttrekk/setup?pane=tjeneste',
  'uttrekk-prove': '/services/soknadsuttrekk/test',
  'uttrekk-yaml': '/services/soknadsuttrekk/versions?view=yaml',
  'uttrekk-publiser': '/services/soknadsuttrekk?publiser=1',
  samtaletjeneste: '/services/rapportassistenten/test',
};

const ListScreen = ({ api, tenant, tenantName, live }: ScreenProps) => {
  const p = usePortalFormat();
  const { t } = p;
  const [state, retry] = useAsync(
    async (signal): Promise<{ rows: ListedService[]; listed?: number }> => {
      if (live) {
        const [services, drafts, models] = await Promise.all([
          api.services(tenant, signal),
          api.quality.drafts(tenant, signal),
          api.listModels({ all: true }, signal).catch(() => []),
        ]);
        const unpublished = drafts
          .filter((d) => d.latestVersion === null)
          .map((d): ServiceRow => ({
            id: d.id,
            name: d.name ?? t('services.newServiceName'),
            purpose: d.purpose,
            job: jobOf(d.outputKind),
            start: [],
            status: 'Utkast',
            usage: '–',
            unit: t('servicesScreen.runsUnit'),
            by: p.actor(d.by, d.byName),
            when: p.dateTime(d.at),
          }));
        const rows = [
          ...unpublished,
          ...services.data.map((s): ListedService => ({
            id: s.id,
            name: s.name,
            purpose: s.purpose,
            ...(s.model ? { model: modelLabel(s.model.id, models) } : {}),
            job: jobOf(s.outputKind),
            start: s.channels
              .filter((key) => startKeys[key])
              .map((key) => t(startKeys[key] as PlainKey)),
            status:
              s.lifecycle === 'archived'
                ? 'Arkivert'
                : s.status === 'paused'
                  ? 'Satt på pause'
                  : 'I bruk',
            usage: p.number(s.runsThisWeek),
            unit: t('servicesScreen.runsUnit'),
            by: s.updatedBy ? p.actor(s.updatedBy, s.updatedByName) : '–',
            when: s.updatedAt ? p.dateTime(s.updatedAt) : '–',
          })),
        ];
        return { rows, listed: listedServiceCount(services.data, drafts) };
      }
      const definitions = await api.listDefinitions(tenant, signal);
      const unknown = definitions.filter(
        (d) => d.kind === 'Service' && !serviceRows.some((r) => r.id === d.id),
      );
      const extra = await Promise.all(
        unknown.map(async (d): Promise<ListedService> => {
          const full = await api.getDefinition(tenant, 'Service', d.id, signal);
          const service = asServiceDefinition(full.latest.definition);
          return {
            id: d.id,
            name: service.metadata.name ?? d.id,
            purpose: service.spec.purpose,
            ...(service.spec.model?.primary
              ? { model: modelLabel(service.spec.model.primary) }
              : {}),
            job: jobOf(service.spec.output.kind),
            start: channelKeys
              .filter((key) => channelOn(service.spec, key) && startKeys[key])
              .map((key) => t(startKeys[key] as PlainKey)),
            status: 'I bruk',
            usage: '–',
            unit: t('servicesScreen.runsUnit'),
            by: p.actor(full.latest.publishedBy, full.latest.publishedByName),
            when: p.dateTime(full.latest.publishedAt),
          };
        }),
      );
      const known = serviceRows.map((r): ListedService => {
        const model = exampleDefinitions[r.id]?.spec.model?.primary;
        return model ? { ...r, model: modelLabel(model) } : r;
      });
      return { rows: [...known, ...extra] };
    },
    [api, tenant, live],
  );
  useEffect(() => {
    if (state.status === 'ready') rememberServiceNames(tenant, state.data.rows);
  }, [state, tenant]);
  if (state.status !== 'ready')
    return (
      <ServiceList
        tenantName={tenantName}
        placeholder={
          state.status === 'loading' ? (
            <Loading label={t('servicesScreen.loadingServices')} shape="list" onRetry={retry} />
          ) : (
            <ErrorState error={state.error} onRetry={retry} />
          )
        }
      />
    );
  return (
    <ServiceList
      rows={state.data.rows}
      tenantName={tenantName}
      {...(state.data.listed === undefined ? {} : { listed: state.data.listed })}
    />
  );
};

// Until the service loads, its address may name a section of either kind.
const eitherKind = [
  ...new Set([...availableSections({ isNew: false }), ...availableSections({ isNew: true })]),
];

const useLocation = (id: string, route: ScreenProps['route'], isNew: boolean) => {
  const location = locate(
    id,
    route.segments,
    route.query,
    isNew ? availableSections({ isNew }) : eitherKind,
  );
  const { redirect } = location;
  useEffect(() => {
    if (redirect) window.location.replace(`#${redirect}`);
  }, [redirect]);
  return location;
};

const paneOf = (query: URLSearchParams) => {
  const p = query.get('pane');
  return p === 'assistent' || p === 'tjeneste' ? p : undefined;
};

const BuilderScreen = (
  props: ScreenProps & { id: string; location: ReturnType<typeof locate> },
) => {
  const { api, tenant, id, route, location } = props;
  const p = usePortalFormat();
  const { t } = p;
  const canManage = useRights().has('manage-services');
  const inUse =
    editionOf(route.query) === 'inUse' && editionView(location.section, 'inUse') === 'inUse';
  const [state, retry] = useAsync(
    async (signal) => {
      try {
        if (inUse && props.live) {
          const [found, pointers] = await Promise.all([
            api.getDefinition(tenant, 'Service', id, signal),
            api.environments.list(tenant, id, signal).catch(() => undefined),
          ]);
          const prod = pointers?.environments.find((e) => e.name === productionEnvironment);
          const version = prod?.version ?? found.latest.version;
          const shown =
            version === found.latest.version
              ? found.latest
              : await api.getVersion(tenant, 'Service', id, version, signal);
          return { found, draft: undefined, inUse: shown };
        }
        const [found, opened] = await Promise.all([
          api.getDefinition(tenant, 'Service', id, signal),
          props.live ? api.quality.openDraft(tenant, id, t('services.rebaseReason')) : undefined,
        ]);
        if (opened?.behind && !canManage) return { found, draft: undefined };
        if (opened?.rebasedFrom !== undefined)
          return { found, draft: opened, rebasedTo: opened.latestVersion ?? found.latest.version };
        return { found, draft: opened };
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
        const unpublished = props.live ? await api.quality.draft(tenant, id, signal) : undefined;
        return unpublished ? { unpublished } : undefined;
      }
    },
    [api, tenant, id, props.live, canManage, inUse],
  );
  const loadedInUse = state.status === 'ready' && state.data !== undefined && 'inUse' in state.data;
  const otherEdition =
    state.status === 'ready' &&
    state.data !== undefined &&
    'found' in state.data &&
    loadedInUse !== (inUse && props.live === true);
  const unpublishedDraft =
    state.status === 'ready' && state.data !== undefined && 'unpublished' in state.data;
  const settled = locate(
    id,
    route.segments,
    route.query,
    availableSections({ isNew: unpublishedDraft }),
  );
  const settledRedirect = state.status === 'ready' ? settled.redirect : undefined;
  useEffect(() => {
    if (settledRedirect) window.location.replace(`#${settledRedirect}`);
  }, [settledRedirect, route]);
  if (state.status === 'loading' || otherEdition)
    return (
      <ServiceLoading
        tenant={tenant}
        id={id}
        section={location.section}
        label={t('servicesScreen.loadingService')}
        onRetry={retry}
      />
    );
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  if (state.data && 'unpublished' in state.data) {
    const { unpublished } = state.data;
    const sections = availableSections({ isNew: true });
    return (
      <Builder
        key={id}
        api={api}
        tenant={tenant}
        tenantName={props.tenantName}
        live={props.live}
        init={{
          id,
          isNew: true,
          definition: asServiceDefinition(unpublished.definition),
          files: unpublished.files,
          draftRevision: unpublished.revision,
          messages: [],
          extraCards: {},
          versions: [],
          status: 'Utkast',
        }}
        route={route}
        section={sections.includes(settled.section) ? settled.section : 'setup'}
        detail={settled.detail}
        pane={paneOf(route.query)}
        openPublish={false}
      />
    );
  }
  const live = state.data?.found;
  const draft = live ? state.data?.draft : undefined;
  const shownInUse = state.data && 'inUse' in state.data ? state.data.inUse : undefined;
  const current = shownInUse ?? draft ?? live?.latest;
  const row = props.live ? undefined : serviceRows.find((r) => r.id === id);
  const example = props.live ? undefined : exampleDefinitions[id];
  if (!live && !row && !example)
    return (
      <EmptyState title={t('servicesScreen.notFoundTitle')}>
        <Paragraph>
          {t.rich('servicesScreen.notFoundText', {
            link: (c) => <a href="#/services">{c}</a>,
          })}
        </Paragraph>
      </EmptyState>
    );
  const definition =
    example ??
    (current
      ? asServiceDefinition(current.definition)
      : applySpec(exampleTemplate(row?.job ?? 'answers', row?.name ?? id), {
          purpose: row?.purpose ?? '',
        }));
  const init: BuilderInit = {
    id,
    isNew: false,
    definition,
    messages: props.live ? [] : (exampleMessages[id] ?? []),
    extraCards: {},
    versions: live
      ? [...live.versions].reverse().map((v, i) => ({
          n: v.version,
          when: p.dateTime(v.publishedAt),
          who: p.actor(v.publishedBy, v.publishedByName),
          state: i === 0 ? ('I bruk' as const) : ('Tidligere' as const),
          score: '',
          diff: [],
          reason: v.reason,
          live: true,
        }))
      : props.live
        ? []
        : (exampleVersions[id] ?? []),
    status: row?.status ?? 'I bruk',
    ...(current?.files ? { files: current.files } : {}),
    ...(draft ? { draftRevision: draft.revision } : {}),
    ...(state.data && 'rebasedTo' in state.data ? { rebasedTo: state.data.rebasedTo } : {}),
    ...(props.live && live ? { opened: draft ?? null } : {}),
  };
  const pane = paneOf(route.query);
  return (
    <Builder
      key={`${id}-${live?.latest.version ?? 0}-${inUse ? 'in-use' : 'test'}`}
      api={api}
      tenant={tenant}
      tenantName={props.tenantName}
      live={props.live}
      init={init}
      route={route}
      section={settled.section}
      detail={settled.detail}
      pane={pane}
      openPublish={route.query.get('publiser') === '1'}
      edition={inUse ? 'inUse' : 'test'}
      {...(shownInUse ? { inUseEdition: shownInUse } : {})}
      onPublished={retry}
    />
  );
};

export const Services = (props: ScreenProps) => {
  const t = useT();
  const { route } = props;
  const [, id] = route.segments;
  const tweak = route.query.get('visning');
  useEffect(() => {
    const target = tweak ? tweaks[tweak] : undefined;
    if (target) navigate(target);
  }, [tweak]);
  if (!id) return <ListScreen {...props} />;
  const fallback =
    id === 'new' ? undefined : (
      <ServiceLoading
        tenant={props.tenant}
        id={id}
        section={
          locate(id, route.segments, route.query, availableSections({ isNew: false })).section
        }
        label={t('servicesScreen.loadingService')}
      />
    );
  return (
    <StrategyCatalogue api={props.api} tenant={props.tenant} fallback={fallback}>
      <ServiceScreens {...props} />
    </StrategyCatalogue>
  );
};

/** A new service in the example portal, which has no drafts to save. */
const mockStart: BuilderInit = {
  ...newServiceInit('answers', '', '', false),
  messages: [],
  extraCards: {},
};

/** Saves an empty draft for a new service and opens its Oppsett. */
const StartDraft = ({ api, tenant }: Pick<ScreenProps, 'api' | 'tenant'>) => {
  const t = useT();
  const reason = t('services.draftSavedReason');
  // One draft per visit and tenant: React may run the effect twice in development.
  const started = useRef<{ tenant: string; id: Promise<string> }>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [state, retry] = useAsync(() => {
    if (started.current?.tenant !== tenant)
      started.current = {
        tenant,
        id: (async () => {
          const template = await api.definitionTemplate(tenant, 'Service');
          // Switching organisation leaves this screen; save nothing for the one switched to.
          if (!mounted.current) throw new Error('left Ny tjeneste');
          const id = newDraftId();
          const { definition } = newServiceInit('answers', '', '', true, template);
          const stamped = forTenant(definition, { tenant, id: 'ny-tjeneste', version: 1 });
          const draft = { ...stamped, metadata: { ...stamped.metadata, name: '' } };
          await api.quality.saveDraft(
            tenant,
            id,
            { definition: draft as unknown as Record<string, unknown>, files: {}, revision: 0 },
            reason,
          );
          return id;
        })(),
      };
    const current = started.current;
    return current.id.catch((error: unknown) => {
      if (started.current === current) started.current = undefined;
      throw error;
    });
  }, [api, tenant]);
  useEffect(() => {
    if (state.status === 'ready') window.location.replace(`#${servicePath(state.data, 'setup')}`);
  }, [state]);
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  return <Loading label={t('servicesScreen.loadingStart')} shape="form" />;
};

const ServiceScreens = (props: ScreenProps) => {
  const t = useT();
  const canCreate = useRights().has('manage-services');
  const { route } = props;
  const [, id] = route.segments;
  const building = id === 'new';
  const location = useLocation(id ?? '', route, building);

  if (!id) return <ListScreen {...props} />;
  if (id === 'new' && !canCreate)
    return (
      <div className="stack">
        <Heading level={1} data-size="lg">
          {t('services.newTitle')}
        </Heading>
        <Alert data-color="info">
          <Heading level={2} data-size="xs">
            {t('servicesScreen.cannotCreateTitle')}
          </Heading>
          <Paragraph>
            {t('servicesScreen.cannotCreateText', { right: rightLabel(t, 'manage-services') })}
          </Paragraph>
        </Alert>
        <a href="#/services">{t('servicesScreen.backToServices')}</a>
      </div>
    );
  if (building) {
    if (props.live) return <StartDraft api={props.api} tenant={props.tenant} />;
    return (
      <Builder
        key="new"
        api={props.api}
        tenant={props.tenant}
        tenantName={props.tenantName}
        live={props.live}
        init={mockStart}
        route={route}
        section={location.section}
        detail={location.detail}
        pane={paneOf(route.query)}
        openPublish={false}
      />
    );
  }
  return <BuilderScreen key={id} {...props} id={id} location={location} />;
};
