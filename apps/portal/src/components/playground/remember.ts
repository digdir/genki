import type { PlaygroundOptions, PlaygroundSetup } from '../../api/playground';

export interface RememberedSetups {
  a: PlaygroundSetup;
  b?: PlaygroundSetup;
}

export const rememberKey = (tenant: string | undefined, context: string, name?: string) =>
  `genai.playground.setup:${tenant ?? 'eksempel'}:${context}:${name ?? ''}`;

const isSetup = (value: unknown): value is PlaygroundSetup => {
  const v = value as Partial<PlaygroundSetup> | null;
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.model === 'string' &&
    Array.isArray(v.datasets) &&
    Array.isArray(v.skills) &&
    Array.isArray(v.blocks) &&
    (v.output === 'text' || v.output === 'fields')
  );
};

export const validSetup = (
  options: PlaygroundOptions,
  setup: PlaygroundSetup,
  draftService?: string,
) => {
  if (!options.models.some((m) => m.id === setup.model && m.status === 'allowed')) return false;
  if (!setup.datasets.every((d) => options.datasets.some((o) => o.id === d))) return false;
  if (!setup.skills.every((k) => options.skills.some((o) => o.id === k || o.ref === k)))
    return false;
  const service = setup.service;
  const version = service
    ? options.services
        .find((s) => s.id === service.id)
        ?.versions.find((v) =>
          service.version === 'draft' ? v.draft : v.version === service.version,
        )
    : undefined;
  if (service && service.version === 'draft' && service.id !== draftService && !version)
    return false;
  if (service && service.version !== 'draft' && !version) return false;
  return setup.blocks.every(
    (b) =>
      options.blocks.some((o) => o.id === b) ||
      (options.defaultBlocks ?? []).includes(b) ||
      (version?.setup.blocks ?? []).includes(b),
  );
};

const withoutDefinition = (setup: PlaygroundSetup): PlaygroundSetup =>
  setup.service
    ? { ...setup, service: { id: setup.service.id, version: setup.service.version } }
    : setup;

export const loadSetups = (
  key: string,
  options: PlaygroundOptions,
  draftService?: string,
): RememberedSetups | undefined => {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<RememberedSetups>;
    if (!stored || !isSetup(stored.a) || !validSetup(options, stored.a, draftService))
      return undefined;
    const b =
      isSetup(stored.b) && validSetup(options, stored.b, draftService) ? stored.b : undefined;
    return { a: stored.a, ...(b ? { b } : {}) };
  } catch {
    return undefined;
  }
};

export const saveSetups = (key: string, setups: RememberedSetups) => {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        a: withoutDefinition(setups.a),
        ...(setups.b ? { b: withoutDefinition(setups.b) } : {}),
      }),
    );
  } catch {
    return;
  }
};
