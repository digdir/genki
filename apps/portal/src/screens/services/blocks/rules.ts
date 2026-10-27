export type Panel = 'left' | 'main' | 'right';

export type BlockId =
  | 'projects'
  | 'threads'
  | 'settings'
  | 'chat'
  | 'sources'
  | 'footnotes'
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
  footnotes: ['main', 'right'],
};

export const fixedBlocks: Record<Panel, BlockId[]> = {
  left: ['projects', 'threads', 'settings'],
  main: [],
  right: ['sources', 'notes'],
};

export const flexibleBlocks: BlockId[] = [
  'chat',
  'filter',
  'procedure',
  'documentView',
  'footnotes',
];

export const panelOrder: Record<Panel, BlockId[]> = {
  left: ['projects', 'threads', 'filter', 'settings'],
  main: ['procedure', 'filter', 'chat', 'footnotes', 'documentView'],
  right: ['procedure', 'chat', 'sources', 'footnotes', 'documentView', 'notes'],
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

export const defaultLayout: BlockLayout = layoutOf({
  threads: 'left',
  filter: 'left',
  settings: 'left',
  procedure: 'main',
  chat: 'main',
  footnotes: 'main',
  sources: 'right',
  documentView: 'right',
  notes: 'right',
});

export type TemplateId =
  | 'full'
  | 'sourcesOnly'
  | 'procedureOnly'
  | 'noFilter'
  | 'withProjects'
  | 'noRight'
  | 'noLeft'
  | 'chatOnly';

export const templates: Record<TemplateId, BlockLayout> = {
  full: defaultLayout,
  sourcesOnly: layoutOf({
    threads: 'left',
    filter: 'left',
    chat: 'main',
    footnotes: 'main',
    sources: 'right',
  }),
  procedureOnly: layoutOf({ threads: 'left', chat: 'main', procedure: 'right' }),
  noFilter: layoutOf({
    threads: 'left',
    procedure: 'main',
    chat: 'main',
    footnotes: 'main',
    sources: 'right',
    documentView: 'right',
  }),
  withProjects: layoutOf({
    projects: 'left',
    threads: 'left',
    procedure: 'main',
    chat: 'main',
    footnotes: 'main',
    sources: 'right',
    documentView: 'right',
  }),
  noRight: layoutOf({ threads: 'left', filter: 'left', procedure: 'main', chat: 'main' }),
  noLeft: layoutOf({
    procedure: 'main',
    chat: 'main',
    footnotes: 'main',
    sources: 'right',
    documentView: 'right',
  }),
  chatOnly: layoutOf({ procedure: 'main', chat: 'main' }),
};

export const templateIds = Object.keys(templates) as TemplateId[];
