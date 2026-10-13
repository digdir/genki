import { randomUUID } from 'node:crypto';
import type { Principal } from '@genai/contracts';
import { schedule, systemPrincipal, type Clock } from '@genai/jobs';
import {
  KnowledgeError,
  type DocumentSummary,
  type FilterValue,
  type KnowledgePort,
} from '@genai/port-knowledge';
import type { PortContext } from '@genai/kernel';
import { actorOf } from './admin.js';
import type { LeaseOptions } from './background-lease.js';
import {
  BatchProblem,
  batchRuns,
  type BatchDocument,
  type BatchEstimate,
  type BatchRun,
  type BatchTotals,
} from './batch-runs.js';
import {
  appendVersion,
  platformScope,
  serialized,
  VersionConflict,
  type ConfigEntry,
} from './config-store.js';
import type { Execution } from './ingestion.js';
import type { ModuleDeps } from './platform-modules.js';

export const projectKind = 'project';
export const subscriptionKind = 'project-subscription';
export const subscriptionStateKind = 'project-subscription-state';
export const projectRunKind = 'project-run';

export const maxSelections = 20;
export const maxSubscriptionDocuments = 5000;
export const subscriptionActor = 'platform:subscription';
const pageSize = 250;
const claimStaleMs = 10 * 60_000;
const freshKept = 200;
const slug = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface ProjectSelection {
  id: string;
  name: string;
  dataset: string;
  filters: Record<string, FilterValue>;
  documents?: string[];
}

export interface Project {
  id: string;
  name: string;
  purpose: string;
  selections: ProjectSelection[];
  services: string[];
  changedBy?: string;
}

export type SubscriptionMode = 'notify' | 'run';

export interface SubscriptionCap {
  maxCostNok?: number;
  maxTokens?: number;
}

export interface SubscriptionPause {
  kind: 'cost-cap' | 'manual' | 'problem';
  reason: string;
  at: string;
  month?: string;
}

export interface Subscription {
  project: string;
  selection: string;
  mode: SubscriptionMode;
  service?: string;
  prompt?: string;
  cap: SubscriptionCap;
  basis: { dataset: string; filters: Record<string, FilterValue> };
  paused?: SubscriptionPause;
  changedBy?: string;
}

export interface FreshDocument {
  document: BatchDocument;
  arrivedAt: string;
  run?: string;
}

export interface SubscriptionState {
  seen: string[];
  fresh: FreshDocument[];
  claim?: { id: string; documents: string[]; at: string };
  checkedAt?: string;
  error?: string;
}

export interface ProjectRun {
  project: string;
  run: string;
  service: string;
  selection?: string;
  trigger: 'manual' | 'subscription';
  claim?: string;
  month: string;
  startedAt: string;
}

export interface CheckResult {
  status: 'off' | 'paused' | 'busy' | 'checked' | 'started';
  arrived: number;
  waiting: number;
  run?: string;
  paused?: SubscriptionPause;
  error?: string;
  done?: Promise<void>;
}

export interface ProjectsOptions {
  leases?: LeaseOptions;
  clock?: Clock;
  pollCron?: string;
  onBackground?: (work: Promise<void>) => void;
}

export const subscriptionKey = (project: string, selection: string) => `${project}/${selection}`;

export class ProjectInvalid extends BatchProblem {
  constructor(readonly errors: { path: string; message: string }[]) {
    super(400, 'Ugyldig prosjekt');
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const monthFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Oslo',
  year: 'numeric',
  month: '2-digit',
});

export const monthOf = (at: Date) => monthFormat.format(at);

const kroner = (micro: number) =>
  `${(micro / 1_000_000).toLocaleString('nb-NO', { maximumFractionDigits: 2 })} kr`;

const toDocument = (doc: DocumentSummary): BatchDocument => ({
  id: doc.id,
  title: doc.title ?? doc.id,
  ...(doc.url ? { url: doc.url } : {}),
});

const sameBasis = (a: Subscription['basis'], b: Subscription['basis']) =>
  a.dataset === b.dataset && JSON.stringify(a.filters) === JSON.stringify(b.filters);

const emptyState = (): SubscriptionState => ({ seen: [], fresh: [] });

export const projects = (deps: ModuleDeps, options: ProjectsOptions = {}) => {
  const batches = batchRuns(deps, options.leases);
  const now = () => batches.leases.now();
  const serials = new Map<string, ReturnType<typeof serialized>>();
  const serialFor = (key: string) => {
    const found = serials.get(key);
    if (found) return found;
    const created = serialized();
    serials.set(key, created);
    return created;
  };
  const background = (work: Promise<void>) => {
    work.catch(() => undefined);
    options.onBackground?.(work);
  };

  const workerFor = (tenant: string, key: string): Principal => ({
    ...systemPrincipal()(tenant),
    subject: `subscription:${tenant}/${key}`,
  });

  const contextFor = (principal: Principal, tenant: string): PortContext => ({
    tenant,
    principal,
    task: `project:${randomUUID()}`,
    signal: new AbortController().signal,
    meter: async () => undefined,
  });

  const visibleDatasets = (tenant: string) =>
    [...deps.knowledge.datasets()]
      .filter(([, d]) => !d.tenants || d.tenants.includes(tenant))
      .map(([id, d]) => ({ id, name: d.name ?? id.slice(id.lastIndexOf('/') + 1) }));

  const datasetOf = (tenant: string, dataset: string) => {
    const id = deps.knowledge.resolve(dataset);
    const found = id ? visibleDatasets(tenant).find((d) => d.id === id) : undefined;
    if (!found) throw new BatchProblem(404, `Fant ikke datasettet ${dataset}`, 'dataset');
    return found;
  };

  const portFor = (principal: Principal, tenant: string, dataset: string): KnowledgePort =>
    deps.knowledge.open(
      { kind: 'dataset', id: datasetOf(tenant, dataset).id, tenant },
      contextFor(principal, tenant),
    );

  const listDocuments = async (
    principal: Principal,
    tenant: string,
    selection: Pick<ProjectSelection, 'dataset' | 'filters' | 'documents'>,
    max: number,
  ) => {
    const port = portFor(principal, tenant, selection.dataset);
    const list = port.documents?.bind(port);
    if (!list) throw new BatchProblem(422, 'Datasettet kan ikke liste dokumentene sine', 'dataset');
    const found: DocumentSummary[] = [];
    let total: number | undefined;
    for (let offset = 0; ; offset += pageSize) {
      const page = await list({
        ...(selection.documents ? { ids: selection.documents } : {}),
        filters: selection.filters,
        limit: Math.min(pageSize, max),
        offset,
      });
      found.push(...page.documents);
      total = page.found;
      if (
        found.length >= max ||
        (total ?? 0) >= max ||
        page.documents.length < Math.min(pageSize, max)
      )
        break;
    }
    const unique = new Map(found.filter((d) => d.id).map((d) => [d.id, d]));
    return { documents: [...unique.values()].map(toDocument), found: total ?? found.length };
  };

  const allDocuments = async (
    principal: Principal,
    tenant: string,
    selection: Subscription['basis'],
  ) => {
    const listed = await listDocuments(principal, tenant, selection, maxSubscriptionDocuments + 1);
    if (
      listed.found > maxSubscriptionDocuments ||
      listed.documents.length > maxSubscriptionDocuments
    )
      throw new BatchProblem(
        422,
        `Utvalget har ${listed.found} dokumenter. Et abonnement kan følge høyst ${maxSubscriptionDocuments}.`,
        'filters',
      );
    return listed.documents;
  };

  const sources = async (principal: Principal, tenant: string) => {
    const out = [];
    for (const dataset of visibleDatasets(tenant)) {
      let port: KnowledgePort;
      try {
        port = portFor(principal, tenant, dataset.id);
      } catch {
        continue;
      }
      if (!port.documents) continue;
      const declared = Object.entries(port.info().filters)
        .filter(([, kind]) =>
          (Array.isArray(kind) ? kind : [kind]).some((k) => k === 'select' || k === 'multiselect'),
        )
        .map(([field]) => field);
      const values: Record<string, { value: string; count: number }[]> = declared.length
        ? await port.facets(declared).catch(() => ({}))
        : {};
      const filters = declared.flatMap((field) => {
        const options = values[field] ?? [];
        const identifying = options.length > 20 && options.every((o) => o.count === 1);
        return options.length === 0 || identifying ? [] : [{ field, values: options }];
      });
      out.push({ id: dataset.id, name: dataset.name, filters });
    }
    return out;
  };

  const latestOf = async <T>(kind: string, tenant: string, id: string) =>
    (await deps.configEntries.history(kind, tenant, id)).at(-1) as ConfigEntry<T> | undefined;

  const projectOf = async (tenant: string, id: string) => {
    const entry = await latestOf<Project>(projectKind, tenant, id);
    return entry && !entry.deleted ? entry : undefined;
  };

  const list = async (tenant: string) =>
    (
      (await deps.configEntries.latest({
        kind: projectKind,
        scope: tenant,
      })) as ConfigEntry<Project>[]
    )
      .filter((e) => !e.deleted)
      .sort((a, b) => b.at.localeCompare(a.at));

  const history = async (tenant: string, id: string) =>
    (await deps.configEntries.history(projectKind, tenant, id)) as ConfigEntry<Project>[];

  const publishedServices = async (tenant: string) =>
    new Set(
      (await deps.definitions.capabilities())
        .filter((c) => c.service.tenant === tenant)
        .map((c) => c.service.id),
    );

  const normalize = async (
    tenant: string,
    id: string,
    input: Omit<Project, 'id' | 'changedBy'>,
  ): Promise<Omit<Project, 'changedBy'>> => {
    const errors: { path: string; message: string }[] = [];
    if (!input.name.trim()) errors.push({ path: 'name', message: 'a name is required' });
    if (input.selections.length > maxSelections)
      errors.push({ path: 'selections', message: `at most ${maxSelections} selections` });
    const ids = new Set<string>();
    const selections = input.selections.map((s, i) => {
      const selectionId = s.id || `utvalg-${i + 1}`;
      if (!slug.test(selectionId))
        errors.push({ path: `selections[${i}].id`, message: 'not a valid id' });
      if (ids.has(selectionId))
        errors.push({ path: `selections[${i}].id`, message: 'the id is used twice' });
      ids.add(selectionId);
      let dataset = s.dataset;
      try {
        dataset = datasetOf(tenant, s.dataset).id;
      } catch {
        errors.push({ path: `selections[${i}].dataset`, message: `unknown dataset ${s.dataset}` });
      }
      return {
        id: selectionId,
        name: s.name.trim() || selectionId,
        dataset,
        filters: s.filters,
        ...(s.documents?.length ? { documents: [...new Set(s.documents)] } : {}),
      };
    });
    const published = await publishedServices(tenant);
    const services = [...new Set(input.services)];
    services.forEach((service, i) => {
      if (!published.has(service))
        errors.push({ path: `services[${i}]`, message: `service ${service} is not published` });
    });
    if (errors.length) throw new ProjectInvalid(errors);
    return { id, name: input.name.trim(), purpose: input.purpose.trim(), selections, services };
  };

  const create = async (
    principal: Principal,
    tenant: string,
    input: Omit<Project, 'id' | 'changedBy'> & { id?: string },
    reason: string,
    changedBy?: string,
  ) => {
    const base =
      input.id ??
      (input.name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/æ/g, 'ae')
        .replace(/ø/g, 'o')
        .replace(/å/g, 'a')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) ||
        'prosjekt');
    if (!slug.test(base) || input.id === 'sources')
      throw new BatchProblem(400, 'Ugyldig prosjekt-id', 'id');
    let id = base === 'sources' ? 'sources-2' : base;
    for (let n = 2; await latestOf(projectKind, tenant, id); n += 1) {
      if (input.id) throw new BatchProblem(409, `Prosjektet ${id} finnes allerede`, 'id');
      id = `${base}-${n}`;
    }
    const spec = { ...(await normalize(tenant, id, input)), ...(changedBy ? { changedBy } : {}) };
    return appendVersion<Project>(deps.configEntries, {
      kind: projectKind,
      scope: tenant,
      id,
      spec,
      deleted: false,
      by: actorOf(principal.actor ?? principal),
      reason,
      at: now().toISOString(),
      ifVersion: 0,
    });
  };

  const update = async (
    principal: Principal,
    tenant: string,
    id: string,
    input: Omit<Project, 'id' | 'changedBy'>,
    reason: string,
    ifVersion?: number,
    changedBy?: string,
  ) => {
    const current = await projectOf(tenant, id);
    if (!current) throw new BatchProblem(404, 'Fant ikke prosjektet');
    const spec = { ...(await normalize(tenant, id, input)), ...(changedBy ? { changedBy } : {}) };
    try {
      return await appendVersion<Project>(deps.configEntries, {
        kind: projectKind,
        scope: tenant,
        id,
        spec,
        deleted: false,
        by: actorOf(principal.actor ?? principal),
        reason,
        at: now().toISOString(),
        ifVersion: ifVersion ?? current.version,
      });
    } catch (error) {
      if (error instanceof VersionConflict) throw new BatchProblem(409, error.message, 'version');
      throw error;
    }
  };

  const subscriptionsOf = async (tenant: string, project?: string) =>
    (
      (await deps.configEntries.latest({
        kind: subscriptionKind,
        scope: tenant,
      })) as ConfigEntry<Subscription>[]
    ).filter((e) => !e.deleted && (project === undefined || e.spec.project === project));

  const saveSubscription = (
    tenant: string,
    subscription: Subscription,
    by: string,
    reason: string,
    deleted = false,
  ) =>
    appendVersion<Subscription>(deps.configEntries, {
      kind: subscriptionKind,
      scope: tenant,
      id: subscriptionKey(subscription.project, subscription.selection),
      spec: subscription,
      deleted,
      by,
      reason,
      at: now().toISOString(),
    });

  const remove = async (principal: Principal, tenant: string, id: string, reason: string) => {
    const current = await projectOf(tenant, id);
    if (!current) throw new BatchProblem(404, 'Fant ikke prosjektet');
    const by = actorOf(principal.actor ?? principal);
    for (const entry of await subscriptionsOf(tenant, id))
      await saveSubscription(tenant, entry.spec, by, reason, true);
    await appendVersion<Project>(deps.configEntries, {
      kind: projectKind,
      scope: tenant,
      id,
      spec: current.spec,
      deleted: true,
      by,
      reason,
      at: now().toISOString(),
    });
  };

  const selectionOf = (project: Project, selection: string) => {
    const found = project.selections.find((s) => s.id === selection);
    if (!found) throw new BatchProblem(404, `Fant ikke utvalget ${selection}`, 'selection');
    return found;
  };

  const documents = async (
    principal: Principal,
    tenant: string,
    id: string,
    selection: string,
    limit: number,
  ) => {
    const project = await projectOf(tenant, id);
    if (!project) throw new BatchProblem(404, 'Fant ikke prosjektet');
    const chosen = selectionOf(project.spec, selection);
    const listed = await listDocuments(principal, tenant, chosen, limit);
    return {
      selection: chosen.id,
      dataset: chosen.dataset,
      datasetName: datasetOf(tenant, chosen.dataset).name,
      found: listed.found,
      documents: listed.documents.slice(0, limit),
    };
  };

  const runsOf = async (tenant: string, project: string) =>
    (
      (await deps.configEntries.latest({
        kind: projectRunKind,
        scope: tenant,
      })) as ConfigEntry<ProjectRun>[]
    )
      .map((e) => e.spec)
      .filter((r) => r.project === project)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const recordRun = (principal: Principal, tenant: string, run: ProjectRun, reason: string) =>
    appendVersion<ProjectRun>(deps.configEntries, {
      kind: projectRunKind,
      scope: tenant,
      id: run.run,
      spec: run,
      deleted: false,
      by: actorOf(principal.actor ?? principal),
      reason,
      at: now().toISOString(),
    });

  const runDetails = async (tenant: string, project: string) => {
    const out: { link: ProjectRun; run: BatchRun; totals: BatchTotals }[] = [];
    for (const link of await runsOf(tenant, project)) {
      const run = await batches.runOf(tenant, link.service, link.run);
      if (!run) continue;
      out.push({ link, run, totals: (await batches.detail(tenant, run)).totals });
    }
    return out;
  };

  const estimate = async (
    principal: Principal,
    tenant: string,
    id: string,
    body: { service: string; selection: string; prompt?: string; sample?: boolean },
    reason: string,
  ) => {
    const project = await projectOf(tenant, id);
    if (!project) throw new BatchProblem(404, 'Fant ikke prosjektet');
    if (!project.spec.services.includes(body.service))
      throw new BatchProblem(422, 'Tjenesten er ikke knyttet til prosjektet', 'service');
    const chosen = selectionOf(project.spec, body.selection);
    return batches.estimate(
      principal,
      tenant,
      body.service,
      {
        dataset: chosen.dataset,
        filters: chosen.filters,
        ...(chosen.documents ? { documents: chosen.documents } : {}),
        ...(body.prompt ? { prompt: body.prompt } : {}),
        sample: body.sample !== false,
      },
      reason,
    );
  };

  const start = async (
    principal: Principal,
    tenant: string,
    id: string,
    body: {
      estimate: string;
      selection?: string;
      maxCostNok?: number;
      maxTokens?: number;
      concurrency?: number;
    },
    reason: string,
  ) => {
    const project = await projectOf(tenant, id);
    if (!project) throw new BatchProblem(404, 'Fant ikke prosjektet');
    const found = await latestOf<BatchEstimate>('batch-estimate', tenant, body.estimate);
    const service = found?.spec.service;
    if (!service || !project.spec.services.includes(service))
      throw new BatchProblem(404, 'Fant ikke kostnadsberegningen', 'estimate');
    if (body.selection) selectionOf(project.spec, body.selection);
    const started = await batches.start(principal, tenant, service, body, reason);
    await recordRun(
      principal,
      tenant,
      {
        project: id,
        run: started.run.id,
        service,
        ...(body.selection ? { selection: body.selection } : {}),
        trigger: 'manual',
        month: monthOf(now()),
        startedAt: started.run.startedAt,
      },
      reason,
    );
    return started;
  };

  const servicePriced = async (tenant: string, service: string) => {
    const stored = await deps.definitions.get('Service', tenant, service);
    if (!stored) throw new BatchProblem(422, 'Tjenesten er ikke publisert', 'service');
    const spec = (stored.definition as { spec?: { model?: { primary?: unknown } } }).spec;
    const model = typeof spec?.model?.primary === 'string' ? spec.model.primary : undefined;
    return Boolean(model && deps.prices[model]);
  };

  const stateOf = async (tenant: string, key: string) => {
    const entry = await latestOf<SubscriptionState>(subscriptionStateKind, tenant, key);
    return { state: entry?.spec ?? emptyState(), version: entry?.version ?? 0 };
  };

  const saveState = (
    tenant: string,
    key: string,
    state: SubscriptionState,
    ifVersion: number,
    reason: string,
  ) =>
    appendVersion<SubscriptionState>(deps.configEntries, {
      kind: subscriptionStateKind,
      scope: tenant,
      id: key,
      spec: state,
      deleted: false,
      by: subscriptionActor,
      reason,
      at: now().toISOString(),
      ifVersion,
    });

  const spentThisMonth = async (tenant: string, subscription: Subscription) => {
    const month = monthOf(now());
    const spent = { micro: 0, tokens: 0 };
    for (const link of await runsOf(tenant, subscription.project)) {
      if (
        link.trigger !== 'subscription' ||
        link.selection !== subscription.selection ||
        link.month !== month
      )
        continue;
      const run = await batches.runOf(tenant, link.service, link.run);
      if (!run) continue;
      const { totals } = await batches.detail(tenant, run);
      const used = totals.tokens.input + totals.tokens.output;
      const running = run.status === 'queued' || run.status === 'running';
      spent.micro += running
        ? Math.max(run.cap.costMicroNok ?? 0, totals.costMicroNok ?? 0)
        : (totals.costMicroNok ?? 0);
      spent.tokens += running ? Math.max(run.cap.tokens ?? 0, used) : used;
    }
    return spent;
  };

  const detection = async (tenant: string, dataset: string) => {
    const pipelines = [
      ...(await deps.ingestion.list(tenant, dataset)),
      ...(await deps.ingestion.list(platformScope, dataset)),
    ];
    return pipelines.length > 0 ? ('ingestion' as const) : ('poll' as const);
  };

  const subscriptionView = async (tenant: string, entry: ConfigEntry<Subscription>) => {
    const key = subscriptionKey(entry.spec.project, entry.spec.selection);
    const { state } = await stateOf(tenant, key);
    const spent = await spentThisMonth(tenant, entry.spec);
    return {
      ...entry.spec,
      status: entry.spec.paused ? ('paused' as const) : ('active' as const),
      detection: await detection(tenant, entry.spec.basis.dataset),
      fresh: [...state.fresh].reverse().slice(0, 50),
      waiting: entry.spec.mode === 'run' ? state.fresh.filter((f) => !f.run).length : 0,
      known: state.seen.length,
      ...(state.checkedAt ? { checkedAt: state.checkedAt } : {}),
      ...(state.error ? { error: state.error } : {}),
      month: monthOf(now()),
      spentThisMonth: { costMicroNok: spent.micro, tokens: spent.tokens },
      version: entry.version,
      by: entry.by,
      at: entry.at,
      reason: entry.reason,
    };
  };

  const pause = async (
    tenant: string,
    entry: ConfigEntry<Subscription>,
    paused: Omit<SubscriptionPause, 'at'>,
  ) => {
    const spec = { ...entry.spec, paused: { ...paused, at: now().toISOString() } };
    await saveSubscription(tenant, spec, subscriptionActor, paused.reason);
    return spec.paused;
  };

  const subscribe = async (
    principal: Principal,
    tenant: string,
    id: string,
    selection: string,
    body: { mode: SubscriptionMode; service?: string; prompt?: string } & SubscriptionCap,
    reason: string,
    changedBy?: string,
  ) => {
    const project = await projectOf(tenant, id);
    if (!project) throw new BatchProblem(404, 'Fant ikke prosjektet');
    const chosen = selectionOf(project.spec, selection);
    if (chosen.documents?.length)
      throw new BatchProblem(
        422,
        'Et utvalg med faste dokumenter får ingen nye dokumenter. Bruk filtre for å følge med.',
        'selection',
      );
    if (body.mode === 'run') {
      if (!body.service)
        throw new BatchProblem(400, 'Velg tjenesten som skal kjøres på nye dokumenter', 'service');
      if (!project.spec.services.includes(body.service))
        throw new BatchProblem(422, 'Tjenesten er ikke knyttet til prosjektet', 'service');
      const priced = await servicePriced(tenant, body.service);
      if (priced && body.maxCostNok === undefined)
        throw new BatchProblem(400, 'Sett en månedsgrense i kroner', 'maxCostNok');
      if (!priced && body.maxTokens === undefined)
        throw new BatchProblem(
          400,
          'Modellen har ingen pris. Sett en månedsgrense for antall tokens',
          'maxTokens',
        );
    }
    const key = subscriptionKey(id, selection);
    const existing = await latestOf<Subscription>(subscriptionKind, tenant, key);
    const basis = { dataset: chosen.dataset, filters: chosen.filters };
    const capRaised = (before: Subscription) =>
      before.paused?.kind === 'cost-cap' &&
      ((body.maxCostNok ?? 0) > (before.cap.maxCostNok ?? 0) ||
        (body.maxTokens ?? 0) > (before.cap.maxTokens ?? 0));
    const spec: Subscription = {
      project: id,
      selection,
      mode: body.mode,
      ...(body.mode === 'run' && body.service ? { service: body.service } : {}),
      ...(body.mode === 'run' && body.prompt ? { prompt: body.prompt } : {}),
      cap: {
        ...(body.maxCostNok === undefined ? {} : { maxCostNok: body.maxCostNok }),
        ...(body.maxTokens === undefined ? {} : { maxTokens: body.maxTokens }),
      },
      basis,
      ...(existing && !existing.deleted && existing.spec.paused && !capRaised(existing.spec)
        ? { paused: existing.spec.paused }
        : {}),
      ...(changedBy ? { changedBy } : {}),
    };
    return serialFor(`${tenant}/${key}`)(async () => {
      if (!existing || existing.deleted || !sameBasis(existing.spec.basis, basis)) {
        const known = await allDocuments(workerFor(tenant, key), tenant, basis);
        const { version } = await stateOf(tenant, key);
        await saveState(
          tenant,
          key,
          { seen: known.map((d) => d.id), fresh: [], checkedAt: now().toISOString() },
          version,
          'Dokumentene som passer nå regnes som kjente',
        );
      }
      return saveSubscription(tenant, spec, actorOf(principal.actor ?? principal), reason);
    });
  };

  const subscriptionOf = async (tenant: string, id: string, selection: string) => {
    const entry = await latestOf<Subscription>(
      subscriptionKind,
      tenant,
      subscriptionKey(id, selection),
    );
    if (!entry || entry.deleted) throw new BatchProblem(404, 'Fant ikke abonnementet');
    return entry;
  };

  const unsubscribe = async (
    principal: Principal,
    tenant: string,
    id: string,
    selection: string,
    reason: string,
  ) => {
    const entry = await subscriptionOf(tenant, id, selection);
    await saveSubscription(tenant, entry.spec, actorOf(principal.actor ?? principal), reason, true);
  };

  const setPaused = async (
    principal: Principal,
    tenant: string,
    id: string,
    selection: string,
    paused: boolean,
    reason: string,
  ) => {
    const entry = await subscriptionOf(tenant, id, selection);
    const spec: Subscription = { ...entry.spec };
    if (paused) spec.paused = { kind: 'manual', reason, at: now().toISOString() };
    else delete spec.paused;
    return saveSubscription(tenant, spec, actorOf(principal.actor ?? principal), reason);
  };

  const check = (tenant: string, key: string, cause: string): Promise<CheckResult> =>
    serialFor(`${tenant}/${key}`)(async (): Promise<CheckResult> => {
      let entry = await latestOf<Subscription>(subscriptionKind, tenant, key);
      if (!entry || entry.deleted) return { status: 'off', arrived: 0, waiting: 0 };
      const month = monthOf(now());
      if (entry.spec.paused?.kind === 'cost-cap' && entry.spec.paused.month !== month) {
        const resumed = { ...entry.spec };
        delete resumed.paused;
        entry = await saveSubscription(
          tenant,
          resumed,
          subscriptionActor,
          'Ny måned: abonnementet fortsetter',
        );
      }
      const subscription = entry.spec;
      if (subscription.paused)
        return { status: 'paused', arrived: 0, waiting: 0, paused: subscription.paused };
      const project = await projectOf(tenant, subscription.project);
      const selection = project?.spec.selections.find((s) => s.id === subscription.selection);
      if (!project || !selection) {
        const paused = await pause(tenant, entry, {
          kind: 'problem',
          reason: 'Abonnementet er satt på pause: utvalget finnes ikke lenger i prosjektet.',
        });
        return { status: 'paused', arrived: 0, waiting: 0, paused };
      }
      const worker = workerFor(tenant, key);
      const { state, version } = await stateOf(tenant, key);
      const basis = { dataset: selection.dataset, filters: selection.filters };
      if (!sameBasis(subscription.basis, basis)) {
        const known = await allDocuments(worker, tenant, basis);
        await saveState(
          tenant,
          key,
          { ...state, seen: known.map((d) => d.id), checkedAt: now().toISOString() },
          version,
          'Utvalget er endret: dokumentene som passer nå regnes som kjente',
        );
        await saveSubscription(
          tenant,
          { ...subscription, basis },
          subscriptionActor,
          'Utvalget i prosjektet er endret',
        );
        return { status: 'checked', arrived: 0, waiting: 0 };
      }
      let current: BatchDocument[];
      try {
        current = await allDocuments(worker, tenant, basis);
      } catch (error) {
        if (
          (error instanceof KnowledgeError &&
            (error.code === 'forbidden' || error.code === 'residency')) ||
          (error instanceof BatchProblem && error.status === 404)
        ) {
          const paused = await pause(tenant, entry, {
            kind: 'problem',
            reason: 'Abonnementet er satt på pause: det har ikke lenger tilgang til datasettet.',
          });
          return { status: 'paused', arrived: 0, waiting: 0, paused };
        }
        await saveState(
          tenant,
          key,
          { ...state, error: messageOf(error), checkedAt: now().toISOString() },
          version,
          cause,
        ).catch(() => undefined);
        return { status: 'checked', arrived: 0, waiting: 0, error: messageOf(error) };
      }
      let fresh = state.fresh;
      if (state.claim) {
        if (now().getTime() - new Date(state.claim.at).getTime() < claimStaleMs)
          return { status: 'busy', arrived: 0, waiting: 0 };
        const claimed = state.claim;
        const recorded = (await runsOf(tenant, subscription.project)).find(
          (r) => r.claim === claimed.id,
        );
        if (recorded)
          fresh = fresh.map((f) =>
            claimed.documents.includes(f.document.id) ? { ...f, run: recorded.run } : f,
          );
      }
      const seen = new Set(state.seen);
      const arrivedAt = now().toISOString();
      const arrived = current.filter((d) => !seen.has(d.id));
      fresh = [...fresh, ...arrived.map((document) => ({ document, arrivedAt }))].slice(-freshKept);
      const present = new Set(current.map((d) => d.id));
      const todo =
        subscription.mode === 'run'
          ? fresh.filter((f) => !f.run && present.has(f.document.id))
          : [];
      const next: SubscriptionState = {
        seen: [...seen, ...arrived.map((d) => d.id)],
        fresh,
        checkedAt: arrivedAt,
      };
      const reason = arrived.length
        ? `${cause}: ${arrived.length} nye dokumenter`
        : `${cause}: ingen nye dokumenter`;
      const settle = (paused?: SubscriptionPause, error?: string): Promise<CheckResult> =>
        saveState(tenant, key, { ...next, ...(error ? { error } : {}) }, version, reason).then(
          () => ({
            status: paused ? 'paused' : 'checked',
            arrived: arrived.length,
            waiting: todo.length,
            ...(paused ? { paused } : {}),
            ...(error ? { error } : {}),
          }),
          (conflict: unknown) => {
            if (conflict instanceof VersionConflict)
              return { status: 'busy', arrived: 0, waiting: 0 };
            throw conflict;
          },
        );
      if (todo.length === 0 || !subscription.service) return settle();

      let estimated: BatchEstimate;
      try {
        estimated = await batches.estimate(
          worker,
          tenant,
          subscription.service,
          {
            dataset: basis.dataset,
            filters: basis.filters,
            documents: todo.map((f) => f.document.id),
            ...(subscription.prompt ? { prompt: subscription.prompt } : {}),
            sample: false,
          },
          `Abonnement i prosjektet ${project.spec.name}: ${todo.length} nye dokumenter`,
        );
      } catch (error) {
        const paused = await pause(tenant, entry, {
          kind: 'problem',
          reason: `Abonnementet er satt på pause: ${messageOf(error)}`,
        });
        return settle(paused);
      }
      const spent = await spentThisMonth(tenant, subscription);
      const priced = estimated.priced && estimated.costMicroNok !== null;
      const limit = priced
        ? subscription.cap.maxCostNok !== undefined
          ? Math.round(subscription.cap.maxCostNok * 1_000_000)
          : undefined
        : subscription.cap.maxTokens;
      if (limit === undefined) {
        const paused = await pause(tenant, entry, {
          kind: 'problem',
          reason: priced
            ? 'Abonnementet er satt på pause: det mangler en månedsgrense i kroner.'
            : 'Abonnementet er satt på pause: modellen har ingen pris, og det mangler en grense for antall tokens.',
        });
        return settle(paused);
      }
      const used = priced ? spent.micro : spent.tokens;
      const need = priced ? (estimated.costMicroNok?.high ?? 0) : estimated.tokens.high;
      if (used + need > limit) {
        const paused = await pause(tenant, entry, {
          kind: 'cost-cap',
          month,
          reason: priced
            ? `Månedsgrensen på ${kroner(limit)} er nådd. ${todo.length} nye dokumenter venter.`
            : `Månedsgrensen på ${limit.toLocaleString('nb-NO')} tokens er nådd. ${todo.length} nye dokumenter venter.`,
        });
        return settle(paused);
      }
      const claim = {
        id: randomUUID(),
        documents: todo.map((f) => f.document.id),
        at: arrivedAt,
      };
      let claimed;
      try {
        claimed = await saveState(tenant, key, { ...next, claim }, version, reason);
      } catch (error) {
        if (error instanceof VersionConflict) return { status: 'busy', arrived: 0, waiting: 0 };
        throw error;
      }
      const remaining = limit - used;
      let started;
      try {
        started = await batches.start(
          worker,
          tenant,
          subscription.service,
          {
            estimate: estimated.id,
            ...(priced ? { maxCostNok: remaining / 1_000_000 } : { maxTokens: remaining }),
          },
          `Abonnement i prosjektet ${project.spec.name}: kjører ${todo.length} nye dokumenter`,
        );
      } catch (error) {
        await saveState(
          tenant,
          key,
          next,
          claimed.version,
          `Kunne ikke starte: ${messageOf(error)}`,
        );
        const paused = await pause(tenant, entry, {
          kind: 'problem',
          reason: `Abonnementet er satt på pause: ${messageOf(error)}`,
        });
        return { status: 'paused', arrived: arrived.length, waiting: todo.length, paused };
      }
      await recordRun(
        worker,
        tenant,
        {
          project: subscription.project,
          run: started.run.id,
          service: subscription.service,
          selection: subscription.selection,
          trigger: 'subscription',
          claim: claim.id,
          month,
          startedAt: started.run.startedAt,
        },
        `Abonnement: ${todo.length} nye dokumenter`,
      );
      const ran = new Set(claim.documents);
      await saveState(
        tenant,
        key,
        {
          ...next,
          fresh: fresh.map((f) => (ran.has(f.document.id) ? { ...f, run: started.run.id } : f)),
        },
        claimed.version,
        `Startet kjøring over ${todo.length} nye dokumenter`,
      );
      return {
        status: 'started',
        arrived: arrived.length,
        waiting: 0,
        run: started.run.id,
        done: started.done,
      };
    });

  const checkInBackground = (tenant: string, key: string, cause: string) => {
    const work = check(tenant, key, cause).then(async (result) => {
      if (result.done) await result.done;
    });
    background(work);
    return work;
  };

  const checkAll = async (cause: string, dataset?: string) => {
    const entries = (await deps.configEntries.latest({
      kind: subscriptionKind,
    })) as ConfigEntry<Subscription>[];
    const work = entries
      .filter(
        (e) =>
          !e.deleted &&
          (dataset === undefined ||
            (deps.knowledge.resolve(e.spec.basis.dataset) ?? e.spec.basis.dataset) === dataset),
      )
      .map((e) => checkInBackground(e.scope, e.id, cause));
    await Promise.allSettled(work);
  };

  const ingested = (execution: Execution) => {
    if (execution.status !== 'succeeded') return;
    const dataset = deps.knowledge.resolve(execution.dataset) ?? execution.dataset;
    background(checkAll('Innlesing ferdig', dataset));
  };

  const watch = () => {
    const stopIngestion = deps.ingestion.onFinished(ingested);
    const job = schedule(options.pollCron ?? '7 * * * *', () => checkAll('Planlagt sjekk'), {
      ...(options.clock ? { clock: options.clock } : {}),
      timeZone: 'Europe/Oslo',
      onError: () => undefined,
    });
    return () => {
      stopIngestion();
      job.stop();
    };
  };

  return {
    batches,
    sources,
    list,
    projectOf,
    history,
    create,
    update,
    remove,
    documents,
    estimate,
    start,
    runsOf,
    runDetails,
    subscriptionsOf,
    subscriptionView,
    subscribe,
    unsubscribe,
    setPaused,
    check,
    checkInBackground,
    checkAll,
    watch,
  };
};

export type Projects = ReturnType<typeof projects>;
