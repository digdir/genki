type Env = Record<string, string | undefined>;

interface Environment {
  name: string;
  altinn: string;
  maskinporten: string;
  ansattporten: string;
}

const environments: readonly Environment[] = [
  {
    name: 'production',
    altinn: 'https://platform.altinn.no',
    maskinporten: 'https://maskinporten.no',
    ansattporten: 'https://ansattporten.no',
  },
  {
    name: 'test',
    altinn: 'https://platform.tt02.altinn.no',
    maskinporten: 'https://test.maskinporten.no',
    ansattporten: 'https://test.ansattporten.no',
  },
];

const originOf = (url: string | undefined) => {
  if (!url?.trim()) return undefined;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return undefined;
  }
};

const environmentOf = (
  url: string | undefined,
  field: 'altinn' | 'maskinporten' | 'ansattporten',
) => {
  const origin = originOf(url);
  return origin ? environments.find((e) => e[field] === origin) : undefined;
};

/** Altinn, Maskinporten and Ansattporten from different environments do not know each other's tokens or people. */
export const altinnEnvironmentProblems = (env: Env): string[] =>
  (['ALTINN_PDP_URL', 'ALTINN_PEOPLE_URL'] as const).flatMap((setting) => {
    const altinn = environmentOf(env[setting], 'altinn');
    if (!altinn) return [];
    const ansattporten = environmentOf(env.ANSATTPORTEN_ISSUER, 'ansattporten');
    return [
      ...(['MASKINPORTEN_ISSUER', 'MASKINPORTEN_TOKEN_URL'] as const).flatMap((name) => {
        const maskinporten = environmentOf(env[name], 'maskinporten');
        return maskinporten && maskinporten !== altinn
          ? [
              `${setting} is ${altinn.name} Altinn but ${name} is ${maskinporten.name} Maskinporten; set MASKINPORTEN_ISSUER to ${altinn.maskinporten}/ and MASKINPORTEN_TOKEN_URL to ${altinn.maskinporten}/token`,
            ]
          : [];
      }),
      ...(ansattporten && ansattporten !== altinn
        ? [
            `${setting} is ${altinn.name} Altinn but ANSATTPORTEN_ISSUER is ${ansattporten.name} Ansattporten, which lists organisations from ${ansattporten.altinn}; set ${setting} to ${ansattporten.altinn}`,
          ]
        : []),
    ];
  });
