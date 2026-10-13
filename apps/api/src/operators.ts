import type { Principal } from '@genai/contracts';
import type { VerifiedIdentity } from '@genai/identity';

interface PersonEntry {
  pid?: unknown;
  operator?: unknown;
}

export const splitOperators = <T extends Record<string, unknown>>(
  raw: T,
): { testData: T; operatorPids: string[] } => {
  const persons = Array.isArray(raw.persons) ? (raw.persons as PersonEntry[]) : [];
  return {
    operatorPids: persons
      .filter((p) => p.operator === true && typeof p.pid === 'string')
      .map((p) => p.pid as string),
    testData: {
      ...raw,
      ...(Array.isArray(raw.persons)
        ? { persons: persons.map(({ operator: _operator, ...person }) => person) }
        : {}),
    },
  };
};

export const operatorDirectory = (pids: Iterable<string>, subjects: Iterable<string> = []) => {
  const operatorPids = new Set(pids);
  const known = new Set(subjects);
  return {
    add: (subject: string) => {
      known.add(subject);
    },
    isOperator: (principal: Pick<Principal, 'subject'>) => known.has(principal.subject),
    watch: <V extends { verify(token: string): Promise<VerifiedIdentity> }>(verifier: V): V => ({
      ...verifier,
      verify: async (token: string) => {
        const verified = await verifier.verify(token);
        if (verified.personId && operatorPids.has(verified.personId))
          known.add(verified.principal.subject);
        return verified;
      },
    }),
  };
};
