import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api';
import type {
  PlaygroundOptions,
  PlaygroundServiceRef,
  PlaygroundSetup,
} from '../../api/playground';
import type { SetupChange } from '../../data/playground';
import { applySpec, asServiceDefinition, forTenant } from '../../data/service-definition';
import { datasetsOf, withDatasets, withModel } from '../../data/service-form';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const variantList = (spec: Record<string, unknown>): unknown[] =>
  Array.isArray(spec.variants) && spec.variants.length ? spec.variants : ['default'];

const chosenVariant = (spec: Record<string, unknown>, variant: string | undefined) => {
  const list = variantList(spec);
  const index =
    variant === undefined
      ? 0
      : list.findIndex((v) => (typeof v === 'string' ? v : record(v).id) === variant);
  const found = index < 0 ? undefined : list[index];
  return { list, index, own: found && typeof found !== 'string' ? record(found) : undefined };
};

export const instructionsIn = (definition: Record<string, unknown>, variant?: string) => {
  const spec = record(definition.spec);
  const { own } = chosenVariant(spec, variant);
  const override = record(own?.overrides).instructions;
  if (typeof override === 'string') return override;
  const strategy = own?.strategy ? record(own.strategy) : record(spec.strategy);
  const text = record(strategy.config).instructions;
  return typeof text === 'string' ? text : '';
};

const withInstructionsIn = (
  definition: Record<string, unknown>,
  variant: string | undefined,
  text: string,
): Record<string, unknown> => {
  let spec = record(definition.spec);
  const { list, index, own } = chosenVariant(spec, variant);
  const replaced = (value: unknown) => {
    const ref = record(value);
    return { ...ref, config: { ...record(ref.config), instructions: text } };
  };
  if (own) {
    const overrides = record(own.overrides);
    const changed = {
      ...own,
      ...(own.strategy ? { strategy: replaced(own.strategy) } : {}),
      ...('instructions' in overrides ? { overrides: { ...overrides, instructions: text } } : {}),
    };
    spec = { ...spec, variants: list.map((v, i) => (i === index ? changed : v)) };
  }
  if (!own?.strategy) spec = { ...spec, strategy: replaced(spec.strategy) };
  return { ...definition, spec };
};

export const withPlaygroundChanges = (
  definition: Record<string, unknown>,
  setup: PlaygroundSetup,
  changes: SetupChange[],
): Record<string, unknown> => {
  const variant = setup.service?.variant;
  let current = definition;
  if (changes.some((c) => c.kind === 'instructions') && setup.instructions !== undefined)
    current = withInstructionsIn(current, variant, setup.instructions);
  let service = asServiceDefinition(current);
  if (changes.some((c) => c.kind === 'model')) {
    const spec = record(current.spec);
    const { list, index, own } = chosenVariant(spec, variant);
    service =
      own && typeof own.model === 'string'
        ? applySpec(service, {
            variants: list.map((v, i) =>
              i === index ? { ...own, model: setup.model } : v,
            ) as typeof service.spec.variants,
          })
        : applySpec(service, (d) => withModel(d.spec, setup.model, d.spec.model.residency));
  }
  const datasetChanges = changes.flatMap((c) => (c.kind === 'dataset' ? [c] : []));
  if (datasetChanges.length) {
    const off = new Set(datasetChanges.filter((c) => !c.on).map((c) => c.id));
    const kept = datasetsOf(service.spec).filter((d) => !off.has(d.dataset));
    const added = datasetChanges
      .filter((c) => c.on && !kept.some((d) => d.dataset === c.id))
      .map((c) => ({ dataset: c.id }));
    service = applySpec(service, (d) => withDatasets(d.spec, [...kept, ...added]));
  }
  return service as unknown as Record<string, unknown>;
};

export const draftSetupOf = (definition: Record<string, unknown>) => {
  const service = asServiceDefinition(definition);
  return {
    model: service.spec.model.primary,
    datasets: datasetsOf(service.spec).map((d) => d.dataset),
  };
};

export const startDefinition = async (
  api: ApiClient,
  tenant: string,
  ref: PlaygroundServiceRef,
  signal?: AbortSignal,
) => {
  if (ref.definition) return record(ref.definition);
  if (ref.version === 'draft') {
    const draft = await api.quality.draft(tenant, ref.id, signal);
    if (draft) return draft.definition;
    return (await api.getDefinition(tenant, 'Service', ref.id, signal)).latest.definition;
  }
  return (await api.getVersion(tenant, 'Service', ref.id, ref.version, signal)).definition;
};

export const baseKeyOf = (ref: PlaygroundServiceRef | undefined) =>
  ref ? `${ref.id}/${String(ref.version)}/${ref.variant ?? ''}` : '';

export const useBaseInstructions = (
  api: ApiClient | undefined,
  tenant: string | undefined,
  refs: (PlaygroundServiceRef | undefined)[],
) => {
  const [bases, setBases] = useState<Record<string, string>>({});
  const wanted = refs.filter((r): r is PlaygroundServiceRef => !!r);
  const keys = wanted.map(baseKeyOf).join('|');
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!api || !tenant) return;
    const controller = new AbortController();
    for (const ref of wanted) {
      const key = baseKeyOf(ref);
      if (key in bases) continue;
      startDefinition(api, tenant, { id: ref.id, version: ref.version }, controller.signal).then(
        (definition) =>
          !controller.signal.aborted &&
          setBases((b) => ({ ...b, [key]: instructionsIn(definition, ref.variant) })),
        () => undefined,
      );
    }
    return () => controller.abort();
  }, [api, tenant, keys, round]);
  const baseOf = (ref: PlaygroundServiceRef | undefined) =>
    ref ? bases[baseKeyOf(ref)] : undefined;
  const refresh = (service: string) => {
    setBases((b) =>
      Object.fromEntries(Object.entries(b).filter(([key]) => !key.startsWith(`${service}/`))),
    );
    setRound((n) => n + 1);
  };
  return { baseOf, refresh };
};

export const saveInDraft = async (
  api: ApiClient,
  tenant: string,
  setup: PlaygroundSetup,
  changes: SetupChange[],
  reason: string,
) => {
  const id = setup.service?.id;
  if (!id) throw new Error('the setup has no service');
  const [found, opened] = await Promise.all([
    api.getDefinition(tenant, 'Service', id),
    api.quality.openDraft(tenant, id, reason),
  ]);
  const current = opened ?? found.latest;
  const next = withPlaygroundChanges(current.definition, setup, changes);
  const stamped = forTenant(asServiceDefinition(next), {
    tenant,
    id,
    version: found.latest.version + 1,
  });
  return api.quality.saveDraft(
    tenant,
    id,
    {
      definition: stamped as unknown as Record<string, unknown>,
      files: current.files ?? {},
      revision: opened?.revision ?? 0,
    },
    reason,
  );
};

export const withSavedDrafts = (
  options: PlaygroundOptions,
  saved: Record<string, { model: string; datasets: string[] }>,
): PlaygroundOptions =>
  Object.keys(saved).length
    ? {
        ...options,
        services: options.services.map((service) => {
          const draft = saved[service.id];
          return draft
            ? {
                ...service,
                versions: service.versions.map((v) =>
                  v.draft ? { ...v, setup: { ...v.setup, ...draft } } : v,
                ),
              }
            : service;
        }),
      }
    : options;
