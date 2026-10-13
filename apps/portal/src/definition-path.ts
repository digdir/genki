type Tree = Record<string, unknown>;

const isTree = (value: unknown): value is Tree =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const segments = (path: string) =>
  path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);

export const valueAt = (root: unknown, path: string): unknown =>
  segments(path).reduce<unknown>(
    (node, key) => (Array.isArray(node) ? node[Number(key)] : isTree(node) ? node[key] : undefined),
    root,
  );

export const setAt = <T extends Tree>(root: T, path: string, value: unknown): T => {
  const keys = segments(path);
  const copy = structuredClone(root);
  let node: Tree = copy;
  keys.slice(0, -1).forEach((key) => {
    if (!isTree(node[key]) && !Array.isArray(node[key])) node[key] = {};
    node = node[key] as Tree;
  });
  const last = keys.at(-1);
  if (last === undefined) return copy;
  if (value === undefined && !Array.isArray(node)) Reflect.deleteProperty(node, last);
  else node[last] = value;
  return copy;
};

export const leafPaths = (root: unknown): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (value: unknown, path: string) => {
    if (isTree(value))
      Object.entries(value).forEach(([k, v]) => walk(v, path ? `${path}.${k}` : k));
    else out.set(path, JSON.stringify(value));
  };
  walk(root, '');
  return out;
};

export const changedPaths = (before: unknown, after: unknown, ignore: string[] = []) => {
  const a = leafPaths(before);
  const b = leafPaths(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter(
    (p) => !ignore.includes(p) && a.get(p) !== b.get(p),
  );
};
