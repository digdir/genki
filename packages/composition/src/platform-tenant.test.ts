import { describe, expect, it } from 'vitest';
import {
  defaultPlatformTenant,
  ownedByPlatformTenant,
  platformTenantFrom,
  platformTenantProblems,
} from './platform-tenant.js';

describe('the platform tenant', () => {
  it('is Digdir when PLATFORM_TENANT is not set', () => {
    expect(defaultPlatformTenant).toBe('991825827');
    expect(platformTenantFrom({})).toBe('991825827');
    expect(platformTenantFrom({ PLATFORM_TENANT: '' })).toBe('991825827');
  });

  it('is the organisation PLATFORM_TENANT names', () => {
    expect(platformTenantFrom({ PLATFORM_TENANT: ' 213192752 ' })).toBe('213192752');
  });

  it('refuses a PLATFORM_TENANT that is not a nine-digit organisation number', () => {
    expect(platformTenantProblems({ PLATFORM_TENANT: '21319275' })).toEqual([
      expect.stringContaining('PLATFORM_TENANT'),
    ]);
    expect(platformTenantProblems({ PLATFORM_TENANT: 'digdir' })).toHaveLength(1);
    expect(platformTenantProblems({ PLATFORM_TENANT: '213192752' })).toEqual([]);
    expect(platformTenantProblems({})).toEqual([]);
  });

  it("moves only Digdir's definitions to the platform tenant", () => {
    const digdirs = { kind: 'Service', metadata: { tenant: '991825827', id: 'klarsprak' } };
    const others = { kind: 'Service', metadata: { tenant: '889640782', id: 'nav' } };

    expect(ownedByPlatformTenant(digdirs, '213192752').metadata.tenant).toBe('213192752');
    expect(ownedByPlatformTenant(others, '213192752')).toBe(others);
    expect(ownedByPlatformTenant(digdirs, '991825827')).toBe(digdirs);
    expect(digdirs.metadata.tenant).toBe('991825827');
  });
});
