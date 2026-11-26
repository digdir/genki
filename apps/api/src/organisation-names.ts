export interface OrganisationNameSources {
  tenantDirectory?: (() => Promise<readonly { orgNumber: string; name: string }[]>) | undefined;
  organisationName?: ((orgNumber: string) => string | undefined) | undefined;
  registeredName?: ((orgNumber: string) => Promise<string | undefined>) | undefined;
}

const ownName = (orgNumber: string, name: string | undefined) =>
  name && name !== orgNumber ? name : undefined;

/** Each organisation's name from the token, else the tenant directory, test data or Enhetsregisteret. */
export const organisationNames = async (
  orgNumbers: readonly string[],
  tokenNames: Readonly<Record<string, string>> | undefined,
  sources: OrganisationNameSources,
): Promise<(string | undefined)[]> => {
  const fromToken = orgNumbers.map((orgNumber) => ownName(orgNumber, tokenNames?.[orgNumber]));
  if (fromToken.every(Boolean)) return fromToken;
  const directory = (await sources.tenantDirectory?.().catch(() => [])) ?? [];
  return Promise.all(
    orgNumbers.map(
      async (orgNumber, i) =>
        fromToken[i] ??
        ownName(orgNumber, directory.find((d) => d.orgNumber === orgNumber)?.name) ??
        ownName(orgNumber, sources.organisationName?.(orgNumber)) ??
        ownName(orgNumber, await sources.registeredName?.(orgNumber).catch(() => undefined)),
    ),
  );
};
