import { useFormat } from '@genai/i18n/react';
import { useEffect } from 'react';
import type { ApiClient } from '../../api';
import { isActiveBatch } from '../../api/batch-runs';
import { LinkTabs } from '../../components/LinkTabs';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import {
  sectionLabels,
  serviceTabs,
  servicePath,
  subSections,
  tabLabels,
  tabOf,
  type ServiceSection,
} from './sections';

export const ServiceNav = ({
  id,
  name,
  sections,
  current,
}: {
  id: string;
  name?: string | undefined;
  sections: ServiceSection[];
  current: ServiceSection;
}) => {
  const t = useT();
  const tab = tabOf(current);
  useEffect(() => {
    document
      .querySelector('.service-nav [aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
  return (
    <LinkTabs
      label={t('service.navLabel', { name: name || id })}
      className="service-nav"
      current={tab}
      tabs={serviceTabs(sections).map(({ tab: each, target }) => ({
        key: each,
        label: t(tabLabels[each]),
        href: `#${servicePath(id, target)}`,
      }))}
    />
  );
};

type Counts = Partial<Record<ServiceSection, number>>;

const settled = <T,>(r: PromiseSettledResult<T>) =>
  r.status === 'fulfilled' ? r.value : undefined;

const useDeveloperCounts = (
  api: ApiClient | undefined,
  tenant: string | undefined,
  id: string,
  now: () => Date,
) => {
  const [state] = useAsync(
    async (signal): Promise<Counts> => {
      if (!api || !tenant) return {};
      const today = new Date(now());
      today.setHours(0, 0, 0, 0);
      const [definition, runs, keys, environments, batches] = await Promise.allSettled([
        api.getDefinition(tenant, 'Service', id, signal),
        api.tasks(tenant, { service: id, from: today.toISOString(), limit: 1 }, signal),
        api.listServiceKeys(tenant, id, signal),
        api.environments.list(tenant, id, signal),
        api.batchRuns.list(tenant, id, signal),
      ]);
      const counts: Counts = {};
      const versions = settled(definition)?.versions.length;
      if (versions !== undefined) counts.versions = versions;
      const total = settled(runs)?.total;
      if (total !== undefined) counts.log = total;
      const active = settled(keys)?.filter((k) => !k.revokedAt).length;
      if (active !== undefined) counts.channels = active;
      const named = settled(environments)?.environments.length;
      if (named !== undefined) counts.environments = named;
      const running = settled(batches)?.filter(isActiveBatch).length;
      if (running) counts.batch = running;
      return counts;
    },
    [api, tenant, id],
  );
  return state.status === 'ready' ? state.data : {};
};

export const ServiceSubNav = ({
  id,
  sections,
  current,
  api,
  tenant,
  now = () => new Date(),
}: {
  id: string;
  sections: ServiceSection[];
  current: ServiceSection;
  api?: ApiClient;
  tenant?: string;
  now?: () => Date;
}) => {
  const t = useT();
  const f = useFormat();
  const tab = tabOf(current);
  const links = subSections(tab, sections);
  const counts = useDeveloperCounts(tab === 'developer' ? api : undefined, tenant, id, now);
  if (links.length < 2) return null;
  const countText = (s: ServiceSection) => {
    const n = counts[s];
    if (n === undefined) return undefined;
    if (s === 'log') return t('service.countToday', { count: n });
    if (s === 'channels') return t('service.countActive', { count: n });
    if (s === 'batch') return t('service.countRunning', { count: n });
    return f.number(n);
  };
  return (
    <LinkTabs
      label={t(tabLabels[tab])}
      className="service-subnav"
      orientation="vertical"
      current={current}
      tabs={links.map((s) => ({
        key: s,
        label: t(sectionLabels[s]),
        href: `#${servicePath(id, s)}`,
        count: countText(s),
      }))}
    />
  );
};
