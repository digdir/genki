import { describe, expect, it } from 'vitest';
import { blockSpec, zones } from './catalogue.js';
import { blocksIn, layoutProblems } from './layout.js';
import { fromTemplate, templateIds, templates } from './templates.js';

describe('the templates', () => {
  it('are the design’s eight in its order, then the portal builder’s two the design lacks', () => {
    expect(templateIds).toEqual([
      'knowledge-assistant',
      'sources-only',
      'approach-only',
      'without-filter',
      'with-projects',
      'without-secondary',
      'without-primary',
      'chat-only',
      'document-focus',
      'notes-focus',
    ]);
  });

  it('put Document view in the content with Chat and Sources in the right panel in «Dokumentvisning i fokus»', () => {
    const { layout } = fromTemplate('document-focus');
    expect(blocksIn(layout, 'primary')).toEqual([]);
    expect(blocksIn(layout, 'main')).toEqual(['document-view']);
    expect(blocksIn(layout, 'secondary')).toEqual(['chat', 'sources']);
  });

  it('leave Projects and Notes out of «Notater i fokus» until they are built, and keep Threads and Chat', () => {
    expect(templates['notes-focus'].primary).toEqual(['projects', 'threads']);
    expect(templates['notes-focus'].secondary).toEqual(['notes']);
    const { layout } = fromTemplate('notes-focus');
    expect(blocksIn(layout, 'primary')).toEqual(['threads']);
    expect(blocksIn(layout, 'main')).toEqual(['chat']);
    expect(blocksIn(layout, 'secondary')).toEqual([]);
  });

  it('put every block only in a zone it may stand in', () => {
    for (const id of templateIds)
      for (const zone of zones)
        for (const block of templates[id][zone])
          expect(blockSpec(block).zones, `${id}: ${block}`).toContain(zone);
  });

  it('build a layout with no problems, leaving out the blocks that are not built', () => {
    for (const id of templateIds) {
      const { layout } = fromTemplate(id);
      expect(
        layoutProblems(layout, () => true),
        id,
      ).toEqual([]);
      expect(layout.template).toBe(id);
    }
  });

  it('give Kunnskapsassistenten threads, filter and settings, approach and chat, and the sources, with no document view, as it has none', () => {
    const { layout } = fromTemplate('knowledge-assistant');
    expect(blocksIn(layout, 'primary')).toEqual(['threads', 'filter', 'settings']);
    expect(blocksIn(layout, 'main')).toEqual(['approach', 'chat']);
    expect(blocksIn(layout, 'secondary')).toEqual(['sources']);
  });

  it('put Approach in the secondary panel in «Bare fremgangsmåte»', () => {
    const { layout } = fromTemplate('approach-only');
    expect(blocksIn(layout, 'secondary')).toEqual(['approach']);
    expect(blocksIn(layout, 'main')).toEqual(['chat']);
  });

  it('leave both panels empty in «Bare chat»', () => {
    const { layout } = fromTemplate('chat-only');
    expect(blocksIn(layout, 'primary')).toEqual([]);
    expect(blocksIn(layout, 'secondary')).toEqual([]);
  });

  it('leave out the blocks the service is not offered', () => {
    const { layout } = fromTemplate('knowledge-assistant', (block) => block !== 'filter');
    expect(blocksIn(layout, 'primary')).toEqual(['threads', 'settings']);
  });
});
