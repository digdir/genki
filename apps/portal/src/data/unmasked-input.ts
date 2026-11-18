import type { PlainKey, T } from '../i18n';
import type { UnmaskedInputUse } from '../types';
import type { RiskConfirmation } from './service-definition';

export const minimumUnmaskedReason = 10;

const kinds: [RegExp, PlainKey][] = [
  [/^text\//, 'unmaskedInput.kindText'],
  [/^image\//, 'unmaskedInput.kindImage'],
  [/^audio\//, 'unmaskedInput.kindAudio'],
  [/^video\//, 'unmaskedInput.kindVideo'],
  [/^application\/pdf$/, 'unmaskedInput.kindPdf'],
];

export const mediaKind = (t: T, mediaType: string) =>
  t(kinds.find(([pattern]) => pattern.test(mediaType))?.[1] ?? 'unmaskedInput.kindFile');

export const isUnmaskedReasonGiven = (reason: string | undefined) =>
  (reason ?? '').trim().length >= minimumUnmaskedReason;

export const unmaskedTypes = (uses: readonly UnmaskedInputUse[]) => [
  ...new Set(uses.map((u) => u.mediaType)),
];

const refusal = /^step (\S+) in (\S+): (\S+) takes (\S+) input, which cannot be masked/;

export const refusedUnmaskedInput = (errors: readonly { message: string }[]): UnmaskedInputUse[] =>
  errors.flatMap((e) => {
    const m = refusal.exec(e.message);
    return m
      ? [
          {
            step: m[1] ?? '',
            flow: m[2] ?? '',
            descriptor: m[3] ?? '',
            operation: '',
            mediaType: m[4] ?? '',
          },
        ]
      : [];
  });

export const withUnmaskedInput = <D extends Record<string, unknown>>(
  definition: D,
  reasons: Record<string, string>,
): D => {
  const given = Object.entries(reasons)
    .map(([mediaType, reason]) => ({ mediaType, reason: reason.trim() }))
    .filter((e) => isUnmaskedReasonGiven(e.reason));
  if (given.length === 0) return definition;
  const spec = (definition.spec ?? {}) as { riskConfirmation?: RiskConfirmation };
  const kept = (spec.riskConfirmation?.unmaskedInput ?? []).filter(
    (e) => !given.some((g) => g.mediaType === e.mediaType),
  );
  return {
    ...definition,
    spec: {
      ...spec,
      riskConfirmation: {
        reasons: [],
        ...spec.riskConfirmation,
        unmaskedInput: [...kept, ...given],
      },
    },
  };
};
