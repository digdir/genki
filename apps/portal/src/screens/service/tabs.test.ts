import { describe, expect, it } from 'vitest';
import { availableSections, locate, tabSections } from './sections';

describe('service tabs', () => {
  it('leaves the test and definition pages out of a new service tabs but keeps their addresses', () => {
    expect(tabSections({ isNew: true })).toEqual(['setup', 'blocks']);
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

  it('shows building blocks only while a service is new', () => {
    expect(tabSections({ isNew: false })).not.toContain('blocks');
    expect(tabSections({ isNew: false })).toContain('versions');
  });
});
