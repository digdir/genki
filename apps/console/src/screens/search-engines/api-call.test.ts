import { describe, expect, it } from 'vitest';
import { translator } from '../../i18n';
import { curlOf } from './ApiCallPanel';

const t = translator('nb');

describe('API call preview', () => {
  it('uses the configured API base, not a placeholder host', () => {
    const curl = curlOf({ title: 'Hent', method: 'GET', path: '/operator/knowledge/endpoints' }, t);
    expect(curl).toContain('"http://localhost:8080/operator/knowledge/endpoints"');
    expect(curl).not.toContain('example.no');
  });

  it('sends a change reason with writes and the version to match when given', () => {
    const write = curlOf(
      {
        title: 'Lagre',
        method: 'PUT',
        path: '/operator/knowledge/endpoints/sok',
      },
      t,
    );
    expect(write).toContain('-H "change-reason: <begrunnelse>"');
    expect(curlOf({ title: 'Hent', method: 'GET', path: '/x' }, t)).not.toContain('change-reason');

    const pinned = curlOf(
      {
        title: 'Lagre',
        method: 'PUT',
        path: '/operator/knowledge/endpoints/sok',
        headers: { 'change-reason': 'Ny adresse for søk', 'if-match': '"3"' },
      },
      t,
    );
    expect(pinned).toContain('-H "change-reason: Ny%20adresse%20for%20s%C3%B8k"');
    expect(pinned).toContain('-H "if-match: \\"3\\""');
  });
});
