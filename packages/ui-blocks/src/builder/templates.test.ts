import { describe, expect, it } from 'vitest';
import { blockSpec, looks, zones } from './catalogue.js';
import {
  blocksIn,
  layoutProblems,
  lookOf,
  optionInForce,
  placedAt,
  settingsOf,
  templateLook,
  turnOff,
  withLook,
} from './layout.js';
import { en, nb } from '../i18n.js';
import {
  changeTemplate,
  fromTemplate,
  lookKey,
  templateIds,
  templates,
  templateSetups,
} from './templates.js';

describe('the templates', () => {
  it('are the design’s eight, in its order, with Kunnskapsassistenten’s next look after it', () => {
    expect(templateIds).toEqual([
      'knowledge-assistant',
      'knowledge-assistant-next',
      'sources-only',
      'approach-only',
      'without-filter',
      'with-projects',
      'without-secondary',
      'without-primary',
      'chat-only',
    ]);
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

  it('give Kunnskapsassistenten’s next look the same blocks, with Approach also as the tool', () => {
    const next = templates['knowledge-assistant-next'];
    const today = templates['knowledge-assistant'];
    expect(next.primary).toEqual(today.primary);
    expect(next.main).toEqual(today.main);
    expect(next.secondary).toEqual(['approach', ...today.secondary]);
    expect(placedAt(fromTemplate('knowledge-assistant-next').layout, 'approach')).toBe('both');
  });

  it('draw the dev boards’ look only for knowledge-assistant-next, and today’s for the rest', () => {
    expect(templateLook('knowledge-assistant-next')).toBe('next');
    for (const id of templateIds.filter((one) => one !== 'knowledge-assistant-next')) {
      expect(templateLook(id), id).toBe('current');
      expect(lookOf(fromTemplate(id).layout), id).toBe('current');
    }
    expect(templateLook(undefined)).toBe('current');
    expect(lookOf(fromTemplate('knowledge-assistant-next').layout)).toBe('next');
  });

  it('store the next look in a layout from knowledge-assistant-next, and no look in the others', () => {
    expect(fromTemplate('knowledge-assistant-next').layout.look).toBe('next');
    for (const id of templateIds.filter((one) => one !== 'knowledge-assistant-next'))
      expect(fromTemplate(id).layout, id).not.toHaveProperty('look');
  });

  it('turn feedback on and follow-ups off in knowledge-assistant-next, as kunnskapsassistenten’s next client runs', () => {
    const { layout } = fromTemplate('knowledge-assistant-next');
    expect(settingsOf(layout, 'chat')).toMatchObject({ feedback: true, followUps: false });
    expect(optionInForce(layout, 'chat', 'feedback')).toBe(true);
    expect(optionInForce(layout, 'chat', 'followUps')).toBe(false);
    // «Kunnskapsassistenten» keeps the catalogue's defaults.
    const today = fromTemplate('knowledge-assistant').layout;
    expect(settingsOf(today, 'chat')).toMatchObject({ feedback: false, followUps: true });
  });

  it('keep Approach at the standard level in knowledge-assistant-next, its tool the detailed one by its place', () => {
    expect(settingsOf(fromTemplate('knowledge-assistant-next').layout, 'approach').level).toBe(
      'standard',
    );
  });

  it('set only options that differ from the catalogue’s defaults, and only for blocks the template places', () => {
    for (const [id, setup] of Object.entries(templateSetups))
      for (const [block, settings] of Object.entries(setup.settings ?? {})) {
        const placed = Object.values(templates[id as keyof typeof templates]).flat();
        expect(placed, `${id}: ${block}`).toContain(block);
        for (const [option, value] of Object.entries(settings ?? {})) {
          const spec = blockSpec(block as never).options.find((one) => one.id === option);
          expect(spec, `${id}: ${block}.${option}`).toBeDefined();
          expect(value, `${id}: ${block}.${option}`).not.toBe(spec?.default);
        }
      }
  });

  it('keep the look when another template without a look of its own is chosen', () => {
    const next = fromTemplate('knowledge-assistant-next');
    const changed = changeTemplate(next, 'sources-only');
    expect(lookOf(changed.layout)).toBe('next');
    expect(blocksIn(changed.layout, 'secondary')).toEqual(['sources']);
    const today = changeTemplate(fromTemplate('chat-only'), 'sources-only');
    expect(today).toEqual(fromTemplate('sources-only'));
  });

  it('take the look of a template that sets one, whatever look the layout had', () => {
    const current = withLook(fromTemplate('chat-only'), 'current');
    expect(lookOf(changeTemplate(current, 'knowledge-assistant-next').layout)).toBe('next');
  });

  it('keep a chosen look through turning blocks off, and let it differ from the template’s', () => {
    const chosen = withLook(fromTemplate('without-filter'), 'next');
    expect(lookOf(turnOff(chosen, 'sources').layout)).toBe('next');
    expect(lookOf(withLook(fromTemplate('knowledge-assistant-next'), 'current').layout)).toBe(
      'current',
    );
  });

  it('name every look in both languages', () => {
    for (const look of looks) {
      const name = lookKey(look).slice('builder.'.length);
      expect(name in nb.builder && name in en.builder, look).toBe(true);
    }
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
