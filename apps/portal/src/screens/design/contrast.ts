type Rgba = [number, number, number, number];

export const parseColor = (value: string): Rgba | undefined => {
  const found = /rgba?\(([^)]+)\)/.exec(value);
  if (!found?.[1]) return undefined;
  const parts = found[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  const [r = 0, g = 0, b = 0, a = 1] = parts;
  return [r, g, b, a];
};

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: Rgba) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export const contrast = (a: Rgba, b: Rgba) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** The first opaque background behind the element, white when there is none. */
export const backgroundOf = (element: Element | null): Rgba => {
  for (let el = element; el; el = el.parentElement) {
    const color = parseColor(getComputedStyle(el).backgroundColor);
    if (color && color[3] > 0.5) return color;
  }
  return [255, 255, 255, 1];
};

export interface Measured {
  text?: number | undefined;
  subtle?: number | undefined;
  accent?: number | undefined;
  iconsHidden: boolean;
  alert: boolean;
  live: boolean;
}

const hasOwnText = (el: Element) =>
  Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');

/** Contrast of what is drawn in `root`, read from the computed styles of the real preview. */
export const measure = (root: HTMLElement): Measured => {
  const texts = Array.from(root.querySelectorAll('*')).filter(hasOwnText);
  const ratios = texts.flatMap((el) => {
    const color = parseColor(getComputedStyle(el).color);
    return color ? [contrast(color, backgroundOf(el))] : [];
  });
  const button = root.querySelector('button, a[href], [role="button"]');
  const border = button ? parseColor(getComputedStyle(button).borderTopColor) : undefined;
  const accent =
    button && border && border[3] > 0
      ? contrast(border, backgroundOf(button.parentElement))
      : undefined;
  return {
    text: ratios.length ? Math.max(...ratios) : undefined,
    subtle: ratios.length ? Math.min(...ratios) : undefined,
    accent,
    iconsHidden: Array.from(root.querySelectorAll('svg')).every(
      (svg) => svg.getAttribute('aria-hidden') === 'true' || svg.closest('[aria-hidden="true"]'),
    ),
    alert: root.querySelector('[role="alert"]') !== null,
    live: root.querySelector('[aria-live], [role="status"], [aria-busy="true"]') !== null,
  };
};
