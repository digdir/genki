import { useEffect, useState, type MouseEvent } from 'react';

export const priceSegment = 'price-and-terms';
export const pricePath = `#/about/${priceSegment}`;

export const siteName = 'Genki';

export const useDocumentTitle = (title: string, whole = false) => {
  useEffect(() => {
    document.title = whole ? title : `${title} | ${siteName}`;
  }, [title, whole]);
};

const below = (px: number) => window.innerWidth < px;

export const useBelow = (px: number) => {
  const [value, setValue] = useState(() => below(px));
  useEffect(() => {
    const update = () => setValue(below(px));
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [px]);
  return value;
};

export const jumpTo = (id: string) => (event: MouseEvent<HTMLAnchorElement>) => {
  event.preventDefault();
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
};
