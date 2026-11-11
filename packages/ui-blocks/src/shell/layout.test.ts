import { describe, expect, it } from 'vitest';
import {
  breakpoints,
  cardsGap,
  cardsInset,
  cardsRail,
  clampWidth,
  defaultCollapsed,
  defaultGap,
  defaultMainSize,
  defaultPanelSizes,
  defaultRail,
  drawerPlacement,
  drawerWidth,
  fittedWidths,
  growthDirection,
  initialState,
  layoutStyle,
  narrowerThan,
  shellSides,
  storedLayout,
  widthRange,
  withAllCollapsed,
  withCollapsed,
  withOneOpen,
  withWidth,
  type ShellGeometry,
  type ShellState,
} from './layout.js';

// The arithmetic of kunnskapsassistenten's layout/viewModel.ts and resize.ts, with its cases.

const geometry: ShellGeometry = {
  panels: { ...defaultPanelSizes },
  main: defaultMainSize,
  gap: defaultGap,
  rail: defaultRail,
};
const start = initialState(geometry, defaultCollapsed, undefined);
const open = (state: ShellState = start) =>
  withCollapsed(withCollapsed(state, 'primary', false), 'secondary', false);
const px = (value: string | undefined) => Number.parseFloat(value ?? 'NaN');

describe('the breakpoints, summed from the sizes', () => {
  it('fits both panels from 400 + 32 + 640 + 32 + 336 = 1440', () => {
    expect(breakpoints(geometry).both).toBe(1440);
  });

  it('draws drawers below the widest one-panel state, 400 + 32 + 640 + 67 = 1139', () => {
    expect(breakpoints(geometry).drawer).toBe(1139);
    expect(breakpoints(geometry).drawer).toBeLessThan(breakpoints(geometry).both);
  });

  it('puts the rails in a bar below 67 + 640 + 67 = 774', () => {
    expect(breakpoints(geometry).compact).toBe(774);
  });

  it('moves when a size does', () => {
    const wider = { ...geometry, main: { minWidth: 700, maxWidth: 900 } };
    expect(breakpoints(wider)).toEqual({ both: 1500, drawer: 1199, compact: 834 });
  });

  it('has no two-panel rule with one panel, and sums only the rail that is there', () => {
    const one = { ...geometry, panels: { primary: defaultPanelSizes.primary } };
    expect(breakpoints(one)).toEqual({ both: 0, drawer: 1072, compact: 707 });
  });

  it('asks «narrower than», so the breakpoint itself still fits', () => {
    expect(narrowerThan(1440)).toBe('(width < 1440px)');
  });
});

describe('the widths drawn in a window', () => {
  it('are what was asked for while there is room', () => {
    expect(fittedWidths(geometry, open(), 1920)).toEqual({ primary: 400, secondary: 432 });
  });

  it('give the secondary panel away first when the window runs short', () => {
    expect(fittedWidths(geometry, open(), 1440)).toEqual({ primary: 400, secondary: 336 });
  });

  it('take the primary panel back to its floor once the secondary one is on its own', () => {
    const wide = withWidth(geometry, open(), 'primary', 600);
    expect(fittedWidths(geometry, wide, 1440)).toEqual({ primary: 400, secondary: 336 });
  });

  it('give a widening back before the other panel gives any of its own width', () => {
    const wide = withWidth(geometry, open(), 'primary', 500);
    // 500 + 32 + 640 + 32 + 432 = 1636: 100 over at 1536, taken from the widening.
    expect(fittedWidths(geometry, wide, 1536)).toEqual({ primary: 400, secondary: 432 });
  });

  it('never squeeze a rail', () => {
    const folded = withAllCollapsed(start);
    expect(fittedWidths(geometry, folded, 400)).toEqual({ primary: 67, secondary: 67 });
  });
});

describe('how far a panel may be dragged', () => {
  it('lets the primary panel grow into what the main column is not using', () => {
    const state = withCollapsed(open(), 'secondary', true);
    // 1920 − 67 (rail, no gap) − 32 − 640.
    expect(widthRange(geometry, state, 'primary', 1920)).toEqual({ min: 400, max: 1181 });
  });

  it('gives nothing at 1440, where everything is on its floor', () => {
    expect(widthRange(geometry, open(), 'primary', 1440)).toEqual({ min: 400, max: 400 });
    expect(widthRange(geometry, open(), 'secondary', 1440)).toEqual({ min: 336, max: 336 });
  });

  it('reads the room a folded panel would have open, which a drag that folded it needs', () => {
    const folded = withCollapsed(open(), 'primary', true);
    expect(widthRange(geometry, folded, 'primary', 1920)).toEqual(
      widthRange(geometry, open(), 'primary', 1920),
    );
  });

  it('takes its room from the main column and never from the other panel', () => {
    const state = open();
    const range = widthRange(geometry, state, 'primary', 1920);
    const dragged = withWidth(geometry, state, 'primary', range.max);
    expect(fittedWidths(geometry, dragged, 1920).secondary).toBe(432);
  });

  it('never reports a ceiling under the floor, however little room there is', () => {
    expect(widthRange(geometry, open(), 'primary', 900)).toEqual({ min: 400, max: 400 });
  });

  it('keeps whole pixels inside the range', () => {
    expect(clampWidth(512.6, { min: 400, max: 600 })).toBe(513);
    expect(clampWidth(100, { min: 400, max: 600 })).toBe(400);
    expect(clampWidth(900, { min: 400, max: 600 })).toBe(600);
  });

  it('grows a panel away from the main column, on either side', () => {
    expect(growthDirection('primary')).toBe(1);
    expect(growthDirection('secondary')).toBe(-1);
  });
});

describe('the state the reader changes', () => {
  it('will not take a panel below its floor, and keeps whole pixels', () => {
    expect(withWidth(geometry, start, 'secondary', 100).widths.secondary).toBe(336);
    expect(withWidth(geometry, start, 'primary', 450.4).widths.primary).toBe(450);
  });

  it('keeps a width wider than the window, and leaves drawing it to the fitting', () => {
    expect(withWidth(geometry, start, 'primary', 5000).widths.primary).toBe(5000);
  });

  it('keeps one panel open where both do not fit, the one asked for', () => {
    expect(withOneOpen(open(), 'secondary').collapsed).toEqual({
      primary: true,
      secondary: false,
    });
    const folded = withCollapsed(open(), 'secondary', true);
    expect(withOneOpen(folded, 'secondary')).toBe(folded);
  });

  it('folds both on entering drawer mode, and leaves the widths alone', () => {
    const wide = withWidth(geometry, open(), 'primary', 500);
    const folded = withAllCollapsed(wide);
    expect(folded.collapsed).toEqual({ primary: true, secondary: true });
    expect(folded.widths).toEqual(wide.widths);
  });

  it('stores a width only once the reader has moved it, so a reset forgets it', () => {
    expect(storedLayout(geometry, start).widths).toEqual({});
    const moved = withWidth(geometry, start, 'primary', 480);
    expect(storedLayout(geometry, moved).widths).toEqual({ primary: 480 });
    const reset = withWidth(geometry, moved, 'primary', 400);
    expect(storedLayout(geometry, reset).widths).toEqual({});
  });

  it('comes back as it was stored', () => {
    const changed = withWidth(geometry, open(), 'secondary', 500);
    const stored = storedLayout(geometry, {
      ...changed,
      dismissed: { primary: false, secondary: true },
    });
    expect(initialState(geometry, defaultCollapsed, stored)).toEqual({
      ...changed,
      dismissed: { primary: false, secondary: true },
    });
  });

  it('opens on the defaults when what is stored is nonsense', () => {
    const nonsense = {
      collapsed: { primary: 'yes', secondary: 0 },
      widths: { primary: Number.NaN, secondary: Number.POSITIVE_INFINITY },
      dismissed: { secondary: 'true' },
    } as never;
    expect(initialState(geometry, defaultCollapsed, nonsense)).toEqual(start);
  });
});

describe('drawers', () => {
  it('slide in from the edge each panel stands at', () => {
    expect(drawerPlacement('primary')).toBe('left');
    expect(drawerPlacement('secondary')).toBe('right');
  });

  it('are drawn at the design width, not a dragged one, and never wider than the window', () => {
    expect(drawerWidth(geometry, 'primary', 1000)).toBe(400);
    expect(drawerWidth(geometry, 'secondary', 390)).toBe(390);
  });
});

// Every width from 280 to 2000 and every reachable state: no sideways scroll (WCAG 1.4.10).
describe('the row and the window, from 280 to 2000 px', () => {
  const points = breakpoints(geometry);
  const windows = Array.from({ length: 2000 - 280 + 1 }, (_, index) => 280 + index);

  const row = (state: ShellState, viewport: number) => {
    const drawer = viewport < points.drawer;
    const style = layoutStyle(geometry, state, viewport, drawer, false);
    let panels = 0;
    let gaps = 0;
    for (const side of shellSides) {
      panels += px(style[`--uib-shell-${side}-width`]);
      if (!drawer && !state.collapsed[side]) gaps += geometry.gap;
    }
    return { drawer, main: px(style['--uib-shell-main-min-width']), panels, gaps };
  };

  const reachable = (state: ShellState, viewport: number) => {
    const all = [false, true].flatMap((p) =>
      [false, true].map((s) => withCollapsed(withCollapsed(state, 'primary', p), 'secondary', s)),
    );
    if (viewport >= points.both || viewport < points.drawer) return all;
    return all.flatMap((candidate) => shellSides.map((keep) => withOneOpen(candidate, keep)));
  };

  const sessions = (viewport: number) => {
    const widest = (state: ShellState, side: 'primary' | 'secondary') =>
      withWidth(geometry, state, side, widthRange(geometry, state, side, viewport).max);
    return [
      start,
      widest(widest(start, 'primary'), 'secondary'),
      initialState(geometry, defaultCollapsed, { widths: { primary: 99_999, secondary: 99_999 } }),
    ];
  };

  const failures = (check: (r: ReturnType<typeof row>, viewport: number) => string | undefined) =>
    windows.flatMap((viewport) =>
      sessions(viewport).flatMap((session) =>
        reachable(session, viewport).flatMap((state) => {
          const problem = check(row(state, viewport), viewport);
          return problem ? [`${viewport} px: ${problem}`] : [];
        }),
      ),
    );

  it('is never wider than the window', () => {
    const found = failures(({ main, panels, gaps }, viewport) =>
      main + panels + gaps > viewport ? `${main + panels + gaps} on the row` : undefined,
    );
    expect(found.slice(0, 10), `${found.length} cases`).toEqual([]);
  });

  it('gives the main column a floor between 0 and what is free', () => {
    const found = failures(({ main, panels, gaps }, viewport) =>
      Number.isNaN(main) || main < 0 || main > viewport - panels - gaps
        ? `the floor is ${main}`
        : undefined,
    );
    expect(found.slice(0, 10), `${found.length} cases`).toEqual([]);
  });

  it('draws both panels as rails below the drawer breakpoint, whatever was stored', () => {
    const found = failures(({ drawer, panels }) =>
      drawer && panels !== 2 * defaultRail ? `the panels are ${panels}` : undefined,
    );
    expect(found).toEqual([]);
  });

  it('never lets a panel be dragged wider than the row has room for', () => {
    const found: string[] = [];
    for (const viewport of windows) {
      if (viewport < points.drawer) continue;
      for (const state of reachable(start, viewport)) {
        for (const side of shellSides) {
          if (state.collapsed[side]) continue;
          const max = widthRange(geometry, state, side, viewport).max;
          const { main, panels, gaps } = row(withWidth(geometry, state, side, max), viewport);
          if (main + panels + gaps > viewport) found.push(`${viewport} px: ${side}`);
        }
      }
    }
    expect(found.slice(0, 10), `${found.length} cases`).toEqual([]);
  });

  it('never draws a drawer wider than the window', () => {
    const found = windows.flatMap((viewport) =>
      shellSides.filter((side) => drawerWidth(geometry, side, viewport) > viewport),
    );
    expect(found).toEqual([]);
  });

  it('gives the main column the whole width in the bar, as wide as the window allows', () => {
    const style = layoutStyle(geometry, withAllCollapsed(start), 390, true, true);
    expect(style['--uib-shell-main-min-width']).toBe('390px');
    expect(style['--uib-shell-main-max-width']).toBe('800px');
  });
});

// The design's dev-navbar board at 1720: cards 16 from the window and 12 apart, threads 220, the
// main column 1064 and the tools 380, and a rail of 76 that keeps its gap.
describe('the cards frame’s sums', () => {
  const cards: ShellGeometry = {
    panels: {
      primary: { width: 220, minWidth: 220, maxWidth: Number.POSITIVE_INFINITY },
      secondary: { width: 380, minWidth: 336, maxWidth: Number.POSITIVE_INFINITY },
    },
    main: defaultMainSize,
    gap: cardsGap,
    rail: cardsRail,
    inset: cardsInset,
    railGap: true,
  };
  const both = open(initialState(cards, defaultCollapsed, undefined));
  const mainAt = (state: ShellState, viewport: number) => {
    const widths = fittedWidths(cards, state, viewport);
    const taken = (side: (typeof shellSides)[number]) =>
      state.collapsed[side] ? cardsRail : widths[side];
    return viewport - 2 * cardsInset - taken('primary') - taken('secondary') - 2 * cardsGap;
  };

  it('are the board’s: 16 from the window, 12 apart, and a 76 rail of a 44 button with 16 each side', () => {
    expect([cardsInset, cardsGap, cardsRail]).toEqual([16, 12, 76]);
    expect(cardsRail).toBe(16 + 44 + 16);
  });

  it('leave the main column 1064 at 1720 with both panels open at the board’s widths', () => {
    expect(fittedWidths(cards, both, 1720)).toEqual({ primary: 220, secondary: 380 });
    expect(mainAt(both, 1720)).toBe(1064);
  });

  it('count the frame’s margins and a rail’s gap in every breakpoint', () => {
    expect(breakpoints(cards)).toEqual({
      both: 16 + 220 + 12 + 640 + 12 + 336 + 16,
      drawer: 16 + 336 + 12 + 640 + 76 + 12 + 16,
      compact: 16 + 76 + 12 + 640 + 12 + 76 + 16,
    });
  });

  it('let a panel beside a rail grow only to what the margins, the rail and both gaps leave', () => {
    const railed = withCollapsed(both, 'primary', true);
    expect(widthRange(cards, railed, 'secondary', 1720).max).toBe(
      1720 - 2 * 16 - 76 - 12 - 12 - 640,
    );
  });

  it('leave a flush frame’s sums as they were: no margins, and a rail with no gap', () => {
    expect(breakpoints({ ...geometry, inset: 0, railGap: false })).toEqual(breakpoints(geometry));
  });
});
