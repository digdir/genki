import { describe, expect, it } from 'vitest';
import {
  blockPanels,
  blocksAllowedIn,
  blocksIn,
  defaultLayout,
  isOn,
  moveTo,
  panels,
  placeIn,
  placeOf,
  rightPanelMode,
  templateIds,
  templates,
  turnOff,
  turnOn,
  type BlockLayout,
} from './rules';

const empty: BlockLayout = { placed: {}, chosen: {} };

describe('building block rules', () => {
  it('places Chat in the middle, Document view on the right and Footnotes in the middle by default', () => {
    expect(placeOf(empty, 'chat')).toBe('main');
    expect(placeOf(empty, 'documentView')).toBe('right');
    expect(placeOf(empty, 'footnotes')).toBe('main');
  });

  it('keeps the panel order fixed whatever order the blocks are turned on in', () => {
    const one = turnOn(turnOn(turnOn(empty, 'settings'), 'threads'), 'projects');
    const two = turnOn(turnOn(turnOn(empty, 'projects'), 'settings'), 'threads');
    expect(blocksIn(one, 'left')).toEqual(['projects', 'threads', 'settings']);
    expect(blocksIn(two, 'left')).toEqual(['projects', 'threads', 'settings']);
  });

  it('puts a left Filter under Threads and above Settings', () => {
    const layout = turnOn(turnOn(turnOn(empty, 'settings'), 'filter'), 'threads');
    expect(blocksIn(layout, 'left')).toEqual(['threads', 'filter', 'settings']);
  });

  it('orders the middle as procedure, filter, chat, footnotes, document view', () => {
    let layout = empty;
    for (const id of ['documentView', 'footnotes', 'chat', 'filter', 'procedure'] as const)
      layout = moveTo(turnOn(layout, id), id, 'main');
    expect(blocksIn(layout, 'main')).toEqual([
      'procedure',
      'filter',
      'chat',
      'footnotes',
      'documentView',
    ]);
  });

  it('orders the right panel with sources after chat and notes last', () => {
    let layout = turnOn(turnOn(empty, 'notes'), 'sources');
    for (const id of ['documentView', 'chat', 'procedure', 'footnotes'] as const)
      layout = moveTo(turnOn(layout, id), id, 'right');
    expect(blocksIn(layout, 'right')).toEqual([
      'procedure',
      'chat',
      'sources',
      'footnotes',
      'documentView',
      'notes',
    ]);
  });

  it('keeps a block in one panel at a time', () => {
    const layout = moveTo(turnOn(empty, 'chat'), 'chat', 'right');
    expect(blocksIn(layout, 'main')).not.toContain('chat');
    expect(blocksIn(layout, 'right')).toContain('chat');
  });

  it('refuses to move a block to a panel it cannot stand in', () => {
    const layout = turnOn(empty, 'sources');
    expect(moveTo(layout, 'sources', 'main')).toBe(layout);
    expect(moveTo(turnOn(empty, 'filter'), 'filter', 'right').placed.filter).toBe('left');
  });

  it('remembers where a flexible block stood after it is turned off and on again', () => {
    const moved = moveTo(turnOn(empty, 'chat'), 'chat', 'right');
    const off = turnOff(moved, 'chat');
    expect(isOn(off, 'chat')).toBe(false);
    expect(turnOn(off, 'chat').placed.chat).toBe('right');
  });

  it('remembers the chosen place for a block that is off', () => {
    const chosen = moveTo(empty, 'filter', 'main');
    expect(isOn(chosen, 'filter')).toBe(false);
    expect(turnOn(chosen, 'filter').placed.filter).toBe('main');
  });

  it('shows one tool in the right panel as a heading, two as tabs and three or more as a dropdown', () => {
    expect(rightPanelMode(0)).toBe('none');
    expect(rightPanelMode(1)).toBe('heading');
    expect(rightPanelMode(2)).toBe('tabs');
    expect(rightPanelMode(3)).toBe('dropdown');
    expect(rightPanelMode(6)).toBe('dropdown');
  });

  it('builds every template only from places the blocks may stand in', () => {
    for (const id of templateIds)
      for (const [block, panel] of Object.entries(templates[id].placed))
        expect(blockPanels[block as keyof typeof blockPanels]).toContain(panel);
  });

  it('starts from the full template', () => {
    for (const panel of panels)
      expect(blocksIn(defaultLayout, panel)).toEqual(blocksIn(templates.full, panel));
  });

  it('lists every block that may stand in a panel, in the panel order', () => {
    expect(blocksAllowedIn('left')).toEqual(['projects', 'threads', 'filter', 'settings']);
    expect(blocksAllowedIn('main')).toEqual([
      'procedure',
      'filter',
      'chat',
      'footnotes',
      'documentView',
    ]);
    expect(blocksAllowedIn('right')).toEqual([
      'procedure',
      'chat',
      'sources',
      'footnotes',
      'documentView',
      'notes',
    ]);
  });

  it('places a block in the chosen panel and takes it out of the other', () => {
    const inMiddle = placeIn(empty, 'chat', 'main');
    expect(blocksIn(inMiddle, 'main')).toContain('chat');
    const inRight = placeIn(inMiddle, 'chat', 'right');
    expect(blocksIn(inRight, 'right')).toContain('chat');
    expect(blocksIn(inRight, 'main')).not.toContain('chat');
    expect(placeIn(empty, 'sources', 'main')).toBe(empty);
  });
});
