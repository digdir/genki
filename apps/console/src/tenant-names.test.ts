import { describe, expect, it } from 'vitest';
import { translator } from './i18n';
import { tenantLabel } from './tenant-names';

describe('tenant names', () => {
  it('uses the name, never the bare org number', () => {
    expect(tenantLabel('999888777', 'Testetaten')).toBe('Testetaten');
    expect(tenantLabel('974760673', '974760673')).toBe('Org.nr. 974 760 673');
    expect(tenantLabel('974760673')).toBe('Org.nr. 974 760 673');
  });

  it('does not hard-code a name for the platform tenant when the API gives only its org number', () => {
    expect(tenantLabel('991825827', '991825827')).toBe('Org.nr. 991 825 827');
    expect(tenantLabel('991825827', 'Digitaliseringsdirektoratet')).toBe(
      'Digitaliseringsdirektoratet',
    );
  });

  it('labels a tenant without a name in the reader language', () => {
    expect(tenantLabel('974760673', undefined, translator('en'))).toBe('Org. no. 974 760 673');
  });
});
