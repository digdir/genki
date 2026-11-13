import { ApiError, type ApiClient } from '../../api';
import { residencyName } from '../../data/services';
import { translator, type PlainKey, type T } from '../../i18n';
import type { PublishedDefinition } from '../../types';
import { problemErrors } from './definition';

export type PublishProblem = { path: string; message: string };

export type PublishOutcome =
  | { ok: true; published: PublishedDefinition }
  | { ok: false; errors: PublishProblem[]; refusedByGates: boolean; outdated?: true };

export const draftOutdated = 'urn:genai:problem:draft-outdated';

export const publishDraft = async (
  api: ApiClient,
  definition: Record<string, unknown>,
  files: Record<string, string>,
  reason: string,
  draftRevision?: number,
): Promise<PublishOutcome> => {
  const failed = (errors: PublishProblem[]): PublishOutcome => ({
    ok: false,
    errors,
    refusedByGates: errors.some((e) => e.path === 'spec.evaluation'),
  });
  try {
    const completed = await api.completeDefinition(definition);
    const check = await api.validate(completed, files);
    if (!check.valid) return failed(check.errors);
    return {
      ok: true,
      published: await api.publishDefinition(completed, files, reason, draftRevision),
    };
  } catch (error) {
    if (error instanceof ApiError && error.problem?.type === draftOutdated)
      return {
        ok: false,
        errors: error.problem.errors ?? [],
        refusedByGates: false,
        outdated: true,
      };
    return failed(problemErrors(error));
  }
};

const sections: [RegExp, PlainKey][] = [
  [/^metadata\.(name|id)/, 'service.areaPurpose'],
  [/^spec\.(purpose|audience|riskClass|riskConfirmation)/, 'service.areaPurpose'],
  [/^spec\.(input|output)/, 'service.areaInOut'],
  [/^spec\.strategy\.config\.(instructions|examples)/, 'service.areaInstructions'],
  [/^spec\.knowledge/, 'service.areaKnowledge'],
  [/^spec\.(tools|skills)/, 'service.areaTools'],
  [/^spec\.strategy/, 'service.areaStrategy'],
  [/^spec\.model/, 'service.areaModel'],
  [/^spec\.guardrails/, 'service.areaGuardrails'],
  [/^spec\.(exposure|variants|triggers|batch|availableTo)/, 'service.areaStart'],
  [/^spec\.(evaluation|improve)/, 'service.areaQuality'],
  [/^spec\.settings/, 'service.areaSettings'],
];

export const sectionOf = (path: string, t: T = translator('nb')) => {
  const key = sections.find(([pattern]) => pattern.test(path))?.[1];
  return key ? t(key) : undefined;
};

const messages: [RegExp, (m: RegExpExecArray, t: T) => string][] = [
  [/no published step flow (\S+)/, (m, t) => t('service.flowNotPublished', { flow: m[1] ?? '' })],
  [
    /runs in (\w+), outside (\w+)/,
    (m, t) =>
      t('service.residencyMismatch', {
        actual: residencyName(m[1]),
        required: residencyName(m[2]),
      }),
  ],
  [
    /^Required$|received undefined|expected string to have >=1 characters/,
    (_m, t) => t('service.required'),
  ],
];

export const describeProblem = (problem: PublishProblem, t: T = translator('nb')) => {
  const section = sectionOf(problem.path, t) ?? t('service.areaDefinition');
  for (const [pattern, text] of messages) {
    const match = pattern.exec(problem.message);
    if (match) return { section, message: text(match, t) };
  }
  return { section, message: problem.message };
};
