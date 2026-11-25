import { describe, expect, it } from 'vitest';
import { availableSections, locate, serviceTabs } from './sections';

const at = (path: string, isNew: boolean) =>
  locate(
    'utkast-1',
    path.split('/').filter(Boolean),
    new URLSearchParams(),
    availableSections({ isNew }),
  );

describe('the Avansert tab of a service not published yet', () => {
  it('gives a new service the tabs Oppsett, Utforming and Avansert', () => {
    expect(serviceTabs(availableSections({ isNew: true })).map((t) => t.tab)).toEqual([
      'setup',
      'interface',
      'advanced',
    ]);
  });

  it('keeps Avansert away from a published service, which keeps Teknisk', () => {
    const tabs = serviceTabs(availableSections({ isNew: false })).map((t) => t.tab);
    expect(tabs).not.toContain('advanced');
    expect(tabs).toContain('developer');
  });

  it('opens a part of Avansert from its address', () => {
    expect(at('/services/utkast-1/advanced/yaml', true)).toEqual({
      section: 'advanced',
      detail: 'yaml',
    });
  });

  it.each([
    ['/services/utkast-1/channels', '/services/utkast-1/advanced/channels'],
    ['/services/utkast-1/definition', '/services/utkast-1/advanced/yaml'],
    ['/services/utkast-1/settings', '/services/utkast-1/advanced/limits'],
    ['/services/utkast-1/setup/tools', '/services/utkast-1/advanced/tools'],
    ['/services/utkast-1/setup/variants', '/services/utkast-1/advanced/variants'],
  ])('sends the old address %s of a new service to %s', (from, to) => {
    expect(at(from, true).redirect).toBe(to);
  });

  it('sends the risk level and the safety rules of a new service to the publish page', () => {
    expect(at('/services/utkast-1/setup/risk', true).redirect).toBe(
      '/services/utkast-1/setup/publish',
    );
    expect(at('/services/utkast-1/setup/guards', true).redirect).toBe(
      '/services/utkast-1/setup/publish',
    );
  });

  it('leaves the old addresses of a published service where they were', () => {
    expect(at('/services/utkast-1/channels', false)).toEqual({
      section: 'channels',
      detail: undefined,
    });
    expect(at('/services/utkast-1/setup/tools', false)).toEqual({
      section: 'setup',
      detail: 'tools',
    });
  });

  it('sends a published service away from Avansert, which it does not have', () => {
    expect(at('/services/utkast-1/advanced', false).redirect).toBe('/services/utkast-1');
  });
});
