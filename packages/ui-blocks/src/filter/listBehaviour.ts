import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

// A list shows what is chosen first. When it opens, the values chosen then come first and the
// rest follow, each part in the order given. Nothing moves while it is open, so a value chosen or
// taken off there stays under the pointer; the order is taken again the next time it opens.
// Changes made with the list shut, as with «Velg alle» and «Tøm», show at the next opening.

/** The values the list puts first: those chosen when it opened, or, while it is shut, those
 * chosen now. u-datalist opens and shuts the list with `hidden`. It also keeps where the list
 * was scrolled, which would open the new order part way down, so an opening starts at the top. */
export const useChosenFirst = (
  selected: readonly string[],
  list: RefObject<HTMLElement | null>,
): ReadonlySet<string> => {
  const [atOpen, setAtOpen] = useState<readonly string[]>();
  const latest = useRef(selected);
  useLayoutEffect(() => {
    latest.current = selected;
  });

  useEffect(() => {
    const element = list.current;
    if (!element) return;
    let open = !element.hidden;
    const observer = new MutationObserver(() => {
      if (open === !element.hidden) return;
      open = !element.hidden;
      if (open) element.scrollTop = 0;
      setAtOpen(open ? latest.current : undefined);
    });
    observer.observe(element, { attributes: true, attributeFilter: ['hidden'] });
    return () => observer.disconnect();
  }, [list]);

  return useMemo(() => new Set(atOpen ?? selected), [atOpen, selected]);
};

/** The items that go first, then the rest, each part in the order given. */
export const chosenFirst = <T>(items: readonly T[], first: (item: T) => boolean): T[] => [
  ...items.filter(first),
  ...items.filter((item) => !first(item)),
];

// Designsystemet places the list when it opens: below the field, or above it when there is more
// room there (`flip`), and as high as the room allows (`size`). The height is set once. A choice
// can add a row of chips and move the field, and the list then follows it at its first height,
// out of the window or, flipped, over its top edge. So after a change with the list open, it is
// placed again, starting from the height that fits where it stands: it stays there, and does
// not jump over the field while the pointer is in it, until less than Designsystemet's least
// height is left.

/** Designsystemet's own: the room less 20 px, never under 50 px (`size` in its popover.ts). */
const MARGIN = 20;
const LEAST = 50;

export const useListFollowsField = (
  selected: readonly string[],
  list: RefObject<HTMLElement | null>,
  field: RefObject<HTMLInputElement | null>,
) => {
  useLayoutEffect(() => {
    const element = list.current;
    const input = field.current;
    if (!element || !input || element.hidden) return;
    // After u-combobox has put the new chips in their row, in its MutationObserver: until then
    // they stand elsewhere. Before the observers that move the list, so it never shows at the
    // old height.
    queueMicrotask(() => {
      if (!element.isConnected || element.hidden) return;
      const gap = Number.parseFloat(getComputedStyle(element).scrollMarginBottom) || 0;
      const box = input.getBoundingClientRect();
      const room = element.getAttribute('data-floating')?.startsWith('top')
        ? box.top - gap
        : document.documentElement.clientHeight - box.bottom - gap;
      element.style.maxHeight = `${Math.max(LEAST, room - MARGIN)}px`;
      // The event ds-suggestion sends when the list opens, which places it from the start.
      element.dispatchEvent(
        new CustomEvent('ds-toggle-source', { bubbles: true, composed: true, detail: input }),
      );
    });
  }, [selected, list, field]);
};
