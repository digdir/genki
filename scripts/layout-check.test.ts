import { describe, expect, it } from 'vitest';
import { sameScreen } from './layout-check.ts';

describe('the layout check crawl', () => {
  it('visits one screen per route shape, not one per id or query', () => {
    expect(sameScreen('#/services/rapportassistenten/log/t1?tab=steps')).toBe(
      '/services/rapportassistenten/log/t1',
    );
    expect(sameScreen('#/datasets/991825827/documents')).toBe('/datasets/:id/documents');
    expect(sameScreen('#/services/kudos-v2')).toBe(sameScreen('#/services/kudos-v3'));
  });
});
