import { describe, expect, it } from 'vitest';
import { blocksAllowedIn, type BlockId, type Zone } from './catalogue.js';
import {
  blocksIn,
  defaultLayout,
  emptyLayout,
  fitService,
  isAssistantLayout,
  isOn,
  layoutProblems,
  lookOf,
  moveTo,
  normalised,
  optionInForce,
  placedAt,
  placeIn,
  placeOf,
  settingsOf,
  toolMode,
  turnOff,
  turnOn,
  withLook,
  withSetting,
  zoneOf,
  zonesOf,
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
    expect(blocksIn(defaultLayout, 'secondary')).toEqual(['sources', 'document-view']);
  });
});

describe('Approach in both its zones', () => {
  const saved = (zones: Partial<AssistantLayout['zones']>): AssistantLayout => ({
    version: 1,
    zones: { primary: [], main: [], secondary: [], ...zones },
  });

  it('puts Approach in both the main column and the secondary panel', () => {
    const state = placeIn(empty, 'approach', 'both');
    expect(blocksIn(state.layout, 'main')).toEqual(['approach']);
    expect(blocksIn(state.layout, 'secondary')).toEqual(['approach']);
    expect(placedAt(state.layout, 'approach')).toBe('both');
    expect(zonesOf(state.layout, 'approach')).toEqual(['main', 'secondary']);
    expect(layoutProblems(state.layout)).toEqual([]);
  });

  it('moves Approach from both places to one, and from one to both', () => {
    const both = placeIn(empty, 'approach', 'both');
    const tool = moveTo(both, 'approach', 'secondary');
    expect(placedAt(tool.layout, 'approach')).toBe('secondary');
    expect(blocksIn(tool.layout, 'main')).toEqual([]);
    expect(placedAt(moveTo(tool, 'approach', 'both').layout, 'approach')).toBe('both');
  });

  it('refuses both for a block that stands in one zone at a time', () => {
    const chat = turnOn(empty, 'chat');
    expect(moveTo(chat, 'chat', 'both')).toBe(chat);
    expect(placeIn(empty, 'chat', 'both')).toBe(empty);
  });

  it('remembers both places when Approach is turned off and on again', () => {
    const off = turnOff(placeIn(empty, 'approach', 'both'), 'approach');
    expect(isOn(off.layout, 'approach')).toBe(false);
    expect(placeOf(off, 'approach')).toBe('both');
    expect(placedAt(turnOn(off, 'approach').layout, 'approach')).toBe('both');
  });

  it('keeps one set of options for Approach in both its zones, alike in each', () => {
    const both = moveTo(
      withSetting(turnOn(empty, 'approach'), 'approach', 'level', 'detailed'),
      'approach',
      'both',
    );
    expect(both.layout.zones.main).toEqual([
      { block: 'approach', settings: { level: 'detailed' } },
    ]);
    expect(both.layout.zones.secondary).toEqual(both.layout.zones.main);
    const back = withSetting(both, 'approach', 'level', 'standard');
    expect(back.layout.zones.main).toEqual([{ block: 'approach' }]);
    expect(back.layout.zones.secondary).toEqual([{ block: 'approach' }]);
  });

  it('reads a saved layout with Approach in one zone as it did before', () => {
    const card = saved({ main: [{ block: 'approach' }, { block: 'chat' }] });
    const tool = saved({ main: [{ block: 'chat' }], secondary: [{ block: 'approach' }] });
    expect(placedAt(card, 'approach')).toBe('main');
    expect(zonesOf(card, 'approach')).toEqual(['main']);
    expect(placedAt(tool, 'approach')).toBe('secondary');
    expect(layoutProblems(card)).toEqual([]);
    expect(layoutProblems(tool)).toEqual([]);
  });

  it('finds Approach placed twice in one zone, though it may stand in both', () => {
    expect(
      layoutProblems(saved({ main: [{ block: 'approach' }, { block: 'approach' }] })),
    ).toContainEqual({ rule: 'placed-twice', block: 'approach' });
  });

  it('holds Approach in both places through a service without steps, and puts it back in both', () => {
    const both: BuilderState = placeIn({ layout: defaultLayout, chosen: {} }, 'approach', 'both');
    const away = fitService(both, (id) => id !== 'approach');
    expect(away.dropped).toEqual(['approach']);
    expect(isOn(away.state.layout, 'approach')).toBe(false);
    const back = fitService(away.state, () => true);
    expect(back.restored).toEqual(['approach']);
    expect(placedAt(back.state.layout, 'approach')).toBe('both');
    expect(back.state.layout).toEqual(both.layout);
    expect(back.state.held).toBeUndefined();
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

  it('puts follow-ups in force only in the current look, since the next look draws none', () => {
    const chat = turnOn(empty, 'chat');
    expect(optionInForce(chat.layout, 'chat', 'followUps')).toBe(true);
    expect(optionInForce(withLook(chat, 'next').layout, 'chat', 'followUps')).toBe(false);
    const stored = { ...chat.layout, template: 'knowledge-assistant-next' };
    expect(optionInForce(stored, 'chat', 'followUps')).toBe(false);
  });
});

describe('the look of a layout', () => {
  it('draws a layout without a look in its template’s, as before the look was a setting', () => {
    expect(lookOf({ ...emptyLayout, template: 'knowledge-assistant-next' })).toBe('next');
    expect(lookOf({ ...emptyLayout, template: 'knowledge-assistant' })).toBe('current');
    expect(lookOf(emptyLayout)).toBe('current');
  });

  it('draws a layout in its own look, whatever its template', () => {
    expect(lookOf({ ...emptyLayout, template: 'chat-only', look: 'next' })).toBe('next');
    expect(lookOf({ ...emptyLayout, template: 'knowledge-assistant-next', look: 'current' })).toBe(
      'current',
    );
  });

  it('keeps the look through every change to the blocks and their options', () => {
    let state = withLook(empty, 'next');
    state = on(state, 'chat', 'sources', 'filter');
    state = moveTo(state, 'filter', 'main');
    state = turnOff(state, 'sources');
    state = withSetting(state, 'chat', 'copy', false);
    state = fitService(state, (id) => id !== 'filter').state;
    expect(state.layout.look).toBe('next');
    expect(normalised(state.layout).look).toBe('next');
  });

  it('reads a stored layout with a known look, and refuses one with a look it does not know', () => {
    expect(isAssistantLayout({ ...emptyLayout, look: 'next' })).toBe(true);
    expect(isAssistantLayout({ ...emptyLayout, look: 'current' })).toBe(true);
    expect(isAssistantLayout(emptyLayout)).toBe(true);
    expect(isAssistantLayout({ ...emptyLayout, look: 'shiny' })).toBe(false);
    expect(isAssistantLayout({ ...emptyLayout, look: 1 })).toBe(false);
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

  it('finds Footnotes turned on with neither Sources nor Document view', () => {
    expect(
      layoutProblems(layout({ main: [{ block: 'chat', settings: { footnotes: true } }] })),
    ).toContainEqual({
      rule: 'missing-partner',
      block: 'chat',
      option: 'footnotes',
      partner: 'sources',
      need: 'component:sources|document-view',
    });
  });

  it('lets Document view stand without Sources, and Footnotes point to it there', () => {
    const withView = layout({
      main: [{ block: 'chat', settings: { footnotes: true } }],
      secondary: [{ block: 'document-view' }],
    });
    expect(layoutProblems(withView)).toEqual([]);
    expect(optionInForce(withView, 'chat', 'footnotes')).toBe(true);
    const neither = layout({ main: [{ block: 'chat' }] });
    expect(optionInForce(neither, 'chat', 'footnotes')).toBe(false);
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

describe('a change of service', () => {
  const start: BuilderState = { layout: defaultLayout, chosen: {} };
  const chatless = (id: BlockId) => !['chat', 'filter', 'sources', 'document-view'].includes(id);
  const everything = () => true;

  it('turns off the blocks the service cannot back, and says which', () => {
    const { state, dropped, restored } = fitService(start, chatless);
    expect(dropped).toEqual(['filter', 'chat', 'sources', 'document-view']);
    expect(restored).toEqual([]);
    for (const id of dropped) expect(isOn(state.layout, id), id).toBe(false);
    expect(isOn(state.layout, 'threads')).toBe(true);
  });

  it('puts them back where they stood, with their options, when a later service can back them', () => {
    const set = withSetting(moveTo(start, 'chat', 'secondary'), 'chat', 'copy', false);
    const away = fitService(set, chatless).state;
    const { state, dropped, restored } = fitService(away, everything);
    expect(dropped).toEqual([]);
    expect(restored).toEqual(['filter', 'chat', 'sources', 'document-view']);
    expect(zoneOf(state.layout, 'chat')).toBe('secondary');
    expect(settingsOf(state.layout, 'chat').copy).toBe(false);
    expect(state.layout).toEqual(set.layout);
    expect(state.held).toBeUndefined();
  });

  it('holds a block through a service that cannot back it either, until one can', () => {
    const noSources = (id: BlockId) => id !== 'sources';
    const away = fitService(start, chatless).state;
    const still = fitService(away, noSources);
    expect(still.restored).toEqual(['filter', 'chat', 'document-view']);
    expect(isOn(still.state.layout, 'sources')).toBe(false);
    expect(fitService(still.state, everything).restored).toEqual(['sources']);
  });

  it('leaves off a block the reader turned off by hand', () => {
    const byHand = turnOff(start, 'approach');
    const back = fitService(fitService(byHand, chatless).state, everything).state;
    expect(isOn(back.layout, 'approach')).toBe(false);
  });

  it('holds a block only where it stood last when a service drops it again', () => {
    const away = fitService(start, chatless).state;
    const movedByHand = moveTo(turnOn(away, 'chat'), 'chat', 'secondary');
    const again = fitService(movedByHand, chatless).state;
    const back = fitService(again, everything).state;
    expect(zonesOf(back.layout, 'chat')).toEqual(['secondary']);
    expect(layoutProblems(back.layout)).toEqual([]);
  });

  it('keeps what it holds while the reader turns other blocks on and off', () => {
    const away = fitService(start, chatless).state;
    const changed = turnOn(turnOff(away, 'approach'), 'approach');
    expect(changed.held).toEqual(away.held);
  });
});
