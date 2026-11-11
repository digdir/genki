import { Button, Dialog, SkipLink, Tooltip } from '@digdir/designsystemet-react';
import { SidebarLeftIcon, SidebarRightIcon } from '@navikt/aksel-icons';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { classes } from '../dom.js';
import { useMedia, useScrollPadding, useScrollTabStop, useViewportWidth } from './hooks.js';
import { useT } from './i18n.js';
import {
  breakpoints,
  clampWidth,
  defaultCollapsed,
  defaultGap,
  defaultMainSize,
  defaultPanelSizes,
  defaultRail,
  drawerPlacement,
  fittedWidths,
  growthDirection,
  initialState,
  layoutStyle,
  narrowerThan,
  otherSide,
  shellSides,
  storedLayout,
  widthRange,
  withAllCollapsed,
  withCollapsed,
  withDismissed,
  withOneOpen,
  withWidth,
  yieldingSide,
  type ShellGeometry,
  type ShellLayout,
  type ShellMainSize,
  type ShellPanelSize,
  type ShellSide,
  type ShellState,
} from './layout.js';
import { Separator } from './Separator.js';

export interface ShellPanel {
  /** The panel's name after what is in it, «Tråder og filter»: the landmark's and its buttons'. */
  label: string;
  /** What the panel holds. It scrolls; the head and a pinned foot stay put. */
  children?: ReactNode;
  /** Controls that belong to the panel, on its head row beside «Skjul». Not on a rail. */
  head?: ReactNode;
  /** Pinned to the top of the panel's scrolling region, such as the view's heading. */
  pinned?: ReactNode;
  /** Hands the host the pinned region's element, `null` when it goes; pass a stable function. */
  pinnedRef?: ((element: HTMLDivElement | null) => void) | undefined;
  /** The panel's foot, such as its links. Not on a rail. */
  foot?: ReactNode;
  /** Keep the foot at the panel's bottom instead of at the end of what scrolls. */
  footPinned?: boolean | undefined;
  /** The design's width, the floor and the ceiling, in CSS pixels. */
  size?: Partial<ShellPanelSize> | undefined;
  /** Folded when the page opens, until the reader chooses. Primary open, secondary folded. */
  defaultCollapsed?: boolean | undefined;
  /** The landmark: `nav` for the primary panel and `aside` for the secondary one by default. */
  landmark?: 'nav' | 'aside' | undefined;
}

/** Something the host asks of a panel, once per object: `open`, `offer` or `close-drawers`. */
export type ShellRequest =
  { action: 'open' | 'offer'; side: ShellSide } | { action: 'close-drawers' };

export interface ShellProps {
  /** The panel before the main column. Left out, there is none. */
  primary?: ShellPanel | undefined;
  /** The panel after the main column. Left out, there is none. */
  secondary?: ShellPanel | undefined;
  /** The main column. */
  children?: ReactNode;
  /** Pinned to the top of the main column while it scrolls. */
  mainPinned?: ReactNode;
  /** The main column's floor and reading width, 640 and 800 by default. */
  mainSize?: Partial<ShellMainSize> | undefined;
  /** The `id` of `<main>`, the target of «Hopp til hovedinnhold». */
  mainId?: string | undefined;
  /** The layout to start from, as stored from `onLayoutChange`. Read once. */
  initialLayout?: ShellLayout | undefined;
  /** The reader changed the layout. The host stores it, and passes it back as `initialLayout`. */
  onLayoutChange?: ((layout: ShellLayout) => void) | undefined;
  request?: ShellRequest | undefined;
  /** Below 774 by default the rails stand in a row above the main column; `false` keeps them. */
  compactBar?: boolean | undefined;
  /** More skip links, after «Hopp til hovedinnhold». */
  skipLinks?: ReactNode;
  /** The gap beside an open panel in CSS pixels. Must match `--genai-shell-gap`. */
  gap?: number | undefined;
  /** A folded panel's width in CSS pixels. Must match the rail's button and padding. */
  rail?: number | undefined;
  /** Designsystemet's `data-color` for the shell, set only when given. */
  color?: string | undefined;
  className?: string | undefined;
}

const colored = (color: string | undefined) => (color ? { 'data-color': color } : {});

const sized = (side: ShellSide, size: Partial<ShellPanelSize> | undefined) => ({
  width: size?.width ?? defaultPanelSizes[side].width,
  minWidth: size?.minWidth ?? defaultPanelSizes[side].minWidth,
  maxWidth: size?.maxWidth ?? defaultPanelSizes[side].maxWidth,
});

/** Three columns: a primary panel, the main column and a secondary panel, as in VS Code. */
export const Shell = ({
  primary,
  secondary,
  children,
  mainPinned,
  mainSize,
  mainId = 'main-content',
  initialLayout,
  onLayoutChange,
  request,
  compactBar = true,
  skipLinks,
  gap = defaultGap,
  rail = defaultRail,
  color,
  className,
}: ShellProps) => {
  const t = useT();
  const p = primary ? sized('primary', primary.size) : undefined;
  const s = secondary ? sized('secondary', secondary.size) : undefined;
  const mainMin = mainSize?.minWidth ?? defaultMainSize.minWidth;
  const mainMax = mainSize?.maxWidth ?? defaultMainSize.maxWidth;
  const geometry = useMemo<ShellGeometry>(
    () => ({
      panels: { ...(p ? { primary: p } : {}), ...(s ? { secondary: s } : {}) },
      main: { minWidth: mainMin, maxWidth: mainMax },
      gap,
      rail,
    }),
    // The numbers, not the objects, which are new on every render.
    [
      p?.width,
      p?.minWidth,
      p?.maxWidth,
      s?.width,
      s?.minWidth,
      s?.maxWidth,
      mainMin,
      mainMax,
      gap,
      rail,
    ],
  );
  const points = breakpoints(geometry);

  const viewport = useViewportWidth();
  const narrow = useMedia(narrowerThan(points.both));
  const drawer = useMedia(narrowerThan(points.drawer));
  const compact = useMedia(narrowerThan(points.compact)) && compactBar;

  const [state, setState] = useState<ShellState>(() =>
    initialState(
      geometry,
      {
        primary: primary?.defaultCollapsed ?? defaultCollapsed.primary,
        secondary: secondary?.defaultCollapsed ?? defaultCollapsed.secondary,
      },
      initialLayout,
    ),
  );

  // Open or fold a panel; where both do not fit, the one being opened wins.
  const fitted = (current: ShellState, side: ShellSide, collapsed: boolean) => {
    const next = withCollapsed(current, side, collapsed);
    return collapsed || !narrow ? next : withOneOpen(next, side);
  };
  // What the reader does by hand also says whether they shut the panel themselves.
  const byReader = (side: ShellSide, collapsed: (current: ShellState) => boolean) =>
    setState((current) => {
      const value = collapsed(current);
      return withDismissed(fitted(current, side, value), side, value);
    });

  // Too narrow for both: the yielding panel folds on the crossing, during render.
  const [appliedNarrow, setAppliedNarrow] = useState(false);
  if (narrow !== appliedNarrow) {
    setAppliedNarrow(narrow);
    if (narrow) setState((current) => withOneOpen(current, otherSide(yieldingSide(geometry))));
  }

  // Entering drawer mode folds both, since a drawer is modal; crossing back opens nothing.
  const [appliedDrawer, setAppliedDrawer] = useState(false);
  if (drawer !== appliedDrawer) {
    setAppliedDrawer(drawer);
    if (drawer) setState(withAllCollapsed);
  }

  // The host's request, once per object, also one given on the first render.
  const [seenRequest, setSeenRequest] = useState<ShellRequest | undefined>(undefined);
  if (request !== seenRequest) {
    setSeenRequest(request);
    if (request?.action === 'open') {
      const { side } = request;
      setState((current) => withDismissed(fitted(current, side, false), side, false));
    } else if (request?.action === 'offer') {
      const { side } = request;
      setState((current) => {
        // Never as a drawer, never over the reader's choice, never at the other panel's cost.
        const room = !narrow || current.collapsed[otherSide(side)];
        if (!current.collapsed[side] || current.dismissed[side] || drawer || !room) return current;
        return fitted(current, side, false);
      });
    } else if (request?.action === 'close-drawers' && drawer) {
      setState((current) =>
        shellSides.reduce(
          (next, side) =>
            next.collapsed[side]
              ? next
              : withDismissed(withCollapsed(next, side, true), side, true),
          current,
        ),
      );
    }
  }

  // Reported once per commit from an effect, not on mount unless a rule changed the layout.
  const stored = storedLayout(geometry, state);
  const storedKey = JSON.stringify(stored);
  const [mountedKey] = useState(storedKey);
  const reported = useRef(mountedKey);
  const report = useRef(onLayoutChange);
  useEffect(() => {
    report.current = onLayoutChange;
  });
  useEffect(() => {
    if (storedKey === reported.current) return;
    reported.current = storedKey;
    report.current?.(stored);
    // `stored` is new on every render; its key says when it changed.
  }, [storedKey]);

  // `main` scrolls and fills the field between the panels, so the wheel works in the margins.
  const [mainElement, setMainElement] = useState<HTMLElement | null>(null);
  const [mainHead, setMainHead] = useState<HTMLDivElement | null>(null);
  useScrollPadding(mainElement, mainHead);
  // A tab stop while nothing inside takes the keyboard (WCAG 2.1.1), kept while focused.
  const [mainNeedsTabStop, measureMain] = useScrollTabStop();
  const [mainHoldsFocus, setMainHoldsFocus] = useState(false);
  const mainFocusable = mainNeedsTabStop || mainHoldsFocus;
  // Stable, or React would hand the region to a new ref on every render.
  const setMain = useCallback(
    (node: HTMLElement | null) => {
      setMainElement(node);
      measureMain(node);
    },
    [measureMain],
  );

  const sideProps = {
    geometry,
    state,
    viewport,
    drawer,
    onToggle: (side: ShellSide) => byReader(side, (current) => !current.collapsed[side]),
    onCollapse: (side: ShellSide, collapsed: boolean) => byReader(side, () => collapsed),
    onWidth: (side: ShellSide, width: number) =>
      setState((current) => withWidth(geometry, current, side, width)),
  };

  return (
    <>
      <SkipLink href={`#${mainId}`}>{t('shell.skipToMain')}</SkipLink>
      {skipLinks}
      <div
        className={classes('uib-shell', className)}
        data-compact={compact || undefined}
        data-drawer={drawer || undefined}
        style={layoutStyle(geometry, state, viewport, drawer, compact) as CSSProperties}
        {...colored(color)}
      >
        {primary ? <Side side="primary" panel={primary} {...sideProps} /> : null}

        <main
          className={classes('uib-shell-main', mainFocusable && 'ds-focus--inset')}
          id={mainId}
          // Observes only whether the focus is on the region itself.
          onBlur={(event) => {
            if (event.target === event.currentTarget) setMainHoldsFocus(false);
          }}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setMainHoldsFocus(true);
          }}
          ref={setMain}
          tabIndex={mainFocusable ? 0 : undefined}
        >
          <div className="uib-shell-column">
            {/* First in the region, so nothing reachable ends up under it once pinned. */}
            <div className="uib-shell-pinned" ref={setMainHead}>
              {mainPinned}
            </div>
            {children}
          </div>
        </main>

        {secondary ? <Side side="secondary" panel={secondary} {...sideProps} /> : null}
      </div>
    </>
  );
};

interface SideProps {
  side: ShellSide;
  panel: ShellPanel;
  geometry: ShellGeometry;
  state: ShellState;
  viewport: number;
  /** Draw an open panel over the main column rather than beside it. */
  drawer: boolean;
  onToggle: (side: ShellSide) => void;
  onCollapse: (side: ShellSide, collapsed: boolean) => void;
  onWidth: (side: ShellSide, width: number) => void;
}

/** One side panel: a rail when folded, a drawer in a narrow window. */
const Side = ({
  side,
  panel,
  geometry,
  state,
  viewport,
  drawer,
  onToggle,
  onCollapse,
  onWidth,
}: SideProps) => {
  const t = useT();
  const collapsed = state.collapsed[side];
  const name = panel.label.toLocaleLowerCase(t.locale === 'nb' ? 'nb-NO' : 'en-GB');
  const contentId = useId();
  const Landmark = panel.landmark ?? (side === 'primary' ? 'nav' : 'aside');
  const Icon = side === 'primary' ? SidebarLeftIcon : SidebarRightIcon;

  const toggle = useRef<HTMLButtonElement>(null);
  const element = useRef<HTMLElement>(null);
  const [content, setContentElement] = useState<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState<HTMLDivElement | null>(null);
  useScrollPadding(content, pinned, !collapsed);
  const onPinned = panel.pinnedRef;
  useEffect(() => {
    if (!onPinned || !pinned) return;
    onPinned(pinned);
    return () => onPinned(null);
  }, [onPinned, pinned]);

  // A tab stop while nothing in it is reachable, kept while focused; a group, not a region.
  const [needsTabStop, measureContent] = useScrollTabStop();
  const [holdsFocus, setHoldsFocus] = useState(false);
  const focusable = needsTabStop || holdsFocus;
  const setContent = useCallback(
    (node: HTMLDivElement | null) => {
      setContentElement(node);
      measureContent(node);
    },
    [measureContent],
  );

  // Whether focus is in the panel, as state, since the repair below needs the value before.
  const [hasFocus, setHasFocus] = useState(false);

  // A drag that folds the panel goes on until let go; dropped in drawer mode.
  const [resizing, setResizing] = useState(false);
  if (resizing && drawer) setResizing(false);

  // Focus that the folding panel held goes to its button, not `<body>` (WCAG 2.4.3).
  useLayoutEffect(() => {
    if (!hasFocus) return;
    // Lost if nowhere, detached, or in the folded content; this runs before the browser moves it.
    const active = document.activeElement;
    const lost =
      active === null ||
      active === document.body ||
      !active.isConnected ||
      (collapsed && (content?.contains(active) ?? false));
    if (lost) toggle.current?.focus();
  }, [hasFocus, collapsed, resizing, content]);

  // Focus lent to a dialog comes back to the button if the panel folded meanwhile.
  const lentToDialog = useRef(false);
  useEffect(() => {
    const onClose = (event: Event) => {
      const lent = lentToDialog.current;
      lentToDialog.current = false;
      if (!lent) return;
      const active = document.activeElement;
      const lost =
        active === null ||
        active === document.body ||
        !active.isConnected ||
        (event.target instanceof Node && event.target.contains(active));
      if (lost) toggle.current?.focus();
    };
    document.addEventListener('close', onClose, true);
    return () => document.removeEventListener('close', onClose, true);
  }, []);

  // A rail on the row, folded or in drawer mode, is not a shut panel: the button is an icon.
  const railed = collapsed || drawer;
  // Only the word: the whole name does not fit beside the head's controls.
  const showsWord = side === 'primary' && !railed;
  // The button stands at the panel's edge towards the main column.
  const toggleLast = side === 'primary';
  // Must equal the tooltip, which Designsystemet otherwise writes over `aria-label`.
  const toggleLabel = t(collapsed ? 'shell.showPanel' : 'shell.hidePanel', { panel: name });

  const range = widthRange(geometry, state, side, viewport);
  const width = fittedWidths(geometry, state, viewport)[side];

  const footScrolls = !panel.footPinned && panel.foot != null;
  const foot = panel.foot == null ? null : <div className="uib-shell-foot">{panel.foot}</div>;

  // One definition for the row and the drawer. A closed `<dialog>` hides it without `hidden`.
  const panelContent = (
    <div
      aria-label={focusable ? panel.label : undefined}
      className={classes('uib-shell-content', focusable && 'ds-focus--inset')}
      hidden={(collapsed && !drawer) || undefined}
      id={contentId}
      onBlur={(event) => {
        if (event.target === event.currentTarget) setHoldsFocus(false);
      }}
      onFocus={(event) => {
        if (event.target === event.currentTarget) setHoldsFocus(true);
      }}
      ref={setContent}
      role={focusable ? 'group' : undefined}
      tabIndex={focusable ? 0 : undefined}
    >
      {/* First: a pinned head covers what is above it, focus included. */}
      <div className="uib-shell-pinned" ref={setPinned}>
        {panel.pinned}
      </div>
      {panel.children}
      {footScrolls ? foot : null}
    </div>
  );

  const toggleButton = (
    <Tooltip
      content={toggleLabel}
      // Not `top` for the secondary panel, which would flip over it or overflow the window.
      placement={side === 'secondary' ? (railed ? 'left' : 'right') : 'top'}
    >
      <Button
        aria-controls={contentId}
        aria-expanded={!collapsed}
        aria-label={toggleLabel}
        className={classes('uib-shell-toggle', showsWord && 'uib-shell-hide')}
        // Pinned to neutral, as kunnskapsassistenten draws it: the panel's own control.
        data-color="neutral"
        data-size="sm"
        icon={!showsWord}
        onClick={() => onToggle(side)}
        ref={toggle}
        variant="tertiary"
      >
        {showsWord ? t('shell.hide') : null}
        <Icon aria-hidden />
      </Button>
    </Tooltip>
  );

  return (
    <Landmark
      aria-label={panel.label}
      className="uib-shell-side"
      // What stands here on the row: a drawer leaves a rail, open or shut.
      data-collapsed={railed || undefined}
      data-drawer={drawer || undefined}
      data-side={side}
      onBlur={(event) => {
        const to = event.relatedTarget;
        const leaving = !element.current?.contains(to);
        if (leaving) setHasFocus(false);
        lentToDialog.current =
          leaving && to instanceof HTMLElement && to.closest('dialog[open]') !== null;
      }}
      onFocus={() => setHasFocus(true)}
      ref={element}
    >
      {/* The separator is in the landmark but outside this clipping box. */}
      <div className="uib-shell-box">
        {/* Outside the scroller, so the button never scrolls out of sight. */}
        <div className="uib-shell-header">
          {toggleLast ? null : toggleButton}
          {railed ? null : <div className="uib-shell-head">{panel.head}</div>}
          {toggleLast ? toggleButton : null}
        </div>
        {drawer ? null : panelContent}
        {railed || footScrolls ? null : foot}
      </div>

      {/* A native modal dialog, kept mounted so what is in it keeps its state. */}
      {drawer ? (
        <Dialog
          aria-label={panel.label}
          className="uib-shell-drawer"
          closeButton={t('shell.closePanel', { panel: name })}
          data-side={side}
          onClose={() => onCollapse(side, true)}
          open={!collapsed}
          placement={drawerPlacement(side)}
        >
          <div className="uib-shell-box">
            <div className="uib-shell-header">
              <div className="uib-shell-head">{panel.head}</div>
            </div>
            {panelContent}
            {footScrolls ? null : foot}
          </div>
        </Dialog>
      ) : null}

      {/* Not on a rail, except while the drag that folded the panel is held, so it can reopen it. */}
      {railed && !resizing ? null : (
        <Separator
          direction={growthDirection(side)}
          fixed={range.min === range.max}
          folded={collapsed}
          name={name}
          onDraggingChange={setResizing}
          onFold={(folded) => onCollapse(side, folded)}
          onReset={() => onWidth(side, geometry.panels[side]?.width ?? width)}
          onResize={(next) => onWidth(side, clampWidth(next, range))}
          range={range}
          side={side}
          width={width}
        />
      )}
    </Landmark>
  );
};
