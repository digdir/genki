import { describe, expect, it } from 'vitest';
import { blocksAllowedIn, type BlockId, type Zone } from './catalogue.js';
import {
  blocksIn,
  defaultLayout,
  emptyLayout,
  isOn,
  layoutProblems,
  moveTo,
  normalised,
  optionInForce,
  placeIn,
  placeOf,
  settingsOf,
  toolMode,
  turnOff,
  turnOn,
  withSetting,
  type AssistantLayout,
  type BuilderState,
} from './layout.js';

// Ported from genki #210's rules.test.ts (its builder for new services), with the shell's zone
// names and the catalogue's ids: `left` is `primary`, `right` is `secondary`, `procedure` is
// `approach` and `documentView` is `document-view`.

const empty: BuilderState = { layout: emptyLayout, chosen: {} };
const on = (state: BuilderState, ...ids: BlockId[]) => ids.reduce(turnOn, state);
const moved = (state: BuilderState, zone: Zone, ...ids: BlockId[]) =>
  ids.reduce((s, id) => moveTo(turnOn(s, id), id, zone), state);

describe('the layout rules', () => {
  it('places Chat in the main column and Document view in the secondary panel by default', () => {
    expect(placeOf(empty, 'chat')).toBe('main');
    expect(placeOf(empty, 'document-view')).toBe('secondary');
  });

  it('keeps the zone order fixed whatever order the blocks are turned on in', () => {
    const one = on(empty, 'settings', 'threads', 'projects');
    const two = on(empty, 'projects', 'settings', 'threads');
    expect(blocksIn(one.layout, 'primary')).toEqual(['projects', 'threads', 'settings']);
    expect(blocksIn(two.layout, 'primary')).toEqual(['projects', 'threads', 'settings']);
  });

  it('puts a Filter in the primary panel under Threads and above Settings', () => {
    const layout = on(empty, 'settings', 'filter', 'threads').layout;
    expect(blocksIn(layout, 'primary')).toEqual(['threads', 'filter', 'settings']);
  });

  it('orders the main column as Approach, Filter, Chat, Document view', () => {
    const state = moved(empty, 'main', 'document-view', 'chat', 'filter', 'approach');
    expect(blocksIn(state.layout, 'main')).toEqual(['approach', 'filter', 'chat', 'document-view']);
  });

  it('orders the secondary panel with Sources after Chat and Notes last', () => {
    const state = moved(
      on(empty, 'notes', 'sources'),
      'secondary',
      'document-view',
      'chat',
      'approach',
    );
    expect(blocksIn(state.layout, 'secondary')).toEqual([
      'approach',
      'chat',
      'sources',
      'document-view',
      'notes',
    ]);
  });

  it('keeps a block in one zone at a time', () => {
    const state = moveTo(turnOn(empty, 'chat'), 'chat', 'secondary');
    expect(blocksIn(state.layout, 'main')).not.toContain('chat');
    expect(blocksIn(state.layout, 'secondary')).toContain('chat');
  });

  it('refuses to move a block to a zone it cannot stand in', () => {
    const state = turnOn(empty, 'sources');
    expect(moveTo(state, 'sources', 'main')).toBe(state);
    expect(
      blocksIn(moveTo(turnOn(empty, 'filter'), 'filter', 'secondary').layout, 'primary'),
    ).toEqual(['filter']);
  });

  it('remembers where a movable block stood after it is turned off and on again', () => {
    const off = turnOff(moveTo(turnOn(empty, 'chat'), 'chat', 'secondary'), 'chat');
    expect(isOn(off.layout, 'chat')).toBe(false);
    expect(blocksIn(turnOn(off, 'chat').layout, 'secondary')).toEqual(['chat']);
  });

  it('remembers the zone chosen for a block that is off', () => {
    const chosen = moveTo(empty, 'filter', 'main');
    expect(isOn(chosen.layout, 'filter')).toBe(false);
    expect(blocksIn(turnOn(chosen, 'filter').layout, 'main')).toEqual(['filter']);
  });

  it('shows one tool in the secondary panel as a heading, two as tabs and three or more as a dropdown', () => {
    expect(toolMode(0)).toBe('none');
    expect(toolMode(1)).toBe('heading');
    expect(toolMode(2)).toBe('tabs');
    expect(toolMode(3)).toBe('dropdown');
    expect(toolMode(6)).toBe('dropdown');
  });

  it('lists every block that may stand in a zone, in the zone order', () => {
    expect(blocksAllowedIn('primary')).toEqual(['projects', 'threads', 'filter', 'settings']);
    expect(blocksAllowedIn('main')).toEqual(['approach', 'filter', 'chat', 'document-view']);
    expect(blocksAllowedIn('secondary')).toEqual([
      'approach',
      'chat',
      'sources',
      'document-view',
      'notes',
    ]);
  });

  it('places a block in the chosen zone and takes it out of the other', () => {
    const inMain = placeIn(empty, 'chat', 'main');
    expect(blocksIn(inMain.layout, 'main')).toContain('chat');
    const inSecondary = placeIn(inMain, 'chat', 'secondary');
    expect(blocksIn(inSecondary.layout, 'secondary')).toContain('chat');
    expect(blocksIn(inSecondary.layout, 'main')).not.toContain('chat');
    expect(placeIn(empty, 'sources', 'main')).toBe(empty);
  });

  it('starts from every built block in its default zone, and none that is not built', () => {
    expect(blocksIn(defaultLayout, 'primary')).toEqual(['threads', 'filter', 'settings']);
    expect(blocksIn(defaultLayout, 'main')).toEqual(['approach', 'chat']);
    expect(blocksIn(defaultLayout, 'secondary')).toEqual(['sources']);
  });
});

describe('the options on a block', () => {
  it('fills in the defaults and keeps only what differs from them', () => {
    const state = turnOn(empty, 'chat');
    expect(settingsOf(state.layout, 'chat').footnotes).toBe(true);
    const off = withSetting(state, 'chat', 'suggestions', false);
    expect(off.layout.zones.main).toEqual([{ block: 'chat', settings: { suggestions: false } }]);
    expect(withSetting(off, 'chat', 'suggestions', true).layout.zones.main).toEqual([
      { block: 'chat' },
    ]);
  });

  it('keeps a block’s options when it moves to another zone', () => {
    const state = moveTo(
      withSetting(turnOn(empty, 'chat'), 'chat', 'copy', false),
      'chat',
      'secondary',
    );
    expect(settingsOf(state.layout, 'chat').copy).toBe(false);
  });

  it('puts Footnotes in force only while Sources is placed', () => {
    const chat = turnOn(empty, 'chat');
    expect(optionInForce(chat.layout, 'chat', 'footnotes')).toBe(false);
    expect(optionInForce(turnOn(chat, 'sources').layout, 'chat', 'footnotes')).toBe(true);
  });

  it('never puts an option in force that is not built yet', () => {
    const chat = withSetting(turnOn(empty, 'chat'), 'chat', 'attachments', true);
    expect(optionInForce(chat.layout, 'chat', 'attachments')).toBe(false);
  });
});

describe('the checks on a layout (V2-0006)', () => {
  const layout = (zones: Partial<AssistantLayout['zones']>): AssistantLayout => ({
    version: 1,
    zones: { primary: [], main: [], secondary: [], ...zones },
  });

  it('finds a block the catalogue does not hold', () => {
    const problems = layoutProblems(layout({ main: [{ block: 'map' as BlockId }] }));
    expect(problems).toEqual([{ rule: 'unknown-block', block: 'map', zone: 'main' }]);
  });

  it('finds a block in a zone it may not stand in', () => {
    expect(layoutProblems(layout({ main: [{ block: 'sources' }] }))).toContainEqual({
      rule: 'zone-not-allowed',
      block: 'sources',
      zone: 'main',
    });
  });

  it('finds a block placed twice', () => {
    expect(
      layoutProblems(layout({ main: [{ block: 'chat' }], secondary: [{ block: 'chat' }] })),
    ).toContainEqual({ rule: 'placed-twice', block: 'chat' });
  });

  it('finds a block that is not built yet', () => {
    expect(layoutProblems(layout({ secondary: [{ block: 'notes' }] }))).toContainEqual({
      rule: 'not-built',
      block: 'notes',
    });
  });

  it('finds Document view without Sources, and Footnotes turned on without Sources', () => {
    const problems = layoutProblems(
      layout({
        main: [{ block: 'chat', settings: { footnotes: true } }],
        secondary: [{ block: 'document-view' }],
      }),
    );
    expect(problems).toContainEqual({
      rule: 'missing-partner',
      block: 'document-view',
      partner: 'sources',
    });
    expect(problems).toContainEqual({
      rule: 'missing-partner',
      block: 'chat',
      option: 'footnotes',
      partner: 'sources',
    });
  });

  it('finds the needs the service does not meet, for blocks and for options the layout turns on', () => {
    const turnedOn = layout({
      main: [{ block: 'approach' }, { block: 'chat', settings: { variantPicker: true } }],
    });
    const met = (need: string) => need !== 'service:variants' && need !== 'service:steps';
    expect(layoutProblems(turnedOn, met)).toEqual([
      { rule: 'needs-unmet', block: 'approach', need: 'service:steps' },
      { rule: 'needs-unmet', block: 'chat', option: 'variantPicker', need: 'service:variants' },
    ]);
  });

  it('asks nothing of an option left at its default: it is just not in force', () => {
    const met = (need: string) => need !== 'service:variants';
    expect(layoutProblems(defaultLayout, met)).toEqual([]);
    expect(optionInForce(defaultLayout, 'chat', 'variantPicker', met)).toBe(false);
    expect(optionInForce(defaultLayout, 'chat', 'copy', met)).toBe(true);
  });

  it('finds nothing wrong with the default layout when every need is met', () => {
    expect(layoutProblems(defaultLayout, () => true)).toEqual([]);
  });

  it('sorts each zone into the catalogue’s order and drops what it does not hold', () => {
    const sorted = normalised(
      layout({ main: [{ block: 'chat' }, { block: 'map' as BlockId }, { block: 'approach' }] }),
    );
    expect(sorted.zones.main).toEqual([{ block: 'approach' }, { block: 'chat' }]);
  });
});
