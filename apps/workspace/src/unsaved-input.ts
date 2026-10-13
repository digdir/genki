type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

interface Snapshot {
  hash: string;
  fields: { key: string; value: string }[];
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const storageKey = 'genai.unsaved-input';
const skipped = new Set(['file', 'password', 'hidden', 'checkbox', 'radio', 'submit', 'button']);

const fieldsIn = (root: ParentNode) =>
  [...root.querySelectorAll<Field>('input, textarea, select')].filter(
    (el) => !(el instanceof HTMLInputElement && skipped.has(el.type)) && !el.disabled,
  );

const labelOf = (el: Field) =>
  el.getAttribute('aria-label') ??
  [...(el.labels ?? [])].map((l) => l.textContent?.trim() ?? '').join(' ') ??
  '';

const keyed = (root: ParentNode) => {
  const seen = new Map<string, number>();
  return fieldsIn(root).map((el) => {
    const base = `${el.tagName}|${el.getAttribute('name') ?? ''}|${labelOf(el)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: `${base}|${n}`, el };
  });
};

export const saveUnsavedInput = (
  store: Store,
  root: ParentNode = document,
  hash = location.hash,
) => {
  const fields = keyed(root)
    .filter(({ el }) => el.value.trim() !== '')
    .map(({ key, el }) => ({ key, value: el.value }));
  if (fields.length === 0) return;
  store.setItem(storageKey, JSON.stringify({ hash, fields } satisfies Snapshot));
};

export const pendingInputHash = (store: Store) => {
  try {
    return (JSON.parse(store.getItem(storageKey) ?? 'null') as Snapshot | null)?.hash;
  } catch {
    return undefined;
  }
};

const setValue = (el: Field, value: string) => {
  const proto = Object.getPrototypeOf(el) as object;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

export const restoreUnsavedInput = (
  store: Store,
  root: ParentNode = document,
  waitMs = 10_000,
): (() => void) => {
  let snapshot: Snapshot | null;
  try {
    snapshot = JSON.parse(store.getItem(storageKey) ?? 'null') as Snapshot | null;
  } catch {
    snapshot = null;
  }
  if (!snapshot) return () => undefined;
  const left = new Map(snapshot.fields.map((f) => [f.key, f.value]));
  const fill = () => {
    for (const { key, el } of keyed(root)) {
      const value = left.get(key);
      if (value === undefined || el.value !== '') continue;
      setValue(el, value);
      left.delete(key);
    }
    if (left.size === 0) stop();
  };
  const observer = new MutationObserver(fill);
  const timer = setTimeout(() => stop(), waitMs);
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    store.removeItem(storageKey);
  };
  observer.observe(root instanceof Document ? root.body : (root as Node), {
    childList: true,
    subtree: true,
  });
  fill();
  return stop;
};
