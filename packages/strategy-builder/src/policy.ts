import { pointerSegments, sameJson } from './patch.js';
import type {
  AssistantProposal,
  AvailableBlock,
  BlockKind,
  BuilderContext,
  JsonPatchOp,
  PolicyRefusal,
  Residency,
} from './types.js';

const sensitiveExact = new Set([
  'auth',
  'authorization',
  'token',
  'tokens',
  'connection',
  'connections',
  'endpoint',
  'endpoints',
  'baseurl',
  'url',
  'headers',
  'header',
  'cookie',
  'cookies',
]);
const sensitivePart = ['secret', 'password', 'passord', 'apikey', 'credential', 'privatekey'];

export const isSensitiveKey = (key: string) => {
  const normal = key.toLowerCase().replace(/[-_\s]/g, '');
  return sensitiveExact.has(normal) || sensitivePart.some((p) => normal.includes(p));
};

const sensitiveValue = (value: unknown): boolean => {
  if (typeof value === 'string') return /^secret:/i.test(value.trim());
  if (Array.isArray(value)) return value.some(sensitiveValue);
  if (value && typeof value === 'object')
    return Object.entries(value).some(([k, v]) => isSensitiveKey(k) || sensitiveValue(v));
  return false;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export const secretsRule: PolicyRefusal = {
  code: 'secrets',
  rule: 'Byggeassistenten kan ikke endre hemmeligheter, innlogging eller tilkoblinger.',
  ownedBy: 'Digdir',
  alternative: 'Legg inn tilkoblingen selv under Byggeklosser, eller be om en ny kobling.',
};

const ownerTitle = (owner: string) => owner.charAt(0).toUpperCase() + owner.slice(1);

export const riskRule = (owner: string): PolicyRefusal => ({
  code: 'risk',
  rule: 'Assistenten kan foreslå risikonivå, men bare en person kan bekrefte det.',
  ownedBy: ownerTitle(owner),
  alternative: 'Bekreft risikonivået selv med «Bekreft risikonivå».',
});

export const riskClassRule = (owner: string): PolicyRefusal => ({
  code: 'risk-class',
  rule: 'Assistenten kan ikke endre risikonivået. En person setter og bekrefter det.',
  ownedBy: ownerTitle(owner),
  alternative:
    'Sett risikonivået selv i risikovurderingen, og bekreft det med «Bekreft risikonivå».',
});

export const identityRule: PolicyRefusal = {
  code: 'identity',
  rule: 'Organisasjonen og ID-en til utkastet kan ikke endres.',
  ownedBy: 'Digdir',
  alternative: 'Lag en ny tjeneste hvis du trenger en annen ID.',
};

const pathsOf = (op: JsonPatchOp) => ('from' in op ? [op.path, op.from] : [op.path]);

const under = (segments: string[], prefix: string[]) =>
  segments.length >= prefix.length && prefix.every((p, i) => p === segments[i]);

export const checkOps = (ops: JsonPatchOp[], owner: string): PolicyRefusal | undefined => {
  for (const op of ops) {
    if (op.op === 'test') continue;
    for (const path of pathsOf(op)) {
      const segments = pointerSegments(path);
      if (segments.some(isSensitiveKey)) return secretsRule;
      if (under(segments, ['spec', 'riskConfirmation'])) return riskRule(owner);
      if (under(segments, ['spec', 'riskClass'])) return riskClassRule(owner);
      if (under(segments, ['metadata', 'tenant']) || under(segments, ['metadata', 'id']))
        return identityRule;
    }
    if ('value' in op && sensitiveValue(op.value)) return secretsRule;
  }
  return undefined;
};

const modelsOf = (spec: Record<string, unknown>) => {
  const model = record(spec.model);
  return [model.primary, model.fallback, ...Object.values(record(model.roles))].filter(
    (m): m is string => typeof m === 'string',
  );
};

const toolsOf = (spec: Record<string, unknown>) =>
  (Array.isArray(spec.tools) ? spec.tools : []).flatMap((t) => {
    const ref = typeof t === 'string' ? t : text(record(t).use);
    return ref ? [ref] : [];
  });

const datasetsOf = (spec: Record<string, unknown>) =>
  (Array.isArray(record(spec.knowledge).datasets)
    ? (record(spec.knowledge).datasets as unknown[])
    : []
  ).flatMap((d) => {
    const id = text(record(d).dataset);
    return id ? [id] : [];
  });

const skillsOf = (spec: Record<string, unknown>) =>
  (Array.isArray(spec.skills) ? spec.skills : []).filter((s): s is string => typeof s === 'string');

const guardrailsOf = (spec: Record<string, unknown>) => Object.keys(record(spec.guardrails));

export const usedBlocks = (definition: Record<string, unknown>): [BlockKind, string][] => {
  const spec = record(definition.spec);
  return [
    ...modelsOf(spec).map((id): [BlockKind, string] => ['model', id]),
    ...toolsOf(spec).map((id): [BlockKind, string] => ['tool', id]),
    ...datasetsOf(spec).map((id): [BlockKind, string] => ['dataset', id]),
    ...skillsOf(spec).map((id): [BlockKind, string] => ['skill', id]),
    ...guardrailsOf(spec).map((id): [BlockKind, string] => ['guardrail', id]),
  ];
};

const kindNames: Record<BlockKind, string> = {
  model: 'Modellen',
  tool: 'Verktøyet',
  dataset: 'Datasettet',
  skill: 'Ferdigheten',
  guardrail: 'Vernet',
};

const alternativeFor = (kind: BlockKind, available: AvailableBlock[]) => {
  const same = available.filter((b) => b.kind === kind).slice(0, 3);
  return same.length > 0
    ? `Bruk ${same.map((b) => `«${b.name}»`).join(', ')} i stedet.`
    : 'Ta byggeklossen i bruk under Byggeklosser først.';
};

const blockRefusal = (
  kind: BlockKind,
  id: string,
  context: BuilderContext,
  owner: string,
): PolicyRefusal | undefined => {
  if (context.available.some((b) => b.kind === kind && b.id === id)) return undefined;
  const refused = context.refused.find((b) => b.kind === kind && b.id === id);
  if (refused)
    return {
      code: 'block',
      rule: refused.rule,
      ownedBy: refused.ownedBy,
      ...(refused.link ? { link: refused.link } : {}),
      alternative: alternativeFor(kind, context.available),
    };
  return {
    code: 'block',
    rule: `${kindNames[kind]} «${id}» er ikke tatt i bruk hos ${owner}.`,
    ownedBy: ownerTitle(owner),
    link: '#/building-blocks',
    alternative: alternativeFor(kind, context.available),
  };
};

export const checkAfter = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  context: BuilderContext,
  owner: string,
): PolicyRefusal | undefined => {
  const was = record(before.metadata);
  const now = record(after.metadata);
  if (was.tenant !== now.tenant || was.id !== now.id) return identityRule;
  if (!sameJson(record(before.spec).riskConfirmation, record(after.spec).riskConfirmation))
    return riskRule(owner);
  if (!sameJson(record(before.spec).riskClass, record(after.spec).riskClass))
    return riskClassRule(owner);
  const existing = new Set(usedBlocks(before).map(([k, id]) => `${k}:${id}`));
  for (const [kind, id] of usedBlocks(after)) {
    if (existing.has(`${kind}:${id}`)) continue;
    const refusal = blockRefusal(kind, id, context, owner);
    if (refusal) return refusal;
  }
  const residency = text(record(record(after.spec).model).residency) as Residency | undefined;
  const previous = text(record(record(before.spec).model).residency);
  if (residency && residency !== previous) {
    const blocked = context.blockedResidencies.find((b) => b.residency === residency);
    if (blocked)
      return {
        code: 'residency',
        rule: blocked.rule,
        ownedBy: blocked.ownedBy,
        ...(blocked.link ? { link: blocked.link } : {}),
        alternative: 'Velg en modell som behandler data i Norge eller i EU/EØS.',
      };
  }
  return undefined;
};

export const rightsToApprove: Readonly<Record<AssistantProposal['level'], readonly string[]>> = {
  1: ['manage-services'],
  2: ['manage-services', 'manage-datasets'],
  3: ['manage-services', 'register-building-blocks'],
  4: [],
};

export const missingApprovalRight = (
  level: AssistantProposal['level'],
  rights: readonly string[] | undefined,
) => (rights ? rightsToApprove[level].find((right) => !rights.includes(right)) : undefined);
