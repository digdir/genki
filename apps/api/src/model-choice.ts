import { randomBytes } from 'node:crypto';
import type { Principal } from '@genai/contracts';
import type { JudgeModel } from '@genai/eval';
import { blockStatusFor, readBlockPolicy } from './building-blocks.js';
import type { DraftOrigin, DraftRunOutcome, DraftRunSuccess } from './draft-runner.js';
import { ownedElsewhere } from './model-access.js';
import type { ModuleDeps } from './platform-modules.js';

export type ModelChoiceDeps = Pick<
  ModuleDeps,
  'models' | 'catalog' | 'configEntries' | 'prices' | 'settings' | 'drafts'
>;

export const ephemeralId = (prefix = 'skilltest') => `${prefix}-${randomBytes(8).toString('hex')}`;

export interface Meter {
  add(outcome: DraftRunOutcome): void;
  inputTokens: number;
  outputTokens: number;
  costMicroNok(): number | null;
}

export const modelChoice = (deps: ModelChoiceDeps) => {
  const describe = () => deps.models.describe();
  const familyOf = (model: string) => describe().find((m) => m.id === model)?.family;
  const residencyOf = (model: string) =>
    describe().find((m) => m.id === model)?.residency ?? 'global';
  const costOf = (model: string) => {
    const price = deps.prices[model];
    return price ? price.inputPerThousand + price.outputPerThousand : Number.POSITIVE_INFINITY;
  };

  const settingOf = (tenant: string, key: string) => {
    try {
      const value = deps.settings.effective(tenant)[key]?.value;
      return typeof value === 'string' && value ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const usable = async (tenant: string) => {
    const policy = await readBlockPolicy(deps.configEntries, tenant);
    return describe()
      .filter(
        (m) =>
          m.enabled &&
          !ownedElsewhere(deps.catalog, m.id, tenant) &&
          ['available', 'in_use'].includes(
            blockStatusFor(policy, { kind: 'model', id: m.id, dataLocation: m.residency }).status,
          ),
      )
      .sort((a, b) => costOf(a.id) - costOf(b.id) || 0);
  };

  type Candidate = Awaited<ReturnType<typeof usable>>[number];

  const choose = (
    candidates: Candidate[],
    requested: string | undefined,
    configured: string | undefined,
  ) => {
    if (requested) return candidates.find((m) => m.id === requested)?.id;
    return (candidates.find((m) => m.id === configured) ?? candidates[0])?.id;
  };

  const pickJudge = (
    candidates: Candidate[],
    tenant: string,
    served: string[],
    requested?: string,
    settingKey = 'skills.judgeModel',
  ) => {
    const families = new Set(served.map(familyOf));
    return choose(
      candidates.filter(
        (m) => m.family !== undefined && !families.has(m.family) && !served.includes(m.id),
      ),
      requested,
      settingOf(tenant, settingKey),
    );
  };

  const ephemeralService = (
    tenant: string,
    id: string,
    purpose: string,
    instructions: string,
    model: string,
    output: Record<string, unknown>,
    knowledge?: { dataset: string },
  ) => ({
    apiVersion: 'genai/v1',
    kind: 'Service',
    metadata: { tenant, id, name: id },
    spec: {
      purpose,
      riskClass: 'minimal',
      input: { accepts: ['text/plain'] },
      output,
      strategy: knowledge
        ? { id: 'rag-single-shot', version: 1, config: { instructions, generate: true } }
        : { id: 'single-call', version: 1, config: { instructions } },
      ...(knowledge ? { knowledge: { datasets: [{ dataset: knowledge.dataset }] } } : {}),
      model: { primary: model, residency: residencyOf(model) },
    },
  });

  const complete = async (
    principal: Principal,
    tenant: string,
    model: string,
    system: string,
    user: string,
    origin: DraftOrigin,
    meter?: Meter,
  ): Promise<DraftRunSuccess> => {
    const outcome = await deps.drafts.run({
      principal,
      tenant,
      definition: ephemeralService(tenant, ephemeralId('call'), 'Modellkall', system, model, {
        kind: 'answer',
      }),
      parts: [{ kind: 'text', text: user }],
      origin,
    });
    meter?.add(outcome);
    if (!outcome.ok) throw new Error(outcome.errors.map((e) => e.message).join('; '));
    return outcome;
  };

  const judgeModel = (
    principal: Principal,
    tenant: string,
    model: string,
    origin: DraftOrigin,
    meter?: Meter,
  ): JudgeModel => ({
    id: model,
    family: familyOf(model) ?? model,
    complete: async (messages) => {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      return (await complete(principal, tenant, model, system, user, origin, meter)).answer;
    },
  });

  const meter = (): Meter => {
    let unpriced = false;
    let micro = 0;
    const self: Meter = {
      inputTokens: 0,
      outputTokens: 0,
      add: (outcome) => {
        if (!outcome.ok) return;
        self.inputTokens += outcome.usage.inputTokens;
        self.outputTokens += outcome.usage.outputTokens;
        for (const used of outcome.usage.byModel) {
          if (
            !deps.prices[used.model] &&
            used.costMicroNok === 0 &&
            used.inputTokens + used.outputTokens > 0
          )
            unpriced = true;
          micro += used.costMicroNok;
        }
      },
      costMicroNok: () => (unpriced ? null : micro),
    };
    return self;
  };

  return {
    familyOf,
    residencyOf,
    settingOf,
    usable,
    choose,
    pickJudge,
    ephemeralService,
    complete,
    judgeModel,
    meter,
  };
};

export type ModelChoice = ReturnType<typeof modelChoice>;
