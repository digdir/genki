export type Panel = 'left' | 'main' | 'right';

export type BlockId =
  | 'projects'
  | 'threads'
  | 'settings'
  | 'chat'
  | 'sources'
  | 'notes'
  | 'filter'
  | 'procedure'
  | 'documentView';

export const panels: Panel[] = ['left', 'main', 'right'];

export const blockPanels: Record<BlockId, Panel[]> = {
  projects: ['left'],
  threads: ['left'],
  settings: ['left'],
  sources: ['right'],
  notes: ['right'],
  chat: ['main', 'right'],
  filter: ['left', 'main'],
  procedure: ['main', 'right'],
  documentView: ['right', 'main'],
};

export const fixedBlocks: Record<Panel, BlockId[]> = {
  left: ['projects', 'threads', 'settings'],
  main: [],
  right: ['sources', 'notes'],
};

export const flexibleBlocks: BlockId[] = ['chat', 'filter', 'procedure', 'documentView'];

export const panelOrder: Record<Panel, BlockId[]> = {
  left: ['projects', 'threads', 'filter', 'settings'],
  main: ['procedure', 'filter', 'chat', 'documentView'],
  right: ['procedure', 'chat', 'sources', 'documentView', 'notes'],
};

export interface BlockLayout {
  placed: Partial<Record<BlockId, Panel>>;
  chosen: Partial<Record<BlockId, Panel>>;
}

export const placeOf = (layout: BlockLayout, id: BlockId): Panel =>
  layout.placed[id] ?? layout.chosen[id] ?? blockPanels[id][0] ?? 'main';

export const isOn = (layout: BlockLayout, id: BlockId) => layout.placed[id] !== undefined;

export const turnOn = (layout: BlockLayout, id: BlockId): BlockLayout => ({
  ...layout,
  placed: { ...layout.placed, [id]: placeOf(layout, id) },
});

export const turnOff = (layout: BlockLayout, id: BlockId): BlockLayout => {
  const at = layout.placed[id];
  return {
    placed: Object.fromEntries(Object.entries(layout.placed).filter(([b]) => b !== id)),
    chosen: at && blockPanels[id].length > 1 ? { ...layout.chosen, [id]: at } : layout.chosen,
  };
};

export const moveTo = (layout: BlockLayout, id: BlockId, panel: Panel): BlockLayout => {
  if (!blockPanels[id].includes(panel)) return layout;
  return {
    placed: isOn(layout, id) ? { ...layout.placed, [id]: panel } : layout.placed,
    chosen: { ...layout.chosen, [id]: panel },
  };
};

export const placeIn = (layout: BlockLayout, id: BlockId, panel: Panel): BlockLayout =>
  blockPanels[id].includes(panel) ? moveTo(turnOn(layout, id), id, panel) : layout;

export const blocksAllowedIn = (panel: Panel): BlockId[] =>
  panelOrder[panel].filter((id) => blockPanels[id].includes(panel));

export const blocksIn = (layout: BlockLayout, panel: Panel): BlockId[] =>
  panelOrder[panel].filter((id) => layout.placed[id] === panel);

export type RightPanelMode = 'none' | 'heading' | 'tabs' | 'dropdown';

export const rightPanelMode = (count: number): RightPanelMode =>
  count === 0 ? 'none' : count === 1 ? 'heading' : count === 2 ? 'tabs' : 'dropdown';

const layoutOf = (placed: Partial<Record<BlockId, Panel>>): BlockLayout => ({ placed, chosen: {} });

export const allBlocks = Object.keys(blockPanels) as BlockId[];

export const defaultLayout: BlockLayout = layoutOf(
  Object.fromEntries(allBlocks.map((id) => [id, blockPanels[id][0] ?? 'main'])),
);

export type TemplateId =
  | 'all'
  | 'sourcesFocus'
  | 'procedureFocus'
  | 'notesFocus'
  | 'documentFocus'
  | 'classic'
  | 'noRight'
  | 'noLeft'
  | 'chatOnly';

export const templates: Record<TemplateId, BlockLayout> = {
  all: defaultLayout,
  sourcesFocus: layoutOf({
    threads: 'left',
    filter: 'left',
    chat: 'main',
    sources: 'right',
  }),
  procedureFocus: layoutOf({ threads: 'left', chat: 'main', procedure: 'right' }),
  notesFocus: layoutOf({ projects: 'left', threads: 'left', chat: 'main', notes: 'right' }),
  documentFocus: layoutOf({
    threads: 'left',
    documentView: 'main',
    chat: 'right',
    sources: 'right',
  }),
  classic: layoutOf({ threads: 'left', procedure: 'main', chat: 'main', sources: 'right' }),
  noRight: layoutOf({ threads: 'left', filter: 'left', procedure: 'main', chat: 'main' }),
  noLeft: layoutOf({ procedure: 'main', chat: 'main', sources: 'right' }),
  chatOnly: layoutOf({ procedure: 'main', chat: 'main' }),
};

export const templateIds = Object.keys(templates) as TemplateId[];
