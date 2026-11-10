// The portal builder's words (genki #210) over the catalogue's rules.
import {
  blockIds as catalogueIds,
  blocksAllowedIn as catalogueAllowedIn,
  blockSpec,
  zones,
  type BlockId as CatalogueId,
  type Zone,
} from './catalogue.js';
import * as rules from './layout.js';
import type { BuilderState, PlacedBlock } from './layout.js';
import type { TemplateId as CanvasTemplateId } from './templates.js';

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

export interface BlockLayout {
  placed: Partial<Record<BlockId, Panel>>;
  chosen: Partial<Record<BlockId, Panel>>;
}

const zoneOfPanel: Readonly<Record<Panel, Zone>> = {
  left: 'primary',
  main: 'main',
  right: 'secondary',
};
const panelOfZone: Readonly<Record<Zone, Panel>> = {
  primary: 'left',
  main: 'main',
  secondary: 'right',
};

const catalogueIdOf: Readonly<Record<BlockId, CatalogueId>> = {
  projects: 'projects',
  threads: 'threads',
  settings: 'settings',
  chat: 'chat',
  sources: 'sources',
  notes: 'notes',
  filter: 'filter',
  procedure: 'approach',
  documentView: 'document-view',
};
const panelIdOf = Object.fromEntries(
  Object.entries(catalogueIdOf).map(([panelId, id]) => [id, panelId]),
) as Readonly<Record<CatalogueId, BlockId>>;

export const toZone = (panel: Panel): Zone => zoneOfPanel[panel];
export const toPanel = (zone: Zone): Panel => panelOfZone[zone];
export const toCatalogueId = (id: BlockId): CatalogueId => catalogueIdOf[id];
export const toPanelId = (id: CatalogueId): BlockId => panelIdOf[id];

export const panels: Panel[] = zones.map(toPanel);
export const allBlocks: BlockId[] = catalogueIds.map(toPanelId);

export const blockPanels = Object.fromEntries(
  catalogueIds.map((id) => [toPanelId(id), blockSpec(id).zones.map(toPanel)]),
) as Record<BlockId, Panel[]>;

export const blocksAllowedIn = (panel: Panel): BlockId[] =>
  catalogueAllowedIn(toZone(panel)).map(toPanelId);

export const panelOrder = Object.fromEntries(
  panels.map((panel) => [panel, blocksAllowedIn(panel)]),
) as Record<Panel, BlockId[]>;

// #210's shape has no room for options, the template or held blocks.
// Ours holds all of #210's; a misplaced or unbuilt block is kept and reported.

/** #210's layout as the builder's state; `from` carries the options, the template and the held blocks. */
export const toBuilderState = (layout: BlockLayout, from?: BuilderState): BuilderState => {
  const before = (id: CatalogueId) =>
    [
      ...zones.flatMap((zone) => from?.layout.zones[zone] ?? []),
      ...(from?.held ?? []).map((entry) => entry.placed),
    ].find((p) => p.block === id);
  const placedIn = (zone: Zone): PlacedBlock[] =>
    (Object.entries(layout.placed) as [BlockId, Panel][])
      .filter(([, panel]) => toZone(panel) === zone)
      .map(([id]) => before(toCatalogueId(id)) ?? { block: toCatalogueId(id) });
  const held = from?.held?.filter(
    (entry) => layout.placed[toPanelId(entry.placed.block)] === undefined,
  );
  return {
    layout: rules.normalised({
      version: 1,
      ...(from?.layout.template !== undefined ? { template: from.layout.template } : {}),
      zones: {
        primary: placedIn('primary'),
        main: placedIn('main'),
        secondary: placedIn('secondary'),
      },
    }),
    chosen: Object.fromEntries(
      (Object.entries(layout.chosen) as [BlockId, Panel][]).map(([id, panel]) => [
        toCatalogueId(id),
        toZone(panel),
      ]),
    ),
    ...(held && held.length > 0 ? { held } : {}),
  };
};

/** The builder's state in #210's shape. */
export const fromBuilderState = (state: BuilderState): BlockLayout => ({
  placed: Object.fromEntries(
    zones.flatMap((zone) =>
      state.layout.zones[zone].map((placed) => [toPanelId(placed.block), toPanel(zone)]),
    ),
  ),
  chosen: Object.fromEntries(
    (Object.entries(state.chosen) as [CatalogueId, Zone][]).map(([id, zone]) => [
      toPanelId(id),
      toPanel(zone),
    ]),
  ),
});

/** One of our rules on #210's layout; a rule that changes nothing gives the same object back. */
const apply = (layout: BlockLayout, rule: (state: BuilderState) => BuilderState): BlockLayout => {
  const state = toBuilderState(layout);
  const next = rule(state);
  return next === state ? layout : fromBuilderState(next);
};

export const placeOf = (layout: BlockLayout, id: BlockId): Panel =>
  toPanel(rules.placeOf(toBuilderState(layout), toCatalogueId(id)));

export const isOn = (layout: BlockLayout, id: BlockId) =>
  rules.isOn(toBuilderState(layout).layout, toCatalogueId(id));

export const turnOn = (layout: BlockLayout, id: BlockId): BlockLayout =>
  apply(layout, (state) => rules.turnOn(state, toCatalogueId(id)));

export const turnOff = (layout: BlockLayout, id: BlockId): BlockLayout =>
  apply(layout, (state) => rules.turnOff(state, toCatalogueId(id)));

export const moveTo = (layout: BlockLayout, id: BlockId, panel: Panel): BlockLayout =>
  apply(layout, (state) => rules.moveTo(state, toCatalogueId(id), toZone(panel)));

export const placeIn = (layout: BlockLayout, id: BlockId, panel: Panel): BlockLayout =>
  apply(layout, (state) => rules.placeIn(state, toCatalogueId(id), toZone(panel)));

export const blocksIn = (layout: BlockLayout, panel: Panel): BlockId[] =>
  rules.blocksIn(toBuilderState(layout).layout, toZone(panel)).map(toPanelId);

export type RightPanelMode = rules.ToolMode;
export const rightPanelMode = (count: number): RightPanelMode => rules.toolMode(count);

/** The catalogue's start: every built block in its first panel, and none that is «kommer». */
export const defaultLayout: BlockLayout = fromBuilderState({
  layout: rules.defaultLayout,
  chosen: {},
});

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

type Zones = Readonly<Record<Zone, readonly CatalogueId[]>>;

// #210's templates in the catalogue's words, until one list is chosen.
const portalTemplates: Readonly<Record<Exclude<TemplateId, 'all'>, Zones>> = {
  sourcesFocus: { primary: ['threads', 'filter'], main: ['chat'], secondary: ['sources'] },
  procedureFocus: { primary: ['threads'], main: ['chat'], secondary: ['approach'] },
  notesFocus: { primary: ['projects', 'threads'], main: ['chat'], secondary: ['notes'] },
  documentFocus: { primary: [], main: ['document-view'], secondary: ['chat', 'sources'] },
  classic: { primary: ['threads'], main: ['approach', 'chat'], secondary: ['sources'] },
  noRight: { primary: ['threads', 'filter'], main: ['approach', 'chat'], secondary: [] },
  noLeft: { primary: [], main: ['approach', 'chat'], secondary: ['sources'] },
  chatOnly: { primary: [], main: ['approach', 'chat'], secondary: [] },
};

const builtIn = (ids: readonly CatalogueId[]): PlacedBlock[] =>
  ids.filter((id) => blockSpec(id).status === 'built').map((block) => ({ block }));

/** A template as `fromTemplate` builds one: only the blocks that are built. */
const built = (template: Zones): BlockLayout =>
  fromBuilderState({
    layout: rules.normalised({
      version: 1,
      zones: {
        primary: builtIn(template.primary),
        main: builtIn(template.main),
        secondary: builtIn(template.secondary),
      },
    }),
    chosen: {},
  });

export const templates: Record<TemplateId, BlockLayout> = {
  all: defaultLayout,
  ...(Object.fromEntries(
    Object.entries(portalTemplates).map(([id, zoned]) => [id, built(zoned)]),
  ) as Record<Exclude<TemplateId, 'all'>, BlockLayout>),
};

export const templateIds: TemplateId[] = [
  'all',
  'sourcesFocus',
  'procedureFocus',
  'notesFocus',
  'documentFocus',
  'classic',
  'noRight',
  'noLeft',
  'chatOnly',
];

/** The canvas's template that is the same as one of #210's, where there is one. */
export const canvasTemplateOf: Readonly<Partial<Record<TemplateId, CanvasTemplateId>>> = {
  sourcesFocus: 'sources-only',
  procedureFocus: 'approach-only',
  noRight: 'without-secondary',
  chatOnly: 'chat-only',
};
