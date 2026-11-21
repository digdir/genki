import { describe, expect, it } from 'vitest';
import { kudosFilePolicy } from './pipeline-sources.js';
import { defaultFetchPolicy } from './website.js';

describe('KUDOS file downloads', () => {
  it('gives KUDOS file downloads a 15 s connect timeout and leaves website fetches at 5 s', () => {
    // KUDOS sometimes takes more than 5 s to accept a connection, and a convert job failed on it
    // (issue 906, UND_ERR_CONNECT_TIMEOUT about 5 s after start).
    expect(kudosFilePolicy().connectTimeoutMs).toBe(15_000);
    expect(defaultFetchPolicy.connectTimeoutMs).toBe(5_000);
  });
});
