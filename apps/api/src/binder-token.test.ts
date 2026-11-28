import { describe, expect, it } from 'vitest';
import { binderTrustFrom, recorderTrustFrom } from './binder-token.js';

const principal = '0b5c1f0e-6f0a-4c41-9d1e-2a6b7c8d9e0f';
const tenant = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const recorder = {
  GENAI_DEMO_RECORDER_PRINCIPAL_ID: principal,
  GENAI_DEMO_RECORDER_TENANT_ID: tenant,
  GENAI_DEMO_RECORDER_AUDIENCE: 'api://genki-test-api',
};

describe('workload trust from the environment', () => {
  it('trusts no recorder identity unless its principal, tenant and audience are set and the ids are GUIDs', () => {
    expect(recorderTrustFrom(recorder)).toMatchObject({
      principalId: principal,
      tenantId: tenant,
      audience: 'api://genki-test-api',
    });
    for (const name of Object.keys(recorder))
      expect(recorderTrustFrom({ ...recorder, [name]: '' }), name).toBeUndefined();
    expect(
      recorderTrustFrom({ ...recorder, GENAI_DEMO_RECORDER_PRINCIPAL_ID: 'recorder' }),
    ).toBeUndefined();
    expect(
      recorderTrustFrom({ ...recorder, GENAI_DEMO_RECORDER_TENANT_ID: 'digdir' }),
    ).toBeUndefined();
  });

  it('keeps the recorder and the binder apart: neither reads the other’s settings', () => {
    expect(binderTrustFrom(recorder)).toBeUndefined();
    expect(
      recorderTrustFrom({
        GENAI_HOSTNAME_BINDER_PRINCIPAL_ID: principal,
        GENAI_HOSTNAME_BINDER_TENANT_ID: tenant,
        GENAI_HOSTNAME_BINDER_AUDIENCE: 'api://genki-test-api',
      }),
    ).toBeUndefined();
  });
});
