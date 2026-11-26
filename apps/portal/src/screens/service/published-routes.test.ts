import { describe, expect, it } from 'vitest';
import { availableSections, locate } from './sections';

const at = (path: string, query = '') => {
  const [route = '', search = query] = path.split('?');
  return locate(
    'rapport',
    route.split('/').filter(Boolean),
    new URLSearchParams(search),
    availableSections({ isNew: false }),
  );
};

describe('the old addresses of a published service', () => {
  it('sends /setup/risk and /setup/guards of a published service to its publish page', () => {
    expect(at('/services/rapport/setup/risk').redirect).toBe('/services/rapport/setup/publish');
    expect(at('/services/rapport/setup/guards').redirect).toBe('/services/rapport/setup/publish');
  });

  it('sends /channels/<frontend> to the same client under Avansert → Kanaler', () => {
    expect(at('/services/rapport/channels/web')).toEqual({
      section: 'advanced',
      detail: 'channels/web',
      redirect: '/services/rapport/advanced/channels/web',
    });
    expect(at('/services/rapport/channels').redirect).toBe('/services/rapport/advanced/channels');
  });

  it('sends /setup/start, where the channels were, to Avansert → Kanaler', () => {
    expect(at('/services/rapport/setup/start').redirect).toBe(
      '/services/rapport/advanced/channels',
    );
  });

  it('sends /settings of a published service to Avansert → Grenser', () => {
    expect(at('/services/rapport/settings').redirect).toBe('/services/rapport/advanced/limits');
  });

  it('sends /definition and versions?view=yaml to Avansert → YAML', () => {
    expect(at('/services/rapport/definition').redirect).toBe('/services/rapport/advanced/yaml');
    expect(at('/services/rapport/versions?view=yaml').redirect).toBe(
      '/services/rapport/advanced/yaml',
    );
  });

  it('sends ?tab=oppsett to the one-form Oppsett', () => {
    expect(at('/services/rapport?tab=oppsett')).toEqual({
      section: 'setup',
      detail: undefined,
      redirect: '/services/rapport/setup',
    });
  });

  it('keeps the client of an Avansert → Kanaler address as its detail', () => {
    expect(at('/services/rapport/advanced/channels/web')).toEqual({
      section: 'advanced',
      detail: 'channels/web',
    });
  });

  it('sends /how-it-works to Avansert → Arbeidsmåte', () => {
    expect(at('/services/rapport/how-it-works').redirect).toBe('/services/rapport/advanced/how');
  });
});
