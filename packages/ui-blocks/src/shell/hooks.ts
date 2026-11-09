import { useEffect, useState, useSyncExternalStore } from 'react';

const onResize = (change: () => void) => {
  window.addEventListener('resize', change);
  return () => window.removeEventListener('resize', change);
};

/**
 * The layout viewport's width, for fitting dragged panels. `clientWidth`, not `innerWidth`: on a
 * phone that is the visual viewport, which zooms out when the page is too wide and stays so. Not
 * a ResizeObserver on the shell, whose width depends on this number and would loop.
 */
export const useViewportWidth = () =>
  useSyncExternalStore(
    onResize,
    () => document.documentElement.clientWidth,
    () => Number.POSITIVE_INFINITY,
  );

/**
 * Whether a media query matches, read during render so the first paint is already right. A media
 * query, not CSS, wherever the answer changes what a button reports (`aria-expanded`).
 */
export const useMedia = (query: string) =>
  useSyncExternalStore(
    (change) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', change);
      return () => list.removeEventListener('change', change);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );

// What Tab can land on, by attribute rather than layout, so browsers and tests agree.
const tabbable = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(',');

const hasTabbable = (region: HTMLElement) => {
  for (const candidate of region.querySelectorAll(tabbable)) {
    if (candidate.getAttribute('tabindex') === '-1') continue;
    if (candidate.closest('[hidden], [inert]')) continue;
    return true;
  }
  return false;
};

/**
 * Whether a scrolling region needs a tab stop of its own: it scrolls and holds nothing the
 * keyboard can reach (WCAG 2.1.1, axe `scrollable-region-focusable`). Measured again on resize and
 * on every change of content; a callback ref, since the region moves into a drawer and back.
 */
export const useScrollTabStop = (): [boolean, (element: HTMLElement | null) => void] => {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [scrolls, setScrolls] = useState(false);
  const [reachable, setReachable] = useState(false);

  useEffect(() => {
    if (element === null) return;
    const measure = () => {
      setScrolls(element.scrollHeight > element.clientHeight);
      setReachable(hasTabbable(element));
    };
    const sizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    const watchSizes = () => {
      if (!sizes) return;
      sizes.disconnect();
      sizes.observe(element);
      for (const child of element.children) sizes.observe(child);
    };
    const content = new MutationObserver(() => {
      watchSizes();
      measure();
    });
    watchSizes();
    content.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'disabled',
        'hidden',
        'href',
        'inert',
        'tabindex',
        'contenteditable',
        'type',
      ],
    });
    measure();
    return () => {
      sizes?.disconnect();
      content.disconnect();
    };
  }, [element]);

  return [element !== null && scrolls && !reachable, setElement];
};

/** The pinned head's height, set on the region under it, for a block that pins its own head below. */
const pinnedSizeProperty = '--uib-shell-pinned-block-size';

/**
 * Scroll padding as tall as a pinned head, or scrolling into view and focus land under it (WCAG
 * 2.4.11), and the same height as `pinnedSizeProperty`. Observed, because the head changes with
 * its content. Also set at once whenever the region is shown: an observer reports after the next
 * frame's callbacks, so a block that scrolls to its target there, in a panel that just opened,
 * would land under the head. The effect runs after its children's, so a drawer's dialog is
 * already open when the head is measured.
 */
export const useScrollPadding = (
  region: HTMLElement | null,
  head: HTMLElement | null,
  shown = true,
) => {
  useEffect(() => {
    if (region === null || head === null) return;
    const pad = () => {
      const size = `${Math.round(head.offsetHeight)}px`;
      region.style.scrollPaddingBlockStart = size;
      region.style.setProperty(pinnedSizeProperty, size);
    };
    pad();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(pad);
    observer?.observe(head);
    return () => {
      observer?.disconnect();
      region.style.scrollPaddingBlockStart = '';
      region.style.removeProperty(pinnedSizeProperty);
    };
  }, [region, head, shown]);
};
