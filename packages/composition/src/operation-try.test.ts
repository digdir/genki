import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { environmentTierOf, maskEverything, operationTryPolicy } from './operation-try.js';

const allowAll = { decide: async () => ({ allow: true as const }) };
const operator: Principal = { kind: 'operator', issuer: 'test', subject: 'drift' };
const tryPrincipal: Principal = {
  kind: 'agency-system',
  issuer: 'platform',
  subject: 'operation-try',
  tenant: '991825827',
  actor: operator,
};
const service: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant: '991825827',
};
const model = { kind: 'model', id: 'lab/small' };

describe('the raw tier', () => {
  it('the environment tier is test only when GENAI_ENV says test', () => {
    expect(environmentTierOf({})).toBe('production');
    expect(environmentTierOf({ GENAI_ENV: 'test' })).toBe('test');
    for (const other of ['prod', 'production', 'staging', 'TEST'])
      expect(environmentTierOf({ GENAI_ENV: other })).toBe('production');
  });

  it('no service or person opens the operation port; the raw tier does nothing else', async () => {
    const policy = operationTryPolicy(allowAll);
    expect(await policy.decide(service, 'use:operation', model)).toMatchObject({ allow: false });
    expect(await policy.decide(operator, 'use:operation', model)).toMatchObject({ allow: false });
    expect(await policy.decide(tryPrincipal, 'use:operation', model)).toEqual({ allow: true });
    expect(
      await policy.decide(service, 'invoke', {
        kind: 'capability',
        id: 'platform/operation-try/x',
      }),
    ).toMatchObject({ allow: false });
    expect(await policy.decide(tryPrincipal, 'use:model', model)).toMatchObject({ allow: false });
    expect(await policy.decide(service, 'use:model', model)).toEqual({ allow: true });
  });

  it('the raw guard masks every PII category and restores none', () => {
    const guard = maskEverything();
    const masked = guard.masker?.mask('15838510075 ola@example.no +47 912 34 567 F32.1') ?? '';
    expect(masked).toBe('«NATIONAL_ID_1» «EMAIL_1» «PHONE_1» «HEALTH_CODE_1»');
    expect(guard.masker?.unmask).toBeUndefined();
  });
});
