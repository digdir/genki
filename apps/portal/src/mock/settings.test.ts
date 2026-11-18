import { describe, expect, it } from 'vitest';
import { mockFetch } from '../mock';

const catalogue = async () => {
  const response = await mockFetch()('http://localhost/api/settings');
  return ((await response.json()) as { data: { key: string }[] }).data.map((s) => s.key);
};

describe('settings mock', () => {
  it('serves no answers.showSources, which the real settings catalogue does not hold yet', async () => {
    expect(await catalogue()).not.toContain('answers.showSources');
  });
});
