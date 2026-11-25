export interface FlagSpec {
  description: string;
  owner: string;
  removeBy: string;
  selfService: boolean;
}

export const flags = {
  blockStudio: {
    description: 'Block Studio, the library of interface blocks in the portal',
    owner: 'the lab',
    removeBy: '2027-02-28',
    selfService: true,
  },
} as const satisfies Record<string, FlagSpec>;

export type FlagKey = keyof typeof flags;

export type SelfServiceFlag = {
  [K in FlagKey]: (typeof flags)[K]['selfService'] extends true ? K : never;
}[FlagKey];

export const flagKeys = Object.keys(flags) as FlagKey[];

export const isFlagKey = (value: unknown): value is FlagKey =>
  typeof value === 'string' && Object.hasOwn(flags, value);

export const flagLevels = ['person', 'tenant'] as const;
export type FlagLevel = (typeof flagLevels)[number];

export const flagSources = ['person', 'tenant', 'env', 'default'] as const;
export type FlagSource = (typeof flagSources)[number];

export interface FlagState {
  key: FlagKey;
  on: boolean;
  source: FlagSource;
  selfService: boolean;
  person: boolean | null;
  tenant: boolean | null;
}

export const expiredFlags = (now: Date, registry: Record<string, FlagSpec> = flags) =>
  Object.entries(registry)
    .filter(([, spec]) => new Date(`${spec.removeBy}T23:59:59Z`).getTime() < now.getTime())
    .map(([key]) => key);
