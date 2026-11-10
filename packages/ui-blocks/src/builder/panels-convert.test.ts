import { describe, expect, it } from 'vitest';
import { blockIds, zones } from './catalogue.js';
import {
  fitService,
  layoutProblems,
  normalised,
  settingsOf,
  withSetting,
  type BuilderState,
} from './layout.js';
import {
  allBlocks,
  blocksIn,
  canvasTemplateOf,
  defaultLayout,
  fromBuilderState,
  moveTo,
  panels,
  templateIds,
  templates,
  toBuilderState,
  toCatalogueId,
  toPanel,
  toPanelId,
  toZone,
  turnOff,
  turnOn,
  type BlockLayout,
} from './panels.js';
import { fromTemplate, templateIds as canvasTemplateIds } from './templates.js';

const empty: BlockLayout = { placed: {}, chosen: {} };

const portalLayouts: [string, BlockLayout][] = [
  ['empty', empty],
  ['the default', defaultLayout],
  ...templateIds.map((id): [string, BlockLayout] => [id, templates[id]]),
  [
    'Chat moved to the right and turned off',
    turnOff(moveTo(turnOn(empty, 'chat'), 'chat', 'right'), 'chat'),
  ],
  ['Filter chosen for the middle while off', moveTo(empty, 'filter', 'main')],
  ['blocks that are «kommer»', { placed: { projects: 'left', notes: 'right' }, chosen: {} }],
];

const canvasStates: [string, BuilderState][] = canvasTemplateIds.map((id) => [
  id,
  fromTemplate(id),
]);

describe('the names on either side of the border', () => {
  it('calls the left panel primary, the middle main and the right panel secondary, both ways', () => {
    expect(panels.map(toZone)).toEqual(['primary', 'main', 'secondary']);
    for (const zone of zones) expect(toZone(toPanel(zone))).toBe(zone);
  });

  it('calls procedure approach and documentView document-view, and every other block the same', () => {
    expect(toCatalogueId('procedure')).toBe('approach');
    expect(toCatalogueId('documentView')).toBe('document-view');
    for (const id of allBlocks.filter((b) => b !== 'procedure' && b !== 'documentView'))
      expect(toCatalogueId(id)).toBe(id);
    for (const id of blockIds) expect(toCatalogueId(toPanelId(id))).toBe(id);
  });
});

describe('a layout through the border and back', () => {
  it.each(portalLayouts)(
    'keeps every block in its panel and every chosen place for #210’s layout: %s',
    (_, layout) => {
      expect(fromBuilderState(toBuilderState(layout))).toEqual(layout);
    },
  );

  it.each(canvasStates)(
    'keeps every block, its options and the template when the state goes along: %s',
    (_, start) => {
      const state = withSetting(start, 'chat', 'footnotes', false);
      expect(toBuilderState(fromBuilderState(state), state)).toEqual(state);
    },
  );

  it('loses a block’s options and the template without the state, which #210’s shape has no room for', () => {
    const state = withSetting(fromTemplate('without-filter'), 'chat', 'footnotes', false);
    const back = toBuilderState(fromBuilderState(state));
    expect(back.layout.zones).toEqual(fromTemplate('without-filter').layout.zones);
    expect(back.layout.template).toBeUndefined();
    expect(settingsOf(back.layout, 'chat').footnotes).toBe(true);
  });

  it('keeps a block’s options when #210’s rules move it to another panel', () => {
    const state = withSetting(fromTemplate('without-filter'), 'chat', 'footnotes', false);
    const moved = toBuilderState(moveTo(fromBuilderState(state), 'chat', 'right'), state);
    expect(blocksIn(fromBuilderState(moved), 'right')).toContain('chat');
    expect(settingsOf(moved.layout, 'chat').footnotes).toBe(false);
  });

  it('orders each zone by the catalogue, whatever order #210’s record lists the blocks in', () => {
    const state = toBuilderState({
      placed: { chat: 'main', documentView: 'main', procedure: 'main', filter: 'main' },
      chosen: {},
    });
    expect(state.layout).toEqual(normalised(state.layout));
    expect(state.layout.zones.main.map((p) => p.block)).toEqual([
      'approach',
      'filter',
      'chat',
      'document-view',
    ]);
  });

  it('puts a held block back with its options when #210’s layout turns it on, and keeps the others held', () => {
    const start = withSetting(fromTemplate('without-filter'), 'sources', 'search', false);
    const away = fitService(start, (id) => id !== 'sources' && id !== 'approach').state;
    const back = toBuilderState(turnOn(fromBuilderState(away), 'sources'), away);
    expect(settingsOf(back.layout, 'sources').search).toBe(false);
    expect(back.held?.map((entry) => entry.placed.block)).toEqual(['approach']);
  });
});

describe('where the two builders differ', () => {
  it('builds four of #210’s templates exactly as the canvas’s', () => {
    for (const [id, canvas] of Object.entries(canvasTemplateOf))
      expect(toBuilderState(templates[id as keyof typeof templates]).layout.zones).toEqual(
        fromTemplate(canvas).layout.zones,
      );
    expect(Object.keys(canvasTemplateOf)).toEqual([
      'sourcesFocus',
      'procedureFocus',
      'noRight',
      'chatOnly',
    ]);
  });

  it('has Dokumentvisning in the canvas’s templates without Filter and without the left panel, and not in #210’s', () => {
    const withoutDocument = (state: BuilderState) =>
      turnOff(fromBuilderState(state), 'documentView').placed;
    expect(withoutDocument(fromTemplate('without-filter'))).toEqual(templates.classic.placed);
    expect(withoutDocument(fromTemplate('without-primary'))).toEqual(templates.noLeft.placed);
  });

  it('holds a block that is not built, and the checks report it', () => {
    const state = toBuilderState({ placed: { projects: 'left', notes: 'right' }, chosen: {} });
    expect(layoutProblems(state.layout)).toEqual([
      { rule: 'not-built', block: 'projects' },
      { rule: 'not-built', block: 'notes' },
    ]);
  });

  it('lists a block placed where it may not stand, as the checks report it, where #210 lists it nowhere', () => {
    const misplaced: BlockLayout = { placed: { sources: 'main' }, chosen: {} };
    expect(blocksIn(misplaced, 'main')).toEqual(['sources']);
    expect(layoutProblems(toBuilderState(misplaced).layout)).toContainEqual({
      rule: 'zone-not-allowed',
      block: 'sources',
      zone: 'main',
    });
  });
});
