import { textPart, type Input, type Part, type ServiceProvenance } from '@genai/contracts';
import type { Emitted, Feature, InvocationContext, Strategy } from '@genai/kernel';
import type { ModelPort } from '@genai/port-model';
import {
  assembleLanguage,
  chooseLanguage,
  defaultHouseStyle,
  serviceLanguagesOf,
  textHash,
  writesText,
  type AnswerLanguageProvenance,
  type HouseStyle,
} from './answer-language.js';
import {
  answerLanguage,
  detectLanguage,
  languageName,
  type Language,
  type WrittenStandard,
} from './language.js';
import { guardModel } from './model.js';
import { createVault, findPii, redactPii, type PiiVault } from './pii.js';
import {
  applyRules,
  appliesTo,
  inlineRule,
  type CustomRule,
  type RuleRuntime,
  type RuleVerdict,
} from './rules.js';
import { defaultMessages, inLanguage, parseGuardrails, type Guardrails } from './schemas.js';

export const PROVENANCE_MIME = 'application/vnd.genai.provenance+json';
export const SOURCES_MIME = 'application/vnd.genai.sources+json';
export const defaultDisclosure = defaultMessages.disclosure;

const checkpointKind = 'guardrails.human-approval';

export interface GuardInfo {
  service?: ServiceProvenance;
  aiDisclosure?: string;
}

export interface CustomRuleHooks {
  resolve(ctx: InvocationContext, entries: unknown[]): Promise<CustomRule[]>;
  external?(
    ctx: InvocationContext,
    rule: Extract<CustomRule, { kind: 'mcp-check' }>,
    text: string,
  ): Promise<RuleVerdict>;
}

export interface GuardStrategyOptions {
  describe?: (ctx: InvocationContext) => Promise<GuardInfo | undefined>;
  rules?: CustomRuleHooks;
  writtenStandard?: (
    ctx: InvocationContext,
    input: Input,
    config: unknown,
  ) => WrittenStandard | undefined | Promise<WrittenStandard | undefined>;
  answerLanguage?: (
    ctx: InvocationContext,
    input: Input,
    config: unknown,
    question: string,
  ) => Language | undefined | Promise<Language | undefined>;
  houseStyle?: (
    ctx: InvocationContext,
    input: Input,
    config: unknown,
    language: Language,
  ) => HouseStyle | undefined | Promise<HouseStyle | undefined>;
}

export interface Provenance {
  task: string;
  service?: ServiceProvenance;
  models: string[];
  sources: string[];
  approved?: boolean;
  approver?: string;
  aiDisclosure: string;
  language?: AnswerLanguageProvenance;
}

interface Held {
  kind: typeof checkpointKind;
  parts: Part[];
  answer: string;
  provenance: Provenance;
  language?: Language;
}

interface RuntimeConfig {
  guardrails?: unknown;
  model?: { primary?: string; tenant?: string };
}

const questionOf = (input: Input) => {
  const data = (input.data ?? {}) as { query?: unknown };
  if (typeof data.query === 'string' && data.query.trim()) return data.query;
  return (input.parts ?? [])
    .flatMap((p) => (p.body.kind === 'text' ? [p.body.text] : []))
    .join('\n');
};

const answerIndex = (parts: Part[]) =>
  parts.findIndex((p) => p.mime.startsWith('text/') && p.body.kind === 'text');

const answerText = (parts: Part[]) => {
  const part = parts[answerIndex(parts)];
  return part?.body.kind === 'text' ? part.body.text : undefined;
};

const sourcesOf = (parts: Part[]) => {
  const part = parts.find((p) => p.mime === SOURCES_MIME && p.body.kind === 'json');
  const json = (part?.body.kind === 'json' ? part.body.json : undefined) as
    { sources?: Record<string, unknown>[] } | undefined;
  return json?.sources ?? [];
};

const sourceId = (s: Record<string, unknown>) => {
  const nested = s.source as { id?: unknown } | undefined;
  const id = s.chunkId ?? s.chunk_id ?? s.id ?? nested?.id;
  return typeof id === 'string' ? id : undefined;
};

const hasValidCitation = (parts: Part[]) => {
  const sources = sourcesOf(parts);
  const text = answerText(parts);
  if (text === undefined) return sources.length > 0;
  const part = parts[answerIndex(parts)];
  const cited = (part?.meta?.citations as unknown[] | undefined) ?? [];
  if (cited.length > 0 && sources.length > 0) return true;
  return [...text.matchAll(/\[(\d+)\]/g)].some((m) => {
    const n = Number(m[1]);
    return n >= 1 && n <= sources.length;
  });
};

const withAnswer = (parts: Part[], text: string): Part[] => {
  const i = answerIndex(parts);
  if (i < 0) return [textPart(text), ...parts];
  return parts.map((p, j) => (j === i ? { ...p, body: { kind: 'text', text } } : p));
};

const disclosed = (parts: Part[], disclosure: string): Part[] =>
  parts.map((p) =>
    p.mime.startsWith('text/') ? { ...p, meta: { ...p.meta, aiDisclosure: disclosure } } : p,
  );

const provenancePart = (provenance: Provenance): Part => ({
  mime: PROVENANCE_MIME,
  body: { kind: 'json', json: provenance },
});

const finalParts = (parts: Part[], provenance: Provenance): Part[] => [
  ...disclosed(
    parts.filter((p) => p.mime !== PROVENANCE_MIME),
    provenance.aiDisclosure,
  ),
  provenancePart(provenance),
];

const passesThroughUnchanged = new Set(['kernel.part']);

export const guardStrategy = <C>(
  inner: Strategy<C>,
  options: GuardStrategyOptions = {},
): Strategy<C> => {
  const features = [...new Set<Feature>([...inner.requires.features, 'interrupts', 'checkpoint'])];
  const ports = [...new Set([...inner.requires.ports, 'model'])];

  const setup = async (ctx: InvocationContext, config: C) => {
    const runtime = config as RuntimeConfig;
    const guardrails = parseGuardrails(runtime.guardrails);
    const info = (await options.describe?.(ctx)) ?? {
      service: ctx.service,
      aiDisclosure: ctx.capability.oversight.aiDisclosure,
    };
    const served = new Set<string>();
    const pii = guardrails.piiBeforeModel;
    const vault: PiiVault | undefined = pii ? createVault(pii.categories) : undefined;
    const provenance = (parts: Part[], extra: Partial<Provenance> = {}): Provenance => ({
      task: ctx.task,
      ...(info.service ? { service: info.service } : {}),
      models: [...served],
      sources: sourcesOf(parts).flatMap((s) => sourceId(s) ?? []),
      aiDisclosure: info.aiDisclosure ?? defaultDisclosure,
      ...extra,
    });
    const guarded = (instruction?: string): InvocationContext => ({
      ...ctx,
      use: async <P>(port: string, ref: Parameters<InvocationContext['use']>[1]) => {
        const opened = await ctx.use<P>(port, ref);
        if (port !== 'model') return opened;
        return guardModel(opened as ModelPort, {
          ...(vault ? { vault, restore: pii?.restore ?? true } : {}),
          ...(instruction ? { instruction } : {}),
          onServed: (model) => served.add(model),
        }) as P;
      },
    });
    const primaryModel = async (scoped: InvocationContext) => {
      const id = runtime.model?.primary;
      if (!id) throw new Error('the service has no model for its guardrails');
      return scoped.use<ModelPort>('model', {
        kind: 'model',
        id,
        ...(runtime.model?.tenant ? { tenant: runtime.model.tenant } : {}),
      });
    };
    const entries = guardrails.customRules ?? [];
    const rules: CustomRule[] = options.rules
      ? await options.rules.resolve(ctx, entries)
      : entries.flatMap((e) => inlineRule(e) ?? []);
    return { guardrails, provenance, guarded, primaryModel, rules };
  };

  const ruleRuntime = (ctx: InvocationContext, model: () => Promise<ModelPort>): RuleRuntime => ({
    judge: async (rule, text) => {
      const result = await (
        await model()
      ).chat({
        messages: [
          {
            role: 'system',
            content: `${rule.prompt}\n\nSvar med verdict "allow" hvis teksten er i orden, ellers "block".`,
          },
          { role: 'user', content: text },
        ],
        jsonSchema: {
          name: 'verdict',
          schema: {
            type: 'object',
            properties: {
              verdict: { type: 'string', enum: ['allow', 'block'] },
              reason: { type: 'string' },
            },
            required: ['verdict'],
            additionalProperties: false,
          },
        },
        temperature: 0,
      });
      const verdict = (JSON.parse(result.content) as { verdict?: unknown }).verdict;
      if (verdict !== 'allow' && verdict !== 'block') throw new Error('no verdict');
      return { allow: verdict === 'allow' };
    },
    external: async (rule, text) => {
      if (!options.rules?.external) throw new Error('external checks are not configured');
      return options.rules.external(ctx, rule, text);
    },
  });

  const ruleEvent = (rule: string, stage: 'input' | 'output', outcome: string): Emitted => ({
    type: 'x.guardrails.rule',
    audience: 'audit',
    data: { rule, stage, outcome },
  });

  const refusal = (message: string, provenance: Provenance): Emitted[] => [
    { type: 'kernel.part.delta', data: { text: message } },
    { type: 'kernel.result', data: finalParts([textPart(message)], provenance) },
  ];

  const offTopic = async (
    guardrails: Guardrails,
    question: string,
    model: () => Promise<ModelPort>,
  ): Promise<boolean> => {
    const rule = guardrails.refuseTopics;
    if (!rule) return false;
    try {
      const result = await (
        await model()
      ).chat({
        messages: [
          {
            role: 'system',
            content:
              'Du klassifiserer spørsmål. Svar med emnet fra listen som spørsmålet handler om, eller "none" hvis det ikke handler om noen av dem.',
          },
          { role: 'user', content: JSON.stringify({ question, topics: rule.topics }) },
        ],
        jsonSchema: {
          name: 'topic',
          schema: {
            type: 'object',
            properties: { topic: { type: 'string', enum: [...rule.topics, 'none'] } },
            required: ['topic'],
            additionalProperties: false,
          },
        },
        temperature: 0,
      });
      const topic = (JSON.parse(result.content) as { topic?: unknown }).topic;
      return typeof topic === 'string' && topic !== 'none';
    } catch {
      return rule.onError === 'refuse';
    }
  };

  const rewrite = async (text: string, target: Language, model: ModelPort) => {
    const result = await model.chat({
      messages: [
        {
          role: 'system',
          content: `Skriv om teksten til ${languageName[target]}. Behold innholdet, tallene og kildehenvisninger som [1] nøyaktig. Svar bare med den omskrevne teksten.`,
        },
        { role: 'user', content: text },
      ],
      temperature: 0,
    });
    return result.content.trim() || text;
  };

  async function* guard(
    ctx: InvocationContext,
    input: Input,
    config: C,
    stream: (scoped: InvocationContext, config: C) => AsyncIterable<Emitted>,
  ): AsyncIterable<Emitted> {
    const { guardrails, provenance, guarded, primaryModel, rules } = await setup(ctx, config);
    const question = questionOf(input);
    const pii = guardrails.piiBeforeModel;

    const asked = detectLanguage(question).language;
    const chosen: Language | undefined = !guardrails.language
      ? options.answerLanguage
        ? await options.answerLanguage(ctx, input, config, question)
        : answerLanguage(await options.writtenStandard?.(ctx, input, config), question)
      : guardrails.language.mode === 'same'
        ? asked === 'unknown'
          ? undefined
          : asked
        : guardrails.language.mode;
    const choice = chooseLanguage(chosen, asked, serviceLanguagesOf(config));
    const target = choice.language;
    const houseStyle = target
      ? ((await options.houseStyle?.(ctx, input, config, target)) ??
        (options.houseStyle ? undefined : defaultHouseStyle(target)))
      : undefined;
    const assembled = assembleLanguage(config, target, houseStyle);
    const languageProvenance: AnswerLanguageProvenance | undefined = target
      ? {
          answer: target,
          layers: assembled.layers,
          textHash: await textHash([
            (assembled.config as { strategy?: { instructions?: string } }).strategy?.instructions,
            assembled.instruction,
          ]),
          ...(choice.fallback ? { fallback: true as const } : {}),
        }
      : undefined;
    const say = (text: string) => inLanguage(text, target);
    const told = (parts: Part[], extra: Partial<Provenance> = {}) => {
      const made = provenance(parts, extra);
      return {
        ...made,
        aiDisclosure: say(made.aiDisclosure),
        ...(languageProvenance ? { language: languageProvenance } : {}),
      };
    };
    const notice =
      choice.fallback && writesText(config) ? `${say(defaultMessages.unsupported)}\n\n` : '';

    if (pii?.action === 'refuse' && findPii(question, pii.categories).length > 0) {
      yield* refusal(say(pii.message ?? defaultMessages.pii), told([]));
      return;
    }

    const scoped = guarded(assembled.instruction);
    const runtime = ruleRuntime(ctx, () => primaryModel(scoped));

    if (rules.length > 0) {
      const checked = await applyRules(rules, 'input', question, runtime);
      if (checked.refused) {
        yield ruleEvent(checked.rule, 'input', 'refused');
        yield* refusal(say(checked.message ?? defaultMessages.rule), told([]));
        return;
      }
    }

    if (await offTopic(guardrails, question, () => primaryModel(scoped))) {
      yield* refusal(say(guardrails.refuseTopics?.message ?? defaultMessages.topic), told([]));
      return;
    }

    const holds = Boolean(
      guardrails.requireSources ||
      guardrails.language ||
      guardrails.humanApproval ||
      rules.some((r) => appliesTo(r, 'output')),
    );
    const logCategories = guardrails.piiOutOfLog?.categories ?? [];
    let held = '';
    let parts: Part[] | undefined;

    if (notice && !holds) yield { type: 'kernel.part.delta', data: { text: notice } };
    for await (const event of stream(scoped, assembled.config as C)) {
      if (event.type === 'kernel.part.delta') {
        if (holds) held += (event.data as { text?: string }).text ?? '';
        else yield event;
      } else if (event.type === 'kernel.result') {
        parts = event.data as Part[];
      } else if (event.type === 'kernel.interrupt') {
        yield event;
        return;
      } else if (passesThroughUnchanged.has(event.type)) {
        yield event;
      } else {
        yield { ...event, data: redactPii(event.data, logCategories) };
      }
    }
    if (!parts) return;

    let answer = answerText(parts) ?? held;
    if (guardrails.requireSources && !hasValidCitation(parts)) {
      answer = say(guardrails.requireSources.message);
      parts = [textPart(answer)];
    } else if (target && guardrails.language && guardrails.language.rewrite && answer) {
      const said = detectLanguage(answer).language;
      if (said !== 'unknown' && said !== target) {
        answer = await rewrite(answer, target, await primaryModel(scoped));
        parts = withAnswer(parts, answer);
      }
    }

    if (answer && rules.some((r) => appliesTo(r, 'output'))) {
      const checked = await applyRules(rules, 'output', answer, runtime);
      if (checked.refused) {
        yield ruleEvent(checked.rule, 'output', 'refused');
        answer = say(checked.message ?? defaultMessages.rule);
        parts = [textPart(answer)];
      } else if (checked.masked.length > 0) {
        for (const rule of checked.masked) yield ruleEvent(rule, 'output', 'masked');
        answer = checked.text;
        parts = withAnswer(parts, answer);
      }
    }

    if (notice && answer) {
      answer = notice + answer;
      parts = withAnswer(parts, answer);
    }

    if (guardrails.humanApproval) {
      const pending: Held = {
        kind: checkpointKind,
        parts,
        answer,
        provenance: told(parts),
        ...(target ? { language: target } : {}),
      };
      await ctx.state.checkpoint(pending);
      yield {
        type: 'kernel.interrupt',
        data: {
          id: 'human-approval',
          reason: 'approval',
          prompt: [textPart(say(guardrails.humanApproval.prompt)), ...parts],
          responseSchema: {
            type: 'object',
            properties: { approved: { type: 'boolean' }, approver: { type: 'string' } },
            required: ['approved'],
          },
          ...(guardrails.humanApproval.expiresInMinutes
            ? {
                expiresAt: new Date(
                  Date.now() + guardrails.humanApproval.expiresInMinutes * 60_000,
                ).toISOString(),
              }
            : {}),
        },
      };
      return;
    }

    if (holds && answer) yield { type: 'kernel.part.delta', data: { text: answer } };
    yield { type: 'kernel.result', data: finalParts(parts, told(parts)) };
  }

  const isHeld = (checkpoint: unknown): checkpoint is Held =>
    (checkpoint as Held | undefined)?.kind === checkpointKind;

  return {
    id: inner.id,
    version: inner.version,
    requires: { ...inner.requires, ports, features },
    run: (ctx, input, config) =>
      guard(ctx, input, config, (scoped, assembled) => inner.run(scoped, input, assembled)),
    resume: (ctx, checkpoint, response, config) => {
      if (isHeld(checkpoint)) return approve(ctx, checkpoint, response, config);
      if (!inner.resume) throw new Error(`strategy ${inner.id} cannot resume`);
      const resumeInner = inner.resume.bind(inner);
      return guard(ctx, response, config, (scoped, assembled) =>
        resumeInner(scoped, checkpoint, response, assembled),
      );
    },
  };

  async function* approve(
    ctx: InvocationContext,
    held: Held,
    response: Input,
    config: C,
  ): AsyncIterable<Emitted> {
    const { guardrails } = await setup(ctx, config);
    const reply = (response.data ?? {}) as { approved?: unknown; approver?: unknown };
    const approver = ctx.responder
      ? { approver: `${ctx.responder.kind}:${ctx.responder.issuer}:${ctx.responder.subject}` }
      : typeof reply.approver === 'string'
        ? { approver: reply.approver }
        : {};
    if (reply.approved === true) {
      yield { type: 'kernel.part.delta', data: { text: held.answer } };
      yield {
        type: 'kernel.result',
        data: finalParts(held.parts, { ...held.provenance, approved: true, ...approver }),
      };
      return;
    }
    const message = inLanguage(
      guardrails.humanApproval?.message ?? defaultMessages.rejected,
      held.language,
    );
    yield* refusal(message, { ...held.provenance, sources: [], approved: false, ...approver });
  }
};
