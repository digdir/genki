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

  it('gives a published service Avansert beside Teknisk, which keeps the log and environments', () => {
    const tabs = serviceTabs(availableSections({ isNew: false })).map((t) => t.tab);
    expect(tabs).toContain('advanced');
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

  it('opens a part of Avansert of a published service from its address', () => {
    expect(at('/services/utkast-1/advanced/limits', false)).toEqual({
      section: 'advanced',
      detail: 'limits',
    });
  });
});
