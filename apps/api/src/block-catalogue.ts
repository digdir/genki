import {
  blockFixtures,
  blockStates,
  blockZones,
  type BlockData,
  type BlockDetail,
  type BlockEdition,
  type BlockOrigin,
  type BlockState,
  type BlockSummary,
  type BlockUse,
  type BlockZone,
  type Principal,
  isFromClaude,
} from '@genai/contracts';
import {
  parseBlockRef,
  type BlockDefinition,
  type PublishedVersion,
  type ServiceDefinition,
  type ValidationError,
} from '@genai/definitions';
import type { Context } from 'hono';
import { enterTenant } from './access.js';
import { actorNames } from './actor-names.js';
import { actorOf, AdminRefused, blockPublisherProblems, refusedBy } from './admin.js';
import { isBlockArchived } from './block-archive.js';
import { blockFrameUrl } from './block-origin.js';
import { latestReview } from './block-reviews.js';
import { VersionConflict } from './config-store.js';
import { readDefinition } from './definitions.js';
import { changeReasonOf, problem } from './http.js';
import { definitionBodyLimit } from './block-bundles.js';
import { t } from './i18n/index.js';
import { blockRefProblems } from './interface-catalogue.js';
import { blockSpecOf, mayUseEdition, refBlockPayload } from './interface-blocks.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';
import type { Right } from './rights.js';
import { serviceDrafts, type ServiceDraft } from './service-drafts.js';
import { environmentsOf, productionEnvironment } from './service-environments.js';

export const blockPinAction = 'platform.service.draft.save';

const testEnvironment = 'test';

type Tree = Record<string, unknown>;

const isRecord = (value: unknown): value is Tree =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface Visible {
  publisher: string;
  id: string;
  editions: PublishedVersion[];
}

const keyOf = (publisher: string, id: string) => `${publisher}/${id}`;

const titleOf = (summary: Pick<BlockSummary, 'title'>) => summary.title.nb ?? '';

const originOrder: Record<BlockOrigin, number> = { own: 0, 'built-in': 1, shared: 2 };

type Layout = { zones: Record<BlockZone, Tree[]> } & Tree;

const layoutOf = (definition: Tree): Layout | undefined => {
  const spec = isRecord(definition.spec) ? definition.spec : undefined;
  const shown = spec && isRecord(spec.interface) ? spec.interface : undefined;
  const layout = shown && isRecord(shown.layout) ? shown.layout : undefined;
  return layout && isRecord(layout.zones) ? (layout as Layout) : undefined;
};

/** The edition of each block a service definition pins, by `publisher/id`. */
const pinsOf = (definition: unknown) => {
  const pins = new Map<string, number>();
  const layout = isRecord(definition) ? layoutOf(definition) : undefined;
  for (const zone of blockZones)
    for (const placed of layout?.zones[zone] ?? []) {
      const target = typeof placed.ref === 'string' ? parseBlockRef(placed.ref) : undefined;
      if (target) pins.set(keyOf(target.publisher, target.id), target.version);
    }
  return pins;
};

const isPinOf = (placed: Tree, publisher: string, id: string) => {
  const target = typeof placed.ref === 'string' ? parseBlockRef(placed.ref) : undefined;
  return target?.publisher === publisher && target.id === id;
};

/** The definition with the block pinned at the edition, moved there when it already stands in it. */
const withPin = (
  definition: Tree,
  pin: {
    publisher: string;
    id: string;
    entry: Tree;
    zone: BlockZone | undefined;
    fallback: BlockZone;
  },
): { definition: Tree; at: string } | undefined => {
  const next = structuredClone(definition);
  const layout = layoutOf(next);
  if (!layout) return undefined;
  for (const zone of blockZones) layout.zones[zone] = layout.zones[zone] ?? [];
  const existing = blockZones.flatMap((zone) =>
    layout.zones[zone].flatMap((placed, index) =>
      isPinOf(placed, pin.publisher, pin.id) ? [{ zone, index, placed }] : [],
    ),
  );
  const first = existing[0];
  for (const zone of blockZones)
    layout.zones[zone] = layout.zones[zone].filter((p) => !isPinOf(p, pin.publisher, pin.id));
  const zone = pin.zone ?? first?.zone ?? pin.fallback;
  const settings = pin.entry.settings ?? first?.placed.settings;
  const entry = { ...pin.entry, ...(settings === undefined ? {} : { settings }) };
  const index = first && first.zone === zone ? first.index : layout.zones[zone].length;
  layout.zones[zone].splice(index, 0, entry);
  return { definition: next, at: `spec.interface.layout.zones.${zone}[${index}]` };
};

const withoutPin = (definition: Tree, publisher: string, id: string) => {
  const next = structuredClone(definition);
  const layout = layoutOf(next);
  let removed = 0;
  for (const zone of blockZones) {
    const kept = (layout?.zones[zone] ?? []).filter((p) => !isPinOf(p, publisher, id));
    removed += (layout?.zones[zone]?.length ?? 0) - kept.length;
    if (layout) layout.zones[zone] = kept;
  }
  return removed > 0 ? next : undefined;
};

const settingsOf = (value: unknown) =>
  isRecord(value) &&
  Object.values(value).every((v) => typeof v === 'boolean' || typeof v === 'string')
    ? (value as Record<string, boolean | string>)
    : undefined;

export const blockCatalogueModule: PlatformModuleFactory = (deps) => {
  const store = deps.definitions;
  const drafts = serviceDrafts(deps.configEntries, store);
  const names = actorNames(deps.configEntries);

  const blocksAcross = async (tenant: string) => {
    if (store.listAcross) return store.listAcross('Block');
    const of = async (owner: string) =>
      (await store.list(owner))
        .filter((e) => e.kind === 'Block')
        .map((e) => ({ tenant: owner, id: e.id }));
    return [
      ...(await of(tenant)),
      ...(tenant === deps.platformTenant ? [] : await of(deps.platformTenant)),
    ];
  };

  const mayShow = (studio: boolean, version: PublishedVersion) =>
    studio || blockSpecOf(version).tier !== 'code';

  const visibleEditions = async (
    tenant: string,
    publisher: string,
    id: string,
    studio: boolean,
  ) => {
    const versions = await store.versions('Block', publisher, id);
    const latest = versions.at(-1);
    if (latest && (await isBlockArchived(deps.configEntries, publisher, id, latest.version)))
      return [];
    return versions.filter((v) => mayUseEdition(tenant, publisher, v) && mayShow(studio, v));
  };

  const visibleBlocks = async (tenant: string, studio: boolean): Promise<Visible[]> => {
    const found: Visible[] = [];
    for (const { tenant: publisher, id } of await blocksAcross(tenant)) {
      const editions = await visibleEditions(tenant, publisher, id, studio);
      if (editions.length > 0) found.push({ publisher, id, editions });
    }
    return found;
  };

  const versionOf = async (tenant: string, service: string, version: number | undefined) =>
    version === undefined ? undefined : store.get('Service', tenant, service, version);

  /** Where the organisation's own services pin each block: the draft, test and the version in use. */
  const usesIn = async (tenant: string) => {
    const uses = new Map<string, BlockUse[]>();
    for (const entry of await store.list(tenant)) {
      if (entry.kind !== 'Service') continue;
      const latest = await store.get('Service', tenant, entry.id);
      const draft = await drafts.draftOf(tenant, entry.id);
      const environments = await environmentsOf(deps.configEntries, tenant, entry.id);
      const pointed = (name: string) =>
        Object.hasOwn(environments, name)
          ? (environments[name]?.version ?? latest?.version)
          : undefined;
      const test = await versionOf(
        tenant,
        entry.id,
        Object.hasOwn(environments, testEnvironment) ? pointed(testEnvironment) : latest?.version,
      );
      const inUse = await versionOf(tenant, entry.id, pointed(productionEnvironment));
      const name = (latest?.definition as ServiceDefinition | undefined)?.metadata.name ?? entry.id;
      const pinned = {
        draft: pinsOf(draft?.spec.definition),
        test: pinsOf(test?.definition),
        inUse: pinsOf(inUse?.definition),
      };
      const keys = new Set([...pinned.draft.keys(), ...pinned.test.keys(), ...pinned.inUse.keys()]);
      for (const key of keys) {
        const use: BlockUse = { service: entry.id, name };
        const draftEdition = pinned.draft.get(key);
        const testEdition = pinned.test.get(key);
        const inUseEdition = pinned.inUse.get(key);
        if (draftEdition !== undefined) use.draft = draftEdition;
        if (testEdition !== undefined) use.test = testEdition;
        if (inUseEdition !== undefined) use.inUse = inUseEdition;
        uses.set(key, [...(uses.get(key) ?? []), use]);
      }
    }
    return uses;
  };

  const editionOf = (version: PublishedVersion, byName?: Map<string, string>): BlockEdition => {
    const name = byName?.get(version.publishedBy);
    return {
      version: version.version,
      publishedAt: version.publishedAt,
      ...(byName ? { publishedBy: version.publishedBy } : {}),
      ...(name ? { publishedByName: name } : {}),
      reason: version.reason,
      sharing: blockSpecOf(version).sharing,
    };
  };

  const summaryOf = (
    tenant: string,
    block: Visible,
    publisherNames: Map<string, string>,
    usedBy: number,
  ): BlockSummary => {
    const latest = block.editions.at(-1) as PublishedVersion;
    const spec = blockSpecOf(latest);
    const origin: BlockOrigin =
      spec.tier === 'built-in' && block.publisher === deps.platformTenant
        ? 'built-in'
        : block.publisher === tenant
          ? 'own'
          : 'shared';
    return {
      publisher: block.publisher,
      publisherName: publisherNames.get(block.publisher) ?? block.publisher,
      id: block.id,
      tier: spec.tier,
      origin,
      title: spec.title,
      ...(spec.summary ? { summary: spec.summary } : {}),
      zones: spec.zones,
      sharing: spec.sharing,
      latest: {
        version: latest.version,
        publishedAt: latest.publishedAt,
        ...(isFromClaude(latest.reason) ? { fromClaude: true } : {}),
      },
      editions: block.editions.length,
      usedBy,
    };
  };

  return {
    id: 'block-catalogue',
    mount: (app, mounted: MountDeps) => {
      const member = async (c: Context, right?: Right) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return { response: problem(c, 401, t('problems.unauthorized')) };
        const tenant = c.req.param('tenant') ?? '';
        const entered = enterTenant(c, mounted.access, principal, tenant, right);
        if ('response' in entered) return { response: entered.response };
        return { principal: entered.principal, tenant };
      };
      const publisherNames = async () => {
        return mounted.admin.tenantNames();
      };
      const notFound = (c: Context) => problem(c, 404, t('problems.blockNotFound'));
      const studioFor = (guard: { principal: Principal; tenant: string }) =>
        deps.flags.on({ principal: guard.principal, tenant: guard.tenant }, 'blockStudio');

      app.get('/tenants/:tenant/blocks', async (c) => {
        const guard = await member(c);
        if (guard.response) return guard.response;
        const origin = c.req.query('origin');
        const [blocks, uses, publishers] = await Promise.all([
          visibleBlocks(guard.tenant, await studioFor(guard)),
          usesIn(guard.tenant),
          publisherNames(),
        ]);
        const data = blocks
          .map((block) =>
            summaryOf(
              guard.tenant,
              block,
              publishers,
              uses.get(keyOf(block.publisher, block.id))?.length ?? 0,
            ),
          )
          .filter((summary) => origin === undefined || summary.origin === origin)
          .sort(
            (a, b) =>
              originOrder[a.origin] - originOrder[b.origin] ||
              titleOf(a).localeCompare(titleOf(b), 'nb'),
          );
        return c.json({ data });
      });

      app.get('/tenants/:tenant/blocks/:publisher/:id', async (c) => {
        const guard = await member(c);
        if (guard.response) return guard.response;
        const publisher = c.req.param('publisher') ?? '';
        const id = c.req.param('id') ?? '';
        const studio = await studioFor(guard);
        const editions = await visibleEditions(guard.tenant, publisher, id, studio);
        const asked = c.req.query('version');
        const chosen =
          asked === undefined ? editions.at(-1) : editions.find((v) => String(v.version) === asked);
        if (!chosen) return notFound(c);
        const [uses, publishers, byName] = await Promise.all([
          usesIn(guard.tenant),
          publisherNames(),
          publisher === guard.tenant
            ? names.namesOf(editions.map((v) => v.publishedBy))
            : undefined,
        ]);
        const usedIn = uses.get(keyOf(publisher, id)) ?? [];
        const summary = summaryOf(
          guard.tenant,
          { publisher, id, editions },
          publishers,
          usedIn.length,
        );
        const spec = blockSpecOf(chosen);
        const ref = `${publisher}/${id}@${chosen.version}`;
        const render = refBlockPayload(
          ref,
          publisher,
          spec,
          spec.code
            ? blockFrameUrl(deps.blockOrigin)({
                publisher,
                id,
                version: chosen.version,
                sha256: spec.code.sha256,
              })
            : undefined,
          summary.publisherName,
        );
        const detail: BlockDetail = {
          ...summary,
          editions: editions.map((v) => editionOf(v, byName)),
          edition: {
            ...editionOf(chosen, byName),
            definition: chosen.definition as unknown as Record<string, unknown>,
            ...(render ? { render } : {}),
          },
          usedIn,
        };
        const review =
          studio && publisher === guard.tenant
            ? await latestReview(deps.configEntries, publisher, id)
            : undefined;
        return c.json(review ? { ...detail, review } : detail);
      });

      app.post('/tenants/:tenant/blocks/preview', definitionBodyLimit, async (c) => {
        const guard = await member(c, 'manage-services');
        if (guard.response) return guard.response;
        const read = await readDefinition(c, deps.plugins);
        if ('unreadable' in read)
          return problem(c, 400, t('problems.unreadableDefinition'), { detail: read.unreadable });
        const raw = (await c.req.json().catch(() => ({}))) as { states?: unknown };
        const wanted = Array.isArray(raw.states)
          ? blockStates.filter((s) => (raw.states as unknown[]).includes(s))
          : [...blockStates];
        const fixtures = Object.fromEntries(
          wanted.map((state) => [state, blockFixtures[state]]),
        ) as Record<BlockState, BlockData>;
        const { validated } = read;
        if (validated.ok && validated.definition.kind !== 'Block')
          return problem(c, 422, t('problems.invalidDefinition'), {
            errors: [{ path: 'kind', message: 'a preview shows a Block' }],
          });
        if (validated.ok && validated.definition.metadata.tenant !== guard.tenant)
          return problem(c, 403, t('problems.blockOtherTenant'));
        if (!validated.ok)
          return c.json({ valid: false, errors: validated.errors, reads: [], fixtures });
        const definition = validated.definition as BlockDefinition;
        const errors: ValidationError[] = [
          ...blockPublisherProblems(definition, guard.principal),
          ...(await mounted.admin.check(definition, read.files, guard.principal)),
        ];
        if (errors.length > 0) return c.json({ valid: false, errors, reads: [], fixtures });
        const render = refBlockPayload(
          `${guard.tenant}/${definition.metadata.id}@0`,
          guard.tenant,
          definition.spec,
        );
        return c.json({
          valid: true,
          ...(render ? { render } : {}),
          reads: render?.reads ?? [],
          fixtures,
        });
      });

      const reasonOf = (c: Context) => changeReasonOf(c)?.trim() ?? '';

      const saveDraft = async (
        c: Context,
        guard: { principal: Principal; tenant: string },
        service: string,
        draft: ServiceDraft,
        revision: number | undefined,
      ) => {
        const reason = reasonOf(c);
        const done = await mounted.admin.within(
          guard.principal,
          blockPinAction,
          { tenant: guard.tenant, reason, service },
          async () => ({
            value: await drafts.save(
              guard.principal,
              guard.tenant,
              service,
              draft,
              reason,
              revision,
            ),
            target: `service-draft:${service}`,
          }),
        );
        c.header('genai-task', done.task);
        const checks = deps.publishCheck
          ? await deps.publishCheck(
              done.value.spec.definition,
              actorOf(guard.principal.actor ?? guard.principal),
            )
          : [];
        return c.json({
          revision: done.value.version,
          definition: done.value.spec.definition,
          files: done.value.spec.files,
          baseVersion: done.value.spec.baseVersion ?? null,
          checks,
        });
      };

      const failed = (c: Context, error: unknown) => {
        if (error instanceof VersionConflict)
          return problem(c, 409, t('problems.conflict'), {
            errors: [{ path: 'revision', message: error.message }],
          });
        if (error instanceof AdminRefused) return refusedBy(c, error);
        throw error;
      };

      const startingDraft = async (tenant: string, service: string) => {
        const current = await drafts.draftOf(tenant, service);
        if (current) return { draft: current.spec, revision: current.version };
        const latest = await store.get('Service', tenant, service);
        if (!latest) return undefined;
        return {
          draft: {
            definition: structuredClone(latest.definition) as unknown as Tree,
            files: { ...latest.files },
            baseVersion: latest.version,
          } satisfies ServiceDraft,
          revision: 0,
        };
      };

      const pinPath = '/tenants/:tenant/services/:id/draft/blocks/:publisher/:blockId';

      app.put(pinPath, async (c) => {
        const guard = await member(c, 'manage-services');
        if (guard.response) return guard.response;
        const service = c.req.param('id') ?? '';
        const publisher = c.req.param('publisher') ?? '';
        const blockId = c.req.param('blockId') ?? '';
        const body = (await c.req.json().catch(() => ({}))) as Tree;
        const version = body.version;
        const settings = body.settings === undefined ? undefined : settingsOf(body.settings);
        const zone = body.zone as BlockZone | undefined;
        const invalid: ValidationError[] = [
          ...(typeof version === 'number' && Number.isInteger(version) && version > 0
            ? []
            : [{ path: 'version', message: 'version is a published edition of the block' }]),
          ...(zone === undefined || (blockZones as readonly unknown[]).includes(zone)
            ? []
            : [{ path: 'zone', message: 'zone is primary, main or secondary' }]),
          ...(body.settings !== undefined && !settings
            ? [{ path: 'settings', message: 'settings map names to true, false or a text' }]
            : []),
        ];
        if (invalid.length > 0)
          return problem(c, 400, t('problems.invalidRequest'), { errors: invalid });
        const edition = await store.get('Block', publisher, blockId, version as number);
        if (
          !edition ||
          !mayUseEdition(guard.tenant, publisher, edition) ||
          !mayShow(await studioFor(guard), edition) ||
          (await visibleEditions(guard.tenant, publisher, blockId, true)).length === 0
        )
          return notFound(c);
        const spec = blockSpecOf(edition);
        const start = await startingDraft(guard.tenant, service);
        if (!start) return problem(c, 404, t('problems.notFound'));
        const pinned = withPin(start.draft.definition, {
          publisher,
          id: blockId,
          zone,
          fallback: spec.zones[0] ?? 'main',
          entry: {
            block: spec.tier === 'built-in' ? spec.builtIn : 'ref',
            ref: `${publisher}/${blockId}@${String(version)}`,
            ...(settings ? { settings } : {}),
          },
        });
        if (!pinned)
          return problem(c, 422, t('problems.invalidDefinition'), {
            errors: [
              {
                path: 'spec.interface.layout',
                message: 'the service has no layout to pin a block into',
              },
            ],
          });
        const { definition, at } = pinned;
        const refused = (
          await blockRefProblems(store, definition as unknown as ServiceDefinition)
        ).filter((p) => p.path === at || p.path.startsWith(`${at}.`));
        if (refused.length > 0)
          return problem(c, 422, t('problems.invalidDefinition'), { errors: refused });
        try {
          return await saveDraft(c, guard, service, { ...start.draft, definition }, start.revision);
        } catch (error) {
          return failed(c, error);
        }
      });

      app.delete(pinPath, async (c) => {
        const guard = await member(c, 'manage-services');
        if (guard.response) return guard.response;
        const service = c.req.param('id') ?? '';
        const start = await startingDraft(guard.tenant, service);
        const definition =
          start &&
          withoutPin(
            start.draft.definition,
            c.req.param('publisher') ?? '',
            c.req.param('blockId') ?? '',
          );
        if (!start || !definition) return problem(c, 404, t('problems.blockNotPinned'));
        try {
          return await saveDraft(c, guard, service, { ...start.draft, definition }, start.revision);
        } catch (error) {
          return failed(c, error);
        }
      });
    },
  };
};
