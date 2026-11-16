import { describe, expect, it } from 'vitest';
import { availableSections, locate, tabSections } from './sections';

describe('service tabs', () => {
  it('leaves the test and definition pages out of a new service tabs but keeps their addresses', () => {
    expect(tabSections({ isNew: true })).toEqual(['setup', 'interface', 'advanced', 'developer']);
    const at = locate(
      'new',
      ['services', 'new', 'versions'],
      new URLSearchParams(),
      availableSections({ isNew: true }),
    );
    expect(at.section).toBe('versions');
    expect(at.redirect).toBeUndefined();
    const test = locate(
      'new',
      ['services', 'new', 'test'],
      new URLSearchParams(),
      availableSections({ isNew: true }),
    );
    expect(test.section).toBe('test');
    expect(test.redirect).toBeUndefined();
  });

  it('keeps how the service works in setup, where the owner sets it up', () => {
    const at = locate(
      'rapport',
      ['services', 'rapport', 'setup', 'how'],
      new URLSearchParams('pane=assistent'),
      availableSections({ isNew: false }),
    );
    expect(at.section).toBe('setup');
    expect(at.redirect).toBeUndefined();
  });

  it('leaves the safety filters of a new service in setup', () => {
    const at = locate(
      'new',
      ['services', 'new', 'setup', 'guards'],
      new URLSearchParams(),
      availableSections({ isNew: true }),
    );
    expect(at.section).toBe('setup');
    expect(at.redirect).toBeUndefined();
  });

  it('shows the interface for every service and advanced settings only while it is new', () => {
    expect(tabSections({ isNew: false })).toContain('interface');
    expect(tabSections({ isNew: false })).not.toContain('advanced');
    expect(tabSections({ isNew: false })).toContain('developer');
  });

  it('keeps versions and the log inside the developer tab, at their old addresses', () => {
    expect(tabSections({ isNew: false })).not.toContain('versions');
    expect(tabSections({ isNew: false })).not.toContain('log');
    expect(availableSections({ isNew: false })).toEqual(
      expect.arrayContaining(['versions', 'log']),
    );
  });
});
