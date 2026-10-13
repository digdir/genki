import type { Format, PlainKey, T } from '../../i18n';
import { refusalOf } from '../../states';
import type {
  SkillAssistantIntent,
  SkillAssistantProposal,
  SkillAssistantTurn,
  SkillExample,
  SkillSpec,
} from '../../api/skills';
import type { ProposalSection } from '../../data/skills';
import type { AssistantNotice, EditorCard, RejectedEditorCard } from './model';

type Ask = ProposalSection | 'fix';
type Notice = Omit<AssistantNotice, 'section'>;
type Fields = Pick<SkillSpec, ProposalSection>;

export interface AppliedCard {
  card: EditorCard;
  value: Fields[ProposalSection];
}

export interface TurnResult {
  applied: AppliedCard[];
  rejected: RejectedEditorCard[];
  notice?: Notice;
}

const sections: ProposalSection[] = ['description', 'instructions', 'examples'];

const intents: Record<Ask, SkillAssistantIntent> = {
  description: 'suggest-description',
  instructions: 'suggest-instructions',
  examples: 'suggest-examples',
  fix: 'fix-instructions',
};

const askKeys: Record<Ask, PlainKey> = {
  description: 'skills.askDescription',
  instructions: 'skills.askInstructions',
  examples: 'skills.askExamples',
  fix: 'skills.askFix',
};

export const askMessage = (t: T, ask: Ask) => t(askKeys[ask]);

export const intentFor = (ask: Ask) => intents[ask];

const budgetText = (t: T, f: Format, dailyBudget?: number) =>
  dailyBudget
    ? t('skills.budgetExhaustedTokens', { budget: f.number(dailyBudget) })
    : t('skills.budgetExhausted');

const fieldName = (value?: string) =>
  value
    ?.replace(/^\//, '')
    .replace(/^spec[./]/, '')
    .split(/[./]/)[0];

const fieldOf = (proposal: SkillAssistantProposal, fallback: ProposalSection) =>
  [proposal.section, proposal.patch?.[0]?.path]
    .map(fieldName)
    .find((v): v is ProposalSection => sections.includes(v as ProposalSection)) ?? fallback;

const examplesText = (t: T, examples: SkillExample[]) =>
  examples
    .map((x) => t('skills.exampleLine', { input: x.input, output: x.expectedOutput }))
    .join('\n\n');

const sameExample = (a: SkillExample | undefined, b: SkillExample) =>
  a?.input === b.input && a.expectedOutput === b.expectedOutput;

const shown = (t: T, field: ProposalSection, before: Fields, value: Fields[ProposalSection]) => {
  if (field === 'examples') {
    const list = value as SkillExample[];
    const appended =
      list.length > before.examples.length &&
      before.examples.every((x, i) => sameExample(list[i], x));
    return appended
      ? {
          after: examplesText(t, list.slice(before.examples.length)),
          afterLabel: t('skills.addedLabel'),
        }
      : {
          before: examplesText(t, before.examples) || t('skills.noExamples'),
          after: examplesText(t, list),
        };
  }
  const old = before[field];
  const text = value as string;
  return field === 'instructions' && old && text.startsWith(old) && text !== old
    ? { after: text.slice(old.length).trim(), afterLabel: t('skills.addedLabel') }
    : { before: old || t('skills.empty'), after: text };
};

const rejectedFrom = (
  turn: SkillAssistantTurn,
  invalid: SkillAssistantProposal[],
  section: ProposalSection,
): RejectedEditorCard[] => [
  ...invalid.map((p) => ({
    id: `${turn.turnId}-${p.id}`,
    section: fieldOf(p, section),
    attempted: p.title,
    reason: (p.validation.errors ?? []).map((e) => e.message).join(' ') || p.detail,
    code: 'VALIDATION',
  })),
  ...(turn.rejected ?? []).map((r, i) => ({
    id: `${turn.turnId}-rejected-${i}`,
    section,
    attempted: r.attempted,
    reason: r.reason,
    code: r.code,
  })),
];

export const readTurn = (
  turn: SkillAssistantTurn,
  spec: SkillSpec,
  section: ProposalSection,
  tenantName: string,
  t: T,
  f: Format,
): TurnResult => {
  if (turn.status === 'budget_exhausted')
    return {
      applied: [],
      rejected: [],
      notice: { color: 'warning', text: budgetText(t, f, turn.usage.dailyBudget) },
    };
  if (turn.status === 'unavailable')
    return {
      applied: [],
      rejected: [],
      notice: { color: 'warning', text: t('skills.unavailable') },
    };
  if (turn.status === 'refused')
    return {
      applied: [],
      rejected: [],
      notice: turn.policy
        ? {
            color: 'warning',
            text: t('skills.policyRefused', {
              tenant: tenantName,
              rule: turn.policy.rule,
              owner: turn.policy.ownedBy,
            }),
          }
        : { color: 'info', text: turn.message || t('skills.cannotPropose') },
    };
  const changes = turn.proposals.filter((p) => p.level === 1);
  const valid = changes.filter((p) => p.validation.ok && p.after);
  const invalid = changes.filter((p) => !p.validation.ok);
  let current: Fields = {
    description: spec.description,
    instructions: spec.instructions,
    examples: spec.examples,
  };
  const applied: AppliedCard[] = [];
  for (const p of valid) {
    const field = fieldOf(p, section);
    const value = p.after?.spec?.[field];
    if (value === undefined) continue;
    applied.push({
      value,
      card: {
        id: `${turn.turnId}-${p.id}`,
        section: field,
        title: p.title,
        detail: p.detail,
        ...shown(t, field, current, value),
        previous: current,
        undone: false,
      },
    });
    current = { ...current, [field]: value };
  }
  const rejected = rejectedFrom(turn, invalid, section);
  return applied.length || rejected.length
    ? { applied, rejected }
    : {
        applied,
        rejected,
        notice: { color: 'info', text: turn.message || t('skills.nothingToChange') },
      };
};

export const failureNotice = (error: unknown, t: T): Notice => {
  const refusal = refusalOf(error);
  if (refusal) return { color: 'danger', text: refusal };
  return {
    color: 'danger',
    text: t('skills.noContact'),
  };
};
