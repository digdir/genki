import { describe, expect, it } from 'vitest';
import { entraGroupProblems, rightsFromEntraGroups, trustedEntraFrom } from './entra-groups.js';

const operators = '76d10637-d517-413c-a10b-84675a3ed64b';
const members = '789b5488-39ec-47b3-9217-840e5cd957fd';
const services = '30a76637-d1ff-4040-bc1f-fb9b8ccd749c';
const resource = 'urn:altinn:resource:digdir-genai-platform';

describe('rights from Entra groups', () => {
  it('reads the group rules without lockdown', () => {
    expect(
      trustedEntraFrom(
        {
          OPERATOR_ENTRA_GROUPS: ` ${operators} `,
          MEMBER_ENTRA_GROUPS: members,
          SERVICE_ENTRA_GROUPS: services,
          SERVICE_ENTRA_CLIENT_IDS: ' ka-backend ',
          OPERATOR_CLIENT_IDS: 'console',
          ENTRA_EMAIL_DOMAIN: '@digdir.no',
        },
        '991825827',
        resource,
      ),
    ).toEqual({
      groups: [operators],
      userGroups: [members],
      serviceGroups: [services],
      serviceClientIds: ['ka-backend'],
      clientIds: ['console'],
      tenant: '991825827',
      resource,
      emailDomain: 'digdir.no',
    });
  });

  it('trusts no Entra login when no group is set', () => {
    expect(trustedEntraFrom({ GENAI_LOCKDOWN: 'true' }, '1', resource)).toBeUndefined();
  });

  it('only operator or member groups give rights from Entra groups, not the service group alone', () => {
    expect(rightsFromEntraGroups({ MEMBER_ENTRA_GROUPS: members })).toBe(true);
    expect(rightsFromEntraGroups({ OPERATOR_ENTRA_GROUPS: operators })).toBe(true);
    expect(rightsFromEntraGroups({ SERVICE_ENTRA_GROUPS: services })).toBe(false);
  });

  it('refuses to start with a LOCKDOWN_ group setting and names its new name', () => {
    expect(entraGroupProblems({ LOCKDOWN_USER_GROUPS: members })).toEqual([
      'LOCKDOWN_USER_GROUPS is now MEMBER_ENTRA_GROUPS; rename it',
    ]);
    expect(entraGroupProblems({ LOCKDOWN_ENTRA_GROUPS: ' ' })).toEqual([]);
  });

  it('refuses group settings that are not Entra group object ids', () => {
    expect(
      entraGroupProblems({
        MEMBER_ENTRA_GROUPS: `${members}, genki-users`,
        PLATFORM_LOGIN_CLIENT_ID: 'login',
        PLATFORM_APP_ORIGINS: 'https://portal.example',
      }),
    ).toEqual(['MEMBER_ENTRA_GROUPS must list Entra group object ids, got "genki-users"']);
  });

  it('refuses member or operator groups with no platform client whose logins count', () => {
    expect(entraGroupProblems({ MEMBER_ENTRA_GROUPS: members })).toEqual([
      expect.stringContaining('PLATFORM_LOGIN_CLIENT_ID'),
    ]);
    expect(entraGroupProblems({ MEMBER_ENTRA_GROUPS: members, OPERATOR_CLIENT_IDS: 'c' })).toEqual(
      [],
    );
  });

  it('refuses a platform client among the service clients', () => {
    expect(
      entraGroupProblems({
        SERVICE_ENTRA_GROUPS: services,
        SERVICE_ENTRA_CLIENT_IDS: 'ka-backend,genki-console',
        OPERATOR_CLIENT_IDS: 'genki-console',
      }),
    ).toEqual([expect.stringContaining('"genki-console"')]);
  });
});
