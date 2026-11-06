// The shell's model: two side panels that fold to a rail, resize, and become drawers in a narrow
// window, beside a main column with a floor and a ceiling. Pure, so the arithmetic is tested
// without a DOM. Ported from kunnskapsassistenten's layout/viewModel.ts and layout/resize.ts.
//
// Panels are named after their place, never after a side or their content: a panel's content
// and its name are the host's, and either may move.

/** A side panel. `primary` stands before the main column, `secondary` after it. */
export type ShellSide = 'primary' | 'secondary';

export const shellSides = ['primary', 'secondary'] as const satisfies readonly ShellSide[];

export interface ShellPanelSize {
  /** The width the design draws, in CSS pixels, padding and border included. */
  width: number;
  /** The narrowest it is drawn open. A drag past half of it folds the panel instead. */
  minWidth: number;
  /** The widest it may be dragged. No ceiling by default: the main column's floor is the limit. */
  maxWidth?: number | undefined;
}

/** A panel's size with every number given; no ceiling is `Infinity`. */
export type PanelSize = { [K in keyof ShellPanelSize]-?: number };

export interface ShellMainSize {
  /** The main column's floor, so it stays readable beside the panels. */
  minWidth: number;
  /** The reading width; the main column is centred in what is left. */
  maxWidth: number;
}

/** What the reader changes, as the host stores it and hands it back. Every field may be missing. */
export interface ShellLayout {
  /** Folded to a rail, per panel. */
  collapsed?: Partial<Record<ShellSide, boolean>> | undefined;
  /** Widths the reader dragged. A panel at the design's width is left out. */
  widths?: Partial<Record<ShellSide, number>> | undefined;
  /** The reader shut this panel themselves, so an offer does not open it again. */
  dismissed?: Partial<Record<ShellSide, boolean>> | undefined;
}

/** The state the shell keeps. */
export interface ShellState {
  collapsed: Record<ShellSide, boolean>;
  /** The width asked for. What is drawn is `fittedWidths`. */
  widths: Record<ShellSide, number>;
  dismissed: Record<ShellSide, boolean>;
}

/** Fixed for a page: which panels there are, and every size the sums need. */
export interface ShellGeometry {
  panels: Partial<Record<ShellSide, PanelSize>>;
  main: ShellMainSize;
  /** The gap beside an open panel; a rail sits flush. Must match `--genai-shell-gap`. */
  gap: number;
  /** A folded panel's width: the button and the rail's padding and border. */
  rail: number;
}

/**
 * Kunnskapsassistenten's sizes. The primary panel: 328 px inside, what its filter was drawn for,
 * plus padding, so 400 is its floor too. The secondary panel: 432 fits the design's frames and
 * makes 1536 with all three open; 336 is what 1440 leaves it. Neither has a ceiling, so a panel
 * can take about half the window (kunnskapsassistenten#80, #122).
 */
export const defaultPanelSizes: Record<ShellSide, PanelSize> = {
  primary: { width: 400, minWidth: 400, maxWidth: Number.POSITIVE_INFINITY },
  secondary: { width: 432, minWidth: 336, maxWidth: Number.POSITIVE_INFINITY },
};

/** The main column: 640 so the sources can be read beside the answer, 800 to read. */
export const defaultMainSize: ShellMainSize = { minWidth: 640, maxWidth: 800 };

/** `--ds-size-8` at the default size mode. */
export const defaultGap = 32;

/** A small icon button, 42, plus 2 × 12 (`--ds-size-3`) padding and a 1 px border. */
export const defaultRail = 67;

/** Kunnskapsassistenten starts with the primary panel open and the secondary one on its rail. */
export const defaultCollapsed: Record<ShellSide, boolean> = { primary: false, secondary: true };

export const otherSide = (side: ShellSide): ShellSide =>
  side === 'primary' ? 'secondary' : 'primary';

/** The panel that gives way when only one fits: the secondary one, opened to check something. */
export const yieldingSide = (geometry: ShellGeometry): ShellSide =>
  geometry.panels.secondary ? 'secondary' : 'primary';

const present = (geometry: ShellGeometry) => shellSides.filter((side) => geometry.panels[side]);

const railOf = (geometry: ShellGeometry, side: ShellSide) =>
  geometry.panels[side] ? geometry.rail : 0;

/**
 * Where the layout changes, summed from the sizes so the breakpoints move with them:
 * - `both`: the narrowest window with both panels open, 400 + 32 + 640 + 32 + 336 = 1440;
 * - `drawer`: below it an open panel no longer fits beside the main column and is drawn over it,
 *   from the widest one-panel state, 400 + 32 + 640 + 67 = 1139;
 * - `compact`: below it two rails eat a main column already under its floor, 67 + 640 + 67 = 774.
 * 0 means never.
 */
export const breakpoints = (geometry: ShellGeometry) => {
  const { primary, secondary } = geometry.panels;
  const { gap, main } = geometry;
  return {
    both:
      primary && secondary ? primary.minWidth + gap + main.minWidth + gap + secondary.minWidth : 0,
    drawer: Math.max(
      0,
      ...present(geometry).map(
        (side) =>
          (geometry.panels[side]?.minWidth ?? 0) +
          gap +
          main.minWidth +
          railOf(geometry, otherSide(side)),
      ),
    ),
    compact: present(geometry).length
      ? railOf(geometry, 'primary') + main.minWidth + railOf(geometry, 'secondary')
      : 0,
  };
};

/** Range syntax: `max-width: 1439px` misses the fractional widths of a zoomed window. */
export const narrowerThan = (width: number) => `(width < ${width}px)`;

/** The state to start from: the host's stored layout over the panels' defaults. */
export const initialState = (
  geometry: ShellGeometry,
  collapsedByDefault: Record<ShellSide, boolean>,
  stored: ShellLayout | undefined,
): ShellState => {
  const state: ShellState = {
    collapsed: { ...collapsedByDefault },
    widths: {
      primary: geometry.panels.primary?.width ?? 0,
      secondary: geometry.panels.secondary?.width ?? 0,
    },
    dismissed: { primary: false, secondary: false },
  };
  for (const side of shellSides) {
    const collapsed = stored?.collapsed?.[side];
    if (typeof collapsed === 'boolean') state.collapsed[side] = collapsed;
    if (stored?.dismissed?.[side] === true) state.dismissed[side] = true;
  }
  let next = state;
  for (const side of shellSides) {
    // Finite numbers only: `Infinity` and `NaN` pass `typeof` and break CSS.
    const width = stored?.widths?.[side];
    if (typeof width === 'number' && Number.isFinite(width))
      next = withWidth(geometry, next, side, width);
  }
  return next;
};

/**
 * The layout worth storing. A width is kept only when the reader moved it: storing the default
 * too would make «reset» and «never touched» differ, and a changed default would never reach a
 * browser that had merely opened the app once.
 */
export const storedLayout = (geometry: ShellGeometry, state: ShellState): ShellLayout => {
  const layout: Required<{ [K in keyof ShellLayout]: NonNullable<ShellLayout[K]> }> = {
    collapsed: {},
    widths: {},
    dismissed: {},
  };
  for (const side of present(geometry)) {
    layout.collapsed[side] = state.collapsed[side];
    layout.dismissed[side] = state.dismissed[side];
    if (state.widths[side] !== geometry.panels[side]?.width)
      layout.widths[side] = state.widths[side];
  }
  return layout;
};

export const withCollapsed = (state: ShellState, side: ShellSide, collapsed: boolean) =>
  state.collapsed[side] === collapsed
    ? state
    : { ...state, collapsed: { ...state.collapsed, [side]: collapsed } };

/** Keep at most one panel open, `keep` if a choice must be made. A no-op unless both are open. */
export const withOneOpen = (state: ShellState, keep: ShellSide) =>
  state.collapsed[keep] ? state : withCollapsed(state, otherSide(keep), true);

/** Fold both, on entering drawer mode: an open drawer is modal and would cover the main column. */
export const withAllCollapsed = (state: ShellState) =>
  shellSides.reduce((next, side) => withCollapsed(next, side, true), state);

/** A collapse or an open the reader asked for, which also says whether they shut it themselves. */
export const withDismissed = (state: ShellState, side: ShellSide, dismissed: boolean) =>
  state.dismissed[side] === dismissed
    ? state
    : { ...state, dismissed: { ...state.dismissed, [side]: dismissed } };

/**
 * Resize a panel, within its floor and ceiling and in whole pixels. A backstop: `widthRange`
 * decides what fits the window, and `fittedWidths` draws a stored width the window cannot hold.
 */
export const withWidth = (
  geometry: ShellGeometry,
  state: ShellState,
  side: ShellSide,
  width: number,
): ShellState => {
  const size = geometry.panels[side];
  if (!size) return state;
  const clamped = Math.min(Math.max(Math.round(width), size.minWidth), size.maxWidth);
  if (state.widths[side] === clamped) return state;
  return { ...state, widths: { ...state.widths, [side]: clamped } };
};

/** What a panel takes up on the row: its rail when folded. */
const occupied = (geometry: ShellGeometry, state: ShellState, side: ShellSide) => {
  if (!geometry.panels[side]) return 0;
  return state.collapsed[side] ? geometry.rail : state.widths[side];
};

/** The gap a panel puts between itself and the main column. A rail has none. */
const gapOf = (geometry: ShellGeometry, state: ShellState, side: ShellSide) =>
  geometry.panels[side] && !state.collapsed[side] ? geometry.gap : 0;

/**
 * The widths actually DRAWN in this window, which the separator reports. When a dragged width
 * does not fit, what gives, in order: the main column down to its floor (in CSS), any widening
 * past the design's width (the yielding panel first), the yielding panel down to its floor, then
 * the other one down to its floor.
 */
export const fittedWidths = (
  geometry: ShellGeometry,
  state: ShellState,
  viewport: number,
): Record<ShellSide, number> => {
  const fitted = {
    primary: occupied(geometry, state, 'primary'),
    secondary: occupied(geometry, state, 'secondary'),
  };
  let over =
    fitted.primary +
    fitted.secondary +
    gapOf(geometry, state, 'primary') +
    gapOf(geometry, state, 'secondary') +
    geometry.main.minWidth -
    viewport;

  const yielding = yieldingSide(geometry);
  const order = [yielding, otherSide(yielding)];
  const floors = [
    (side: ShellSide) => geometry.panels[side]?.width ?? 0,
    (side: ShellSide) => geometry.panels[side]?.minWidth ?? 0,
  ];
  for (const floor of floors) {
    for (const side of order) {
      const size = geometry.panels[side];
      if (over <= 0) break;
      if (!size || state.collapsed[side]) continue;
      const give = Math.min(over, fitted[side] - Math.max(floor(side), size.minWidth));
      if (give <= 0) continue;
      fitted[side] -= give;
      over -= give;
    }
  }
  return fitted;
};

export interface WidthRange {
  min: number;
  max: number;
}

/**
 * How wide a panel may be dragged in this window: from its floor up to what is left once the
 * other panel and the main column's floor have theirs. A drag takes room only from the main
 * column, so the other edge never moves. Read for the panel OPEN, also while a drag has folded
 * it. If the limits cross, the floor wins.
 */
export const widthRange = (
  geometry: ShellGeometry,
  state: ShellState,
  side: ShellSide,
  viewport: number,
): WidthRange => {
  const size = geometry.panels[side];
  if (!size) return { min: 0, max: 0 };
  const open = withCollapsed(state, side, false);
  const other = otherSide(side);
  const free =
    viewport -
    fittedWidths(geometry, open, viewport)[other] -
    gapOf(geometry, open, other) -
    gapOf(geometry, open, side) -
    geometry.main.minWidth;
  return { min: size.minWidth, max: Math.max(size.minWidth, Math.min(size.maxWidth, free)) };
};

export const clampWidth = (width: number, range: WidthRange) =>
  Math.min(Math.max(Math.round(width), range.min), range.max);

/** Which way the pointer travels to widen a panel: away from the main column. */
export const growthDirection = (side: ShellSide): 1 | -1 => (side === 'primary' ? 1 : -1);

/** Arrow keys move the edge this far; Shift makes it a stride. */
export const widthStep = 16;
export const widthStride = 64;

/** Designsystemet's `Dialog` placement for a drawer: in from the edge the panel stands at. */
export const drawerPlacement = (side: ShellSide): 'left' | 'right' =>
  side === 'primary' ? 'left' : 'right';

/** A drawer is drawn at the design's width, never a dragged one, and never wider than the window. */
export const drawerWidth = (geometry: ShellGeometry, side: ShellSide, viewport: number) =>
  Math.min(geometry.panels[side]?.width ?? 0, viewport);

/**
 * The widths as custom properties on the shell, so the stylesheet never needs the state. A folded
 * panel reports its rail. In drawer mode every panel is a rail on the row, open or not, and the
 * main column's floor yields to the window rather than scroll sideways (WCAG 1.4.10). In the bar
 * the rails stand above the main column and take nothing from the row.
 */
export const layoutStyle = (
  geometry: ShellGeometry,
  state: ShellState,
  viewport: number,
  drawer: boolean,
  compact: boolean,
): Record<string, string> => {
  const fitted = fittedWidths(geometry, state, viewport);
  const rails = compact
    ? 0
    : present(geometry).reduce((total, side) => total + railOf(geometry, side), 0);
  const room = Math.max(0, viewport - rails);
  const style: Record<string, string> = {
    '--uib-shell-main-min-width': `${drawer ? Math.min(geometry.main.minWidth, room) : geometry.main.minWidth}px`,
    '--uib-shell-main-max-width': `${geometry.main.maxWidth}px`,
  };
  for (const side of present(geometry)) {
    const railed = drawer || state.collapsed[side];
    style[`--uib-shell-${side}-width`] = `${railed ? geometry.rail : fitted[side]}px`;
    // A rail does not squeeze: its floor is its own width.
    style[`--uib-shell-${side}-min-width`] =
      `${railed ? geometry.rail : (geometry.panels[side]?.minWidth ?? 0)}px`;
    if (drawer)
      style[`--uib-shell-${side}-drawer-width`] = `${drawerWidth(geometry, side, viewport)}px`;
  }
  return style;
};
