import { Alert, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { ApiError } from '../api';
import {
  exampleDefinitions,
  exampleMessages,
  exampleTemplate,
  exampleVersions,
  serviceRows,
  type JobId,
  type ServiceRow,
} from '../data/services';
import { applySpec, asServiceDefinition } from '../data/service-definition';
import { channelKeys, channelOn, jobOf } from '../data/service-form';
import { usePortalFormat } from '../format';
import { navigate, useAsync } from '../hooks';
import { useT, type PlainKey } from '../i18n';
import type { ScreenProps } from '../screen';
import { rightLabel, useRights } from '../Shell';
import { EmptyState, ErrorState, Loading } from '../states';
import { availableSections, locate } from './service/sections';
import { Builder, newServiceInit, type BuilderInit } from './services/Builder';
import { LiveNewService } from './services/LiveNewService';
import { ServiceList } from './services/ServiceList';
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
    async (signal): Promise<ServiceRow[]> => {
      if (live)
        return (await api.services(tenant, signal)).data.map((s) => ({
          id: s.id,
          name: s.name,
          purpose: s.purpose,
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
        }));
      const definitions = await api.listDefinitions(tenant, signal);
      const unknown = definitions.filter(
        (d) => d.kind === 'Service' && !serviceRows.some((r) => r.id === d.id),
      );
      const extra = await Promise.all(
        unknown.map(async (d): Promise<ServiceRow> => {
          const full = await api.getDefinition(tenant, 'Service', d.id, signal);
          const service = asServiceDefinition(full.latest.definition);
          return {
            id: d.id,
            name: service.metadata.name ?? d.id,
            purpose: service.spec.purpose,
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
      return [...serviceRows, ...extra];
    },
    [api, tenant, live],
  );
  if (state.status === 'loading') return <Loading label={t('servicesScreen.loadingServices')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  return <ServiceList rows={state.data} tenantName={tenantName} />;
};

const useLocation = (id: string, route: ScreenProps['route']) => {
  const location = locate(
    id,
    route.segments,
    route.query,
    availableSections({ isNew: id === 'new' }),
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
  const [state, retry] = useAsync(
    async (signal) => {
      try {
        const [found, opened] = await Promise.all([
          api.getDefinition(tenant, 'Service', id, signal),
          props.live ? api.quality.openDraft(tenant, id, t('services.rebaseReason')) : undefined,
        ]);
        if (opened?.behind && !canManage) return { found, draft: undefined };
        if (opened?.rebasedFrom !== undefined)
          return { found, draft: opened, rebasedTo: opened.latestVersion ?? found.latest.version };
        return { found, draft: opened };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return undefined;
        throw error;
      }
    },
    [api, tenant, id, props.live, canManage],
  );
  if (state.status === 'loading') return <Loading label={t('servicesScreen.loadingService')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const live = state.data?.found;
  const draft = live ? state.data?.draft : undefined;
  const current = draft ?? live?.latest;
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
  };
  const pane = paneOf(route.query);
  return (
    <Builder
      key={`${id}-${live?.latest.version ?? 0}`}
      api={api}
      tenant={tenant}
      tenantName={props.tenantName}
      live={props.live}
      init={init}
      route={route}
      section={location.section}
      detail={location.detail}
      pane={pane}
      openPublish={route.query.get('publiser') === '1'}
      onPublished={retry}
    />
  );
};

export const Services = (props: ScreenProps) => {
  const t = useT();
  const canCreate = useRights().has('manage-services');
  const { route } = props;
  const [, id] = route.segments;
  const [draft, setDraft] = useState<BuilderInit>();
  const [starting, setStarting] = useState<{ error?: unknown }>();
  const location = useLocation(id ?? '', route);
  const tweak = route.query.get('visning');

  useEffect(() => {
    const target = tweak ? tweaks[tweak] : undefined;
    if (target) navigate(target);
  }, [tweak]);
  useEffect(() => {
    if (id !== 'new') {
      setDraft(undefined);
      setStarting(undefined);
    }
  }, [id]);

  const startLive = async (job: JobId, text: string, name = '') => {
    setStarting({});
    try {
      const template = await props.api.definitionTemplate(props.tenant, 'Service');
      setDraft(newServiceInit(job, text, name, true, template));
      setStarting(undefined);
    } catch (error) {
      setStarting({ error });
    }
  };

  const startNew = id === 'new' && canCreate && !draft && !starting;
  useEffect(() => {
    if (!startNew || (props.live && route.query.get('skjema') === '1')) return;
    if (props.live) void startLive('answers', '');
    else setDraft(newServiceInit('answers', '', '', false));
  }, [startNew]);

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
  if (id === 'new') {
    if (props.live && route.query.get('skjema') === '1')
      return <LiveNewService api={props.api} tenant={props.tenant} />;
    if (starting?.error) return <ErrorState error={starting.error} />;
    if (starting) return <Loading label={t('servicesScreen.loadingStart')} />;
    if (!draft) return <Loading label={t('servicesScreen.loadingStart')} />;
    return (
      <Builder
        key="new"
        api={props.api}
        tenant={props.tenant}
        tenantName={props.tenantName}
        live={props.live}
        init={draft}
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
