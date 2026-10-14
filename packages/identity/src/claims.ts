export const INTERNAL_GRANT_PREFIX = 'grant:';

export const ORGNO_AUTHORITY = 'iso6523-actorid-upis';

export interface OrgNo {
  authority: string;
  ID: string;
}

export const toOrgNo = (orgno: string): OrgNo => ({
  authority: ORGNO_AUTHORITY,
  ID: `0192:${orgno}`,
});

export const fromOrgNo = (value: OrgNo | undefined): string | undefined => {
  const match = value?.ID ? /^0192:(\d{9})$/.exec(value.ID) : null;
  return match?.[1];
};

export interface AuthorizedParty {
  orgno: OrgNo;
  resource: string;
  actions?: string[];
  name: string;
  unit_type: string;
}

export interface AltinnResourceDetail {
  type: 'ansattporten:altinn:resource';
  resource: string;
  resource_name?: string;
  authorized_parties: AuthorizedParty[];
}

export interface SystemUserDetail {
  type: 'urn:altinn:systemuser';
  systemuser_org: OrgNo;
  systemuser_id: string[];
  system_id: string;
}

export const resourceId = (urn: string) => urn.replace(/^urn:altinn:resource:/, '');
