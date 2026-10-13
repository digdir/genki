import { checkFlowSettings, flowSettingsSchema, type PluginSchemas } from '@genai/definitions';
import type { ChatMessage, ChatResult, ModelPort, ToolCall, ToolSpec } from '@genai/port-model';
import { z } from 'zod';
import { applyPatch, dotted, PatchError } from './patch.js';
import {
  checkAfter,
  checkOps,
  isSensitiveKey,
  missingApprovalRight,
  secretsRule,
} from './policy.js';
import { guideFor, untrusted } from './prompt.js';
import { referenceFor } from './reference.js';
import type {
  AssistantProposal,
  AssistantQuestion,
  BuilderEvent,
  BuilderTurnInput,
  BuilderTurnResult,
  ConnectorSource,
  ConversationEntry,
  ImprovedInstructions,
  JsonPatchOp,
  PolicyRefusal,
  ProposalTest,
  RejectedChange,
  SuggestedTestCase,
} from './types.js';
import { errorKey, plainReasons, reasonFor, validateCoded } from './validation.js';

export const maxRetries = 2;
export const maxModelCalls = 6;
export const maxSampledDocuments = 20;
export const maxTestCases = 20;
export const maxHistoryEntries = 30;
export const maxHistoryChars = 4000;

export interface SampledDocument {
  source: string;
  text: string;
}

export interface TurnPorts {
  model: ModelPort;
  sample?(datasets: string[], query: string, limit: number): Promise<SampledDocument[]>;
}

export interface TurnOptions {
  input: BuilderTurnInput;
  plugins: PluginSchemas;
  ports: TurnPorts;
  newId?: () => string;
}

const patchOp = z.union([
  z.strictObject({
    op: z.enum(['add', 'replace', 'test']),
    path: z.string(),
    value: z.unknown(),
  }),
  z.strictObject({ op: z.literal('remove'), path: z.string() }),
  z.strictObject({ op: z.enum(['move', 'copy']), from: z.string(), path: z.string() }),
]);

const permission = z.strictObject({
  type: z.string().min(1),
  value: z.string().min(1),
  note: z.string().optional(),
});

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);

const connectorSource = z.strictObject({
  engine: z.literal('postgres'),
  host: z
    .string()
    .regex(/^[A-Za-z0-9.-]{1,253}$/)
    .optional(),
  database: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,63}$/)
    .optional(),
  schema: identifier.optional(),
  table: identifier,
  fields: z.strictObject({
    id: identifier,
    title: identifier,
    text: z.array(identifier).min(1).max(20),
    url: identifier.optional(),
    date: identifier.optional(),
    metadata: z.array(identifier).max(20).optional(),
  }),
  filter: z
    .array(
      z.strictObject({
        column: identifier,
        op: z.enum(['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null']),
        value: z
          .union([
            z.string().max(500),
            z.number(),
            z.boolean(),
            z
              .array(z.union([z.string().max(500), z.number()]))
              .min(1)
              .max(100),
          ])
          .optional(),
      }),
    )
    .max(20)
    .default([]),
});

const args = {
  list_building_blocks: z.object({
    kind: z.enum(['model', 'dataset', 'tool', 'skill', 'guardrail']).optional(),
  }),
  ask: z.object({
    questions: z
      .array(
        z.object({
          label: z.string().min(1),
          options: z.array(z.string().min(1)).min(1).max(8),
          allowOther: z.boolean().default(true),
        }),
      )
      .min(1)
      .max(5),
  }),
  propose_change: z.object({
    title: z.string().min(1),
    detail: z.string().default(''),
    section: z.string().optional(),
    patch: z.array(patchOp).min(1),
  }),
  propose_variant: z
    .object({
      title: z.string().min(1),
      detail: z.string().default(''),
      variant: z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
        title: z.object({ nb: z.string().trim().min(1), en: z.string().trim().min(1) }),
      }),
      recipe: z.string().min(1).optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
      flow: z.object({ purpose: z.string().min(1), steps: z.array(z.unknown()).min(1) }).optional(),
    })
    .refine((v) => (v.recipe === undefined) !== (v.flow === undefined), {
      message: 'give either recipe or flow',
    }),
  propose_connector: z.object({
    title: z.string().min(1),
    detail: z.string().default(''),
    mapping: z
      .array(
        z.strictObject({
          table: z.string().min(1),
          becomes: z.enum(['document', 'field', 'attachment', 'excluded']),
          fields: z.array(z.string().min(1)).optional(),
          reason: z.string().optional(),
        }),
      )
      .min(1),
    source: connectorSource.optional(),
    permissions: z.array(permission).default([]),
  }),
  propose_building_block: z.object({
    title: z.string().min(1),
    detail: z.string().default(''),
    endpoint: z.url().optional(),
    permissions: z.array(permission).default([]),
    quality: z.string().optional(),
  }),
  propose_platform_change: z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    detail: z.string().default(''),
  }),
  improve_instructions: z.object({
    after: z.string().min(1),
    changes: z.array(z.string().min(1)).min(1),
  }),
  suggest_test_cases: z.object({
    cases: z
      .array(
        z.object({
          input: z.string().min(1),
          expected: z.string().min(1),
          source: z.string().optional(),
        }),
      )
      .min(1),
  }),
};

type ToolName = 'read_draft' | keyof typeof args;

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string) => ({ type: 'string', description });
const permissionsSchema = {
  type: 'array',
  items: objectSchema(
    { type: str('network, data, model eller secret'), value: str('Hva'), note: str('Hvorfor') },
    ['type', 'value'],
  ),
};

const toolSpecs: Record<ToolName, ToolSpec> = {
  read_draft: {
    name: 'read_draft',
    description: 'Les utkastet slik det er nå.',
    parameters: objectSchema({}),
  },
  list_building_blocks: {
    name: 'list_building_blocks',
    description:
      'List byggeklossene virksomheten kan bruke: modeller, datasett, verktøy, ferdigheter og vern.',
    parameters: objectSchema({
      kind: { type: 'string', enum: ['model', 'dataset', 'tool', 'skill', 'guardrail'] },
    }),
  },
  ask: {
    name: 'ask',
    description: 'Still brukeren spørsmål med svaralternativer når du mangler opplysninger.',
    parameters: objectSchema(
      {
        questions: {
          type: 'array',
          items: objectSchema(
            {
              label: str('Spørsmålet'),
              options: { type: 'array', items: { type: 'string' } },
              allowOther: { type: 'boolean' },
            },
            ['label', 'options'],
          ),
        },
      },
      ['questions'],
    ),
  },
  propose_change: {
    name: 'propose_change',
    description:
      'Nivå 1: foreslå en endring i utkastet som JSON Patch (RFC 6902). Plattformen sjekker forslaget; det blir ikke brukt før brukeren godtar det.',
    parameters: objectSchema(
      {
        title: str('Kort tittel'),
        detail: str('Hva endringen gjør og hvorfor'),
        section: str('Delen av skjemaet som endres'),
        patch: {
          type: 'array',
          items: objectSchema(
            {
              op: str('add, remove, replace, move, copy eller test'),
              path: str('JSON Pointer'),
              from: str('JSON Pointer'),
              value: {},
            },
            ['op', 'path'],
          ),
        },
      },
      ['title', 'patch'],
    ),
  },
  propose_variant: {
    name: 'propose_variant',
    description:
      'Nivå 1: foreslå en ny variant av tjenesten med egen arbeidsmåte. Velg en oppskrift (recipe, med versjon slik den står i referansen) og fyll ut innstillingene (settings). Passer ingen oppskrift, gi en ny stegflyt (flow) med formål og steg i stedet. Plattformen sjekker forslaget; det blir ikke brukt før brukeren godtar det.',
    parameters: objectSchema(
      {
        title: str('Kort tittel, for eksempel Ny variant «Årsrapporter først»'),
        detail: str('Hva varianten gjør, med innstillingene i ord'),
        variant: objectSchema(
          {
            id: str('Id med små bokstaver, tall og bindestrek'),
            title: objectSchema({ nb: str('Navn på bokmål'), en: str('Navn på engelsk') }, [
              'nb',
              'en',
            ]),
          },
          ['id', 'title'],
        ),
        recipe: str('Oppskriften, for eksempel ordered-sources-answer@1'),
        settings: { type: 'object', description: 'Innstillingene oppskriften har' },
        flow: objectSchema(
          {
            purpose: str('Hva stegflyten gjør'),
            steps: { type: 'array', items: { type: 'object' } },
          },
          ['purpose', 'steps'],
        ),
      },
      ['title', 'variant'],
    ),
  },
  propose_connector: {
    name: 'propose_connector',
    description:
      'Nivå 2: foreslå en ny kobling med en deklarativ mapping fra tabeller til dokumenter og felt. Spør først hvilken database det er, hvor den ligger (vertsnavn og databasenavn), hvilken tabell og hvilke rader som skal med. Be aldri om brukernavn eller passord i samtalen; tilgangen fylles inn i et eget skjema når forslaget godkjennes. Oppgi kilden i source, og radutvalget som betingelser i source.filter (kolonne, operator, verdi), aldri som SQL. Koblingen leser bare.',
    parameters: objectSchema(
      {
        title: str('Kort tittel'),
        detail: str('Hva koblingen gjør'),
        mapping: {
          type: 'array',
          items: objectSchema(
            {
              table: str('Tabell'),
              becomes: { type: 'string', enum: ['document', 'field', 'attachment', 'excluded'] },
              fields: { type: 'array', items: { type: 'string' } },
              reason: str('Hvorfor tabellen tas med eller ikke'),
            },
            ['table', 'becomes'],
          ),
        },
        source: objectSchema(
          {
            engine: { type: 'string', enum: ['postgres'] },
            host: str('Vertsnavn, uten brukernavn og passord'),
            database: str('Databasenavn'),
            schema: str('Skjema, vanligvis public'),
            table: str('Tabellen som blir dokumenter'),
            fields: objectSchema(
              {
                id: str('Kolonnen med unik id'),
                title: str('Kolonnen som blir tittel'),
                text: { type: 'array', items: { type: 'string' }, description: 'Tekstkolonner' },
                url: str('Kolonne med lenke'),
                date: str('Kolonne med dato'),
                metadata: { type: 'array', items: { type: 'string' } },
              },
              ['id', 'title', 'text'],
            ),
            filter: {
              type: 'array',
              items: objectSchema(
                {
                  column: str('Kolonne'),
                  op: {
                    type: 'string',
                    enum: [
                      'eq',
                      'neq',
                      'in',
                      'not_in',
                      'gt',
                      'gte',
                      'lt',
                      'lte',
                      'is_null',
                      'not_null',
                    ],
                  },
                  value: {},
                },
                ['column', 'op'],
              ),
            },
          },
          ['engine', 'table', 'fields'],
        ),
        permissions: permissionsSchema,
      },
      ['title', 'mapping'],
    ),
  },
  propose_building_block: {
    name: 'propose_building_block',
    description:
      'Nivå 3: foreslå en ny byggekloss (MCP-server) som kjører isolert med bare tilgangene den ber om.',
    parameters: objectSchema(
      {
        title: str('Navn på byggeklossen'),
        detail: str('Hva den gjør'),
        endpoint: str('URL til MCP-serveren'),
        permissions: permissionsSchema,
        quality: str('Hvor godt den treffer, målt mot kjente svar'),
      },
      ['title', 'detail'],
    ),
  },
  propose_platform_change: {
    name: 'propose_platform_change',
    description:
      'Nivå 4: foreslå en endring i plattformen til Digdir når ingen lavere trinn løser behovet.',
    parameters: objectSchema(
      {
        title: str('Kort tittel'),
        summary: str('Sammendrag til Digdir'),
        detail: str('Mer om behovet'),
      },
      ['title', 'summary'],
    ),
  },
  improve_instructions: {
    name: 'improve_instructions',
    description:
      'Lever forbedrede instruksjoner: hele den nye teksten og en liste over hva som er endret.',
    parameters: objectSchema(
      { after: str('Hele den nye teksten'), changes: { type: 'array', items: { type: 'string' } } },
      ['after', 'changes'],
    ),
  },
  suggest_test_cases: {
    name: 'suggest_test_cases',
    description: 'Lever forslag til testtilfeller med inndata, forventet svar og kildedokument.',
    parameters: objectSchema(
      {
        cases: {
          type: 'array',
          items: objectSchema(
            { input: str('Inn'), expected: str('Forventet'), source: str('Kildedokument') },
            ['input', 'expected'],
          ),
        },
      },
      ['cases'],
    ),
  },
};

const toolsFor = (input: BuilderTurnInput): ToolSpec[] => {
  const names: ToolName[] = ['read_draft', 'list_building_blocks', 'ask', 'propose_change'];
  if (input.target === 'service')
    names.push(
      'propose_variant',
      'propose_connector',
      'propose_building_block',
      'propose_platform_change',
    );
  if (input.intent === 'improve-instructions') names.push('improve_instructions');
  if (input.intent === 'suggest-test-cases') names.push('suggest_test_cases');
  return names.map((n) => toolSpecs[n]);
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const instructionsOf = (input: BuilderTurnInput) => {
  const spec = record(input.draft.spec);
  const value =
    input.target === 'skill'
      ? spec.instructions
      : record(record(spec.strategy).config).instructions;
  return typeof value === 'string' ? value : '';
};

const purposeOf = (input: BuilderTurnInput) => {
  const spec = record(input.draft.spec);
  const value = input.target === 'skill' ? spec.description : spec.purpose;
  return typeof value === 'string' ? value : '';
};

const datasetsOf = (input: BuilderTurnInput) => {
  const allowed = new Set(
    input.context.available.filter((b) => b.kind === 'dataset').map((b) => b.id),
  );
  const listed = record(record(input.draft.spec).knowledge).datasets;
  return (Array.isArray(listed) ? listed : [])
    .map((d) => record(d).dataset)
    .filter((d): d is string => typeof d === 'string' && allowed.has(d));
};

const describeOp = (op: JsonPatchOp) => {
  const value = 'value' in op ? JSON.stringify(op.value) : '';
  const shown = value.length > 80 ? `${value.slice(0, 77)}...` : value;
  switch (op.op) {
    case 'remove':
      return `Fjern ${dotted(op.path)}`;
    case 'move':
      return `Flytt ${dotted(op.from)} til ${dotted(op.path)}`;
    case 'copy':
      return `Kopier ${dotted(op.from)} til ${dotted(op.path)}`;
    case 'test':
      return `Sjekk ${dotted(op.path)}`;
    default:
      return `Sett ${dotted(op.path)} til ${shown}`;
  }
};

const paragraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

const parseArgs = (call: ToolCall): unknown => {
  try {
    return JSON.parse(call.arguments || '{}');
  } catch {
    return undefined;
  }
};

const issues = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join('.') || '(argumenter)'}: ${i.message}`).join('; ');

const connectorTests = (
  mapping: z.infer<typeof args.propose_connector>['mapping'],
): ProposalTest[] => {
  const unexplained = mapping.filter((m) => m.becomes === 'excluded' && !m.reason?.trim());
  const empty = mapping.filter((m) => m.becomes === 'field' && !(m.fields?.length ?? 0));
  const documents = mapping.some((m) => m.becomes === 'document');
  return [
    {
      name: 'Minst én tabell blir dokumenter',
      passed: documents,
      ...(documents ? {} : { reason: 'Ingen tabell blir dokumenter.' }),
    },
    {
      name: 'Tabeller som ikke tas med har en begrunnelse',
      passed: unexplained.length === 0,
      ...(unexplained.length
        ? { reason: `Mangler begrunnelse: ${unexplained.map((m) => m.table).join(', ')}` }
        : {}),
    },
    {
      name: 'Felt er oppgitt for tabeller som blir felt',
      passed: empty.length === 0,
      ...(empty.length ? { reason: `Mangler felt: ${empty.map((m) => m.table).join(', ')}` } : {}),
    },
  ];
};

const hasSensitive = (value: unknown): boolean => {
  if (typeof value === 'string') return /^secret:/i.test(value.trim());
  if (Array.isArray(value)) return value.some(hasSensitive);
  if (value && typeof value === 'object')
    return Object.entries(value).some(
      ([k, v]) => (k !== 'type' && isSensitiveKey(k)) || hasSensitive(v),
    );
  return false;
};

export async function* runTurn(
  options: TurnOptions,
): AsyncGenerator<BuilderEvent, BuilderTurnResult> {
  const { input, plugins, ports } = options;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const owner = input.context.tenantName ?? 'virksomheten';
  const draft = structuredClone(input.draft);
  const baseline = new Set(validateCoded(draft, plugins).map(errorKey));

  const proposals: AssistantProposal[] = [];
  const rejected: RejectedChange[] = [];
  const questions: AssistantQuestion[] = [];
  const texts: string[] = [];
  let policy: PolicyRefusal | undefined;
  let improved: ImprovedInstructions | undefined;
  let testCases: SuggestedTestCase[] | undefined;
  let failures = 0;

  const sampled =
    input.intent === 'suggest-test-cases' && ports.sample
      ? await ports.sample(
          datasetsOf(input),
          purposeOf(input) || input.message,
          maxSampledDocuments,
        )
      : [];

  const answers = Object.entries(input.answers ?? {});
  const userText = [
    input.message,
    ...answers.map(([question, answer]) => `Svar på «${question}»: ${answer}`),
  ].join('\n');
  const history: ConversationEntry[] = (input.history ?? [])
    .slice(-maxHistoryEntries)
    .map((entry) => ({
      role: entry.role,
      content: entry.content.slice(0, maxHistoryChars),
    }));
  const userContent = [
    untrusted('draft', draft),
    ...(input.intent === 'suggest-test-cases'
      ? [
          sampled.length > 0
            ? untrusted('dataset-documents', sampled)
            : 'Det finnes ingen dokumenter å hente testtilfeller fra; bruk formålet.',
        ]
      : []),
    `Melding fra brukeren:\n${input.message}`,
    ...(answers.length > 0
      ? [
          `Svar på spørsmålene:\n${answers.map(([question, answer]) => `- ${question}: ${answer}`).join('\n')}`,
        ]
      : []),
  ].join('\n\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${input.systemPrompt}\n\n${guideFor(input.target, input.intent)}\n\n${referenceFor(input.target, draft, plugins, input.context)}`,
    },
    ...history,
    { role: 'user', content: userContent },
  ];
  const tools = toolsFor(input);

  const withApproval = (proposal: AssistantProposal): AssistantProposal => {
    const right = missingApprovalRight(proposal.level, input.context.rights);
    return right ? { ...proposal, approval: { right } } : proposal;
  };

  const approvalNote = (proposal: AssistantProposal) =>
    proposal.approval
      ? ` Brukeren kan ikke godkjenne det selv; det må godkjennes av noen med rettigheten ${proposal.approval.right}.`
      : '';

  const refuse = (refusal: PolicyRefusal) => {
    policy ??= refusal;
    return `Avvist av regel: ${refusal.rule} Kan endres av: ${refusal.ownedBy}.${refusal.alternative ? ` Alternativ: ${refusal.alternative}` : ''}`;
  };

  type Handled = { content: string; events: BuilderEvent[]; stop?: boolean };

  const retriesLeft = () => {
    const left = Math.max(0, maxRetries + 1 - failures);
    return left > 0
      ? `Du kan prøve igjen ${left} gang(er) til innenfor grensen.`
      : 'Ingen forsøk igjen; forklar brukeren hva som ikke gikk.';
  };

  const proposeChange = (raw: unknown, extra: Partial<AssistantProposal> = {}): Handled => {
    const parsed = args.propose_change.safeParse(raw);
    if (failures > maxRetries)
      return {
        content:
          'Grensen for nye forsøk i denne runden er nådd. Forklar brukeren hva som ikke gikk.',
        events: [],
      };
    if (!parsed.success) {
      failures += 1;
      const entry: RejectedChange = {
        attempted: 'Endring med ugyldig format',
        reason: reasonFor('PATCH_INVALID', '', issues(parsed.error)),
        code: 'PATCH_INVALID',
      };
      rejected.push(entry);
      return {
        content: `Avvist (PATCH_INVALID): ${entry.reason} ${retriesLeft()}`,
        events: [{ type: 'rejected', data: entry }],
      };
    }
    const { title, detail, section, patch } = parsed.data as {
      title: string;
      detail: string;
      section?: string;
      patch: JsonPatchOp[];
    };
    const attempted = `${title}: ${patch.map(describeOp).join('; ')}`;
    let after: Record<string, unknown>;
    try {
      const refusal = checkOps(patch, owner);
      if (refusal) return { content: refuse(refusal), events: [] };
      after = applyPatch(draft, patch);
    } catch (error) {
      failures += 1;
      const message = error instanceof PatchError ? error.message : String(error);
      const entry: RejectedChange = {
        attempted,
        reason: reasonFor('PATCH_INVALID', '', message),
        code: 'PATCH_INVALID',
      };
      rejected.push(entry);
      return {
        content: `Avvist (PATCH_INVALID): ${message}. ${retriesLeft()}`,
        events: [{ type: 'rejected', data: entry }],
      };
    }
    const afterRefusal = checkAfter(draft, after, input.context, owner);
    if (afterRefusal) return { content: refuse(afterRefusal), events: [] };
    const errors = validateCoded(after, plugins);
    const introduced = errors.filter((e) => !baseline.has(errorKey(e)));
    if (introduced.length > 0) {
      failures += 1;
      const first = introduced[0] ?? { path: '', message: '', code: 'VALIDATION_RULE' };
      const entry: RejectedChange = {
        attempted,
        reason: plainReasons(introduced, after),
        code: first.code,
      };
      rejected.push(entry);
      return {
        content: `Avvist av plattformen, ikke brukt (${first.code}): ${introduced
          .map((e) => `${e.path}: ${e.message}`)
          .join('; ')}. ${retriesLeft()}`,
        events: [{ type: 'rejected', data: entry }],
      };
    }
    const proposal: AssistantProposal = {
      id: newId(),
      level: 1,
      kind: 'change',
      title,
      detail,
      ...(section ? { section } : {}),
      patch,
      after,
      validation:
        errors.length === 0
          ? { ok: true }
          : { ok: false, errors: errors.map(({ path, message }) => ({ path, message })) },
      requiresApproval: false,
      appliedToDraft: false,
      ...extra,
    };
    const shown = withApproval(proposal);
    proposals.push(shown);
    return {
      content: `Forslaget er godkjent av plattformen og vist til brukeren som «${title}». Det er ikke brukt før brukeren godtar det.${approvalNote(shown)}`,
      events: [{ type: 'proposal', data: shown }],
    };
  };

  const refused = (attempted: string, code: string, reason: string): Handled => {
    failures += 1;
    const entry: RejectedChange = { attempted, reason, code };
    rejected.push(entry);
    return {
      content: `Avvist av plattformen, ikke brukt (${code}): ${reason} ${retriesLeft()}`,
      events: [{ type: 'rejected', data: entry }],
    };
  };

  const proposeVariant = (raw: unknown): Handled => {
    if (failures > maxRetries)
      return {
        content:
          'Grensen for nye forsøk i denne runden er nådd. Forklar brukeren hva som ikke gikk.',
        events: [],
      };
    const parsed = args.propose_variant.safeParse(raw);
    if (!parsed.success)
      return refused(
        'Variant med ugyldig format',
        'PATCH_INVALID',
        reasonFor('PATCH_INVALID', '', issues(parsed.error)),
      );
    const { title, detail, variant, recipe, settings, flow } = parsed.data;
    const attempted = `${title}: ny variant ${variant.id}`;
    const spec = record(draft.spec);
    const service = String(record(draft.metadata).id ?? 'tjeneste');
    let config: Record<string, unknown>;
    let flows: Record<string, unknown>[] = [];
    if (recipe !== undefined) {
      const found = (input.context.recipes ?? []).find(
        (r) => r.ref === recipe || r.ref.replace(/@\d+$/, '') === recipe,
      );
      if (!found)
        return refused(
          attempted,
          'VALIDATION_UNKNOWN_REFERENCE',
          `Oppskriften ${recipe} finnes ikke for virksomheten. Oppskrifter: ${(input.context.recipes ?? []).map((r) => r.ref).join(', ') || 'ingen'}.`,
        );
      const schema = flowSettingsSchema.safeParse(found.settings);
      const problems = checkFlowSettings(schema.success ? schema.data : undefined, settings ?? {});
      if (problems.length > 0)
        return refused(
          attempted,
          'VALIDATION_RULE',
          `Innstillingene passer ikke oppskriften ${found.ref}: ${problems.map((p) => p.message).join('; ')}.`,
        );
      config = { flow: found.ref, settings: settings ?? {} };
    } else {
      const id = `${service}-${variant.id}`.slice(0, 63);
      const definition = {
        apiVersion: 'genai/v1',
        kind: 'StepFlow',
        metadata: { tenant: input.tenant, id, name: variant.title.nb },
        spec: { purpose: flow?.purpose, steps: flow?.steps },
      };
      const errors = validateCoded(definition, plugins);
      if (errors.length > 0)
        return refused(
          attempted,
          errors[0]?.code ?? 'VALIDATION_RULE',
          `Stegflyten er ikke gyldig: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}.`,
        );
      config = { flow: `${id}@1` };
      flows = [definition];
    }
    const entry = {
      id: variant.id,
      title: variant.title,
      strategy: { id: 'step-flow', version: 1, config },
    };
    const patch: JsonPatchOp[] = Array.isArray(spec.variants)
      ? [{ op: 'add', path: '/spec/variants/-', value: entry }]
      : [{ op: 'add', path: '/spec/variants', value: ['default', entry] }];
    return proposeChange(
      { title, detail, section: 'variants', patch },
      flows.length > 0 ? { flows } : {},
    );
  };

  const stored = (proposal: AssistantProposal): Handled => {
    if (hasSensitive(proposal)) return { content: refuse(secretsRule), events: [] };
    const shown = withApproval(proposal);
    proposals.push(shown);
    return {
      content: `Forslaget «${proposal.title}» er vist til brukeren og må godkjennes før noe blir aktivt.${approvalNote(shown)}`,
      events: [{ type: 'proposal', data: shown }],
    };
  };

  const handle = (call: ToolCall): Handled => {
    const raw = parseArgs(call);
    const name = call.name as ToolName;
    if (!tools.some((t) => t.name === name))
      return { content: `Verktøyet ${call.name} finnes ikke.`, events: [] };
    if (raw === undefined) return { content: 'Argumentene er ikke gyldig JSON.', events: [] };
    switch (name) {
      case 'read_draft':
        return { content: untrusted('draft', draft), events: [] };
      case 'list_building_blocks': {
        const parsed = args.list_building_blocks.safeParse(raw);
        const kind = parsed.success ? parsed.data.kind : undefined;
        return {
          content: untrusted(
            'building-blocks',
            input.context.available.filter((b) => !kind || b.kind === kind),
          ),
          events: [],
        };
      }
      case 'ask': {
        const parsed = args.ask.safeParse(raw);
        if (!parsed.success)
          return { content: `Ugyldige spørsmål: ${issues(parsed.error)}`, events: [] };
        const events: BuilderEvent[] = [];
        for (const q of parsed.data.questions) {
          const question: AssistantQuestion = {
            id: `q${questions.length + 1}`,
            label: q.label,
            options: q.options,
            allowOther: q.allowOther,
          };
          questions.push(question);
          events.push({ type: 'question', data: question });
        }
        return {
          content: 'Spørsmålene er vist til brukeren. Avslutt nå og vent på svarene.',
          events,
          stop: true,
        };
      }
      case 'propose_change':
        return proposeChange(raw);
      case 'propose_variant':
        return proposeVariant(raw);
      case 'propose_connector': {
        const parsed = args.propose_connector.safeParse(raw);
        if (!parsed.success)
          return { content: `Ugyldig forslag: ${issues(parsed.error)}`, events: [] };
        const { title, detail, mapping, source, permissions } = parsed.data;
        return stored({
          id: newId(),
          level: 2,
          kind: 'connector',
          title,
          detail,
          validation: { ok: true },
          requiresApproval: true,
          appliedToDraft: false,
          mapping: mapping.map((m) => ({
            table: m.table,
            becomes: m.becomes,
            ...(m.fields ? { fields: m.fields } : {}),
            ...(m.reason ? { reason: m.reason } : {}),
          })),
          permissions: permissions.map((p) => ({
            type: p.type,
            value: p.value,
            ...(p.note ? { note: p.note } : {}),
          })),
          ...(source ? { source: source as ConnectorSource } : {}),
          tests: connectorTests(mapping),
        });
      }
      case 'propose_building_block': {
        const parsed = args.propose_building_block.safeParse(raw);
        if (!parsed.success)
          return { content: `Ugyldig forslag: ${issues(parsed.error)}`, events: [] };
        const { title, detail, endpoint, permissions, quality } = parsed.data;
        const network =
          endpoint && !permissions.some((p) => p.type === 'network' && p.value === endpoint);
        return stored({
          id: newId(),
          level: 3,
          kind: 'building_block',
          title,
          detail,
          validation: { ok: true },
          requiresApproval: true,
          appliedToDraft: false,
          permissions: [
            ...(network ? [{ type: 'network', value: endpoint, note: 'MCP-server' }] : []),
            ...permissions.map((p) => ({
              type: p.type,
              value: p.value,
              ...(p.note ? { note: p.note } : {}),
            })),
          ],
          tests: [],
          ...(quality ? { quality } : {}),
        });
      }
      case 'propose_platform_change': {
        const parsed = args.propose_platform_change.safeParse(raw);
        if (!parsed.success)
          return { content: `Ugyldig forslag: ${issues(parsed.error)}`, events: [] };
        const { title, summary, detail } = parsed.data;
        return stored({
          id: newId(),
          level: 4,
          kind: 'platform_change',
          title,
          detail,
          validation: { ok: true },
          requiresApproval: true,
          appliedToDraft: false,
          platformChange: { summary, caseId: '', status: 'sent' },
        });
      }
      case 'improve_instructions': {
        const parsed = args.improve_instructions.safeParse(raw);
        if (!parsed.success)
          return { content: `Ugyldig forslag: ${issues(parsed.error)}`, events: [] };
        improved = {
          before: instructionsOf(input),
          after: parsed.data.after,
          changes: parsed.data.changes,
        };
        return { content: 'Forslaget til nye instruksjoner er vist til brukeren.', events: [] };
      }
      case 'suggest_test_cases': {
        const parsed = args.suggest_test_cases.safeParse(raw);
        if (!parsed.success)
          return { content: `Ugyldige testtilfeller: ${issues(parsed.error)}`, events: [] };
        const sources = new Set(sampled.map((d) => d.source));
        testCases = [...(testCases ?? []), ...parsed.data.cases]
          .slice(0, maxTestCases)
          .map((c, i) => ({
            id: `tc${i + 1}`,
            input: c.input,
            expected: c.expected,
            ...(c.source && sources.has(c.source) ? { source: c.source } : {}),
          }));
        return { content: `${testCases.length} testtilfeller er vist til brukeren.`, events: [] };
      }
    }
  };

  for (let call = 0; call < maxModelCalls; call += 1) {
    const request = { messages, tools };
    let result: ChatResult | undefined;
    let pending = '';
    if (input.stream && ports.model.info().capabilities.includes('stream')) {
      for await (const chunk of ports.model.chatStream(request)) {
        if (chunk.kind === 'done') {
          result = chunk.result;
          break;
        }
        yield { type: 'delta', data: { text: chunk.text } };
        pending += chunk.text;
        const split = pending.split(/\n\s*\n/);
        pending = split.pop() ?? '';
        for (const text of split.map((p) => p.trim()).filter(Boolean))
          yield { type: 'paragraph', data: { text } };
      }
      if (!result) throw new Error('the model stream ended without a result');
      for (const text of paragraphs(pending)) yield { type: 'paragraph', data: { text } };
    } else {
      result = await ports.model.chat(request);
      for (const text of paragraphs(result.content)) yield { type: 'paragraph', data: { text } };
    }
    if (result.content.trim()) texts.push(result.content.trim());
    if (result.toolCalls.length === 0) break;
    messages.push({
      role: 'assistant',
      content: result.content,
      toolCalls: result.toolCalls,
      ...(result.continuation === undefined ? {} : { continuation: result.continuation }),
    });
    let stop = false;
    for (const toolCall of result.toolCalls) {
      const handled = handle(toolCall);
      for (const event of handled.events) yield event;
      messages.push({ role: 'tool', toolCallId: toolCall.id, content: handled.content });
      stop ||= handled.stop === true;
    }
    if (stop) break;
  }

  if (proposals.length === 0 && rejected.length > 0)
    texts.push('Plattformen avviste forslaget, så ingenting er foreslått for utkastet ennå.');
  const message = texts.join('\n\n');
  const entries: ConversationEntry[] = [
    ...history,
    { role: 'user', content: userText },
    {
      role: 'assistant',
      content: [
        message,
        ...questions.map((q) => `Spurte: «${q.label}» (valg: ${q.options.join(', ')})`),
        ...proposals.map((p) => `Viste forslaget «${p.title}». Brukeren har ikke svart ennå.`),
        ...rejected.map((r) => `Avvist av plattformen: ${r.attempted}. ${r.reason}`),
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
  const transcript = entries.slice(-maxHistoryEntries);

  return {
    status: 'completed',
    message,
    proposals,
    transcript,
    ...(questions.length > 0 ? { questions } : {}),
    ...(rejected.length > 0 ? { rejected } : {}),
    ...(policy ? { policy } : {}),
    ...(improved ? { improvedInstructions: improved } : {}),
    ...(testCases ? { testCases } : {}),
  };
}
