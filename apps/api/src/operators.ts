import type { Principal } from '@genai/contracts';
import { trustedEntraScope, type VerifiedIdentity } from '@genai/identity';
import { isDevMode, operatorClientIds } from '@genai/composition';

type Env = Record<string, string | undefined>;

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

export const operatorSubjectsFrom = (env: Env) =>
  (env.OPERATOR_SUBJECTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const pairOf = (entry: string) => {
  const at = entry.indexOf('|');
  return at < 0 ? undefined : { issuer: entry.slice(0, at), subject: entry.slice(at + 1) };
};

export const operatorSubjectProblems = (env: Env): string[] => {
  const entries = operatorSubjectsFrom(env);
  const malformed = entries.filter((entry) => {
    const pair = pairOf(entry);
    return pair !== undefined && (!pair.issuer || !pair.subject);
  });
  const bare = isDevMode(env) ? [] : entries.filter((entry) => !pairOf(entry));
  const unpinned =
    !isDevMode(env) &&
    entries.some((entry) => pairOf(entry)) &&
    operatorClientIds(env).length === 0;
  return [
    ...(malformed.length > 0
      ? [`OPERATOR_SUBJECTS has ${malformed.length} entries without an issuer or a subject`]
      : []),
    ...(bare.length > 0
      ? [
          `OPERATOR_SUBJECTS must list issuer|subject pairs outside dev mode; ${bare.length} entries have no issuer`,
        ]
      : []),
    ...(unpinned
      ? [
          'OPERATOR_SUBJECTS needs OPERATOR_CLIENT_IDS, the client ids whose logins can be operators',
        ]
      : []),
  ];
};

export interface OperatorSources {
  pids?: Iterable<string>;
  subjects?: Iterable<string>;
  clientIds?: readonly string[];
  mockIssuer?: string;
}

type OperatorCandidate = Pick<
  Principal,
  'kind' | 'issuer' | 'subject' | 'client' | 'scopes' | 'confinedTo'
>;

const keyOf = (issuer: string, subject: string) => `${issuer}|${subject}`;

export const operatorDirectory = ({
  pids = [],
  subjects = [],
  clientIds = [],
  mockIssuer,
}: OperatorSources) => {
  const operatorPids = new Set(mockIssuer ? pids : []);
  const known = new Set(
    [...subjects].flatMap((entry) => {
      const pair = pairOf(entry);
      if (pair) return pair.issuer && pair.subject ? [keyOf(pair.issuer, pair.subject)] : [];
      return mockIssuer ? [keyOf(mockIssuer, entry)] : [];
    }),
  );
  return {
    add: (principal: Pick<Principal, 'issuer' | 'subject'>) => {
      if (principal.issuer === mockIssuer) known.add(keyOf(principal.issuer, principal.subject));
    },
    isOperator: (principal: OperatorCandidate) =>
      principal.kind === 'employee' &&
      !principal.confinedTo &&
      ((known.has(keyOf(principal.issuer, principal.subject)) &&
        (principal.issuer === mockIssuer ||
          (principal.client !== undefined && clientIds.includes(principal.client)))) ||
        (principal.scopes?.includes(trustedEntraScope) ?? false)),
    watch: <V extends { verify(token: string): Promise<VerifiedIdentity> }>(verifier: V): V => ({
      ...verifier,
      verify: async (token: string) => {
        const verified = await verifier.verify(token);
        const { principal } = verified;
        if (
          principal.issuer === mockIssuer &&
          verified.personId &&
          operatorPids.has(verified.personId)
        )
          known.add(keyOf(principal.issuer, principal.subject));
        return verified;
      },
    }),
  };
};
