import type { JsonPatchOp } from './types.js';

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

export const pointerSegments = (pointer: string): string[] => {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new PatchError(`${pointer} is not a JSON pointer`);
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
};

export const dotted = (pointer: string) => {
  try {
    return (
      pointerSegments(pointer)
        .map((s) => (/^\d+$/.test(s) ? `[${s}]` : `.${s}`))
        .join('')
        .replace(/^\./, '') || '(hele)'
    );
  } catch {
    return pointer;
  }
};

type Container = Record<string, unknown> | unknown[];

const isContainer = (value: unknown): value is Container =>
  value !== null && typeof value === 'object';

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

const parentOf = (root: unknown, segments: string[]): { parent: Container; key: string } => {
  if (segments.length === 0) throw new PatchError('the root cannot be changed');
  const forbidden = segments.find((segment) => forbiddenKeys.has(segment));
  if (forbidden !== undefined) throw new PatchError(`${forbidden} is not allowed`);
  let current: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isContainer(current)) throw new PatchError(`no object at ${segment}`);
    if (Array.isArray(current)) current = current[Number(segment)];
    else {
      if (!Object.hasOwn(current, segment)) throw new PatchError(`no object at ${segment}`);
      current = current[segment];
    }
  }
  if (!isContainer(current)) throw new PatchError('the parent does not exist');
  return { parent: current, key: segments.at(-1) ?? '' };
};

const indexOf = (array: unknown[], key: string, allowEnd: boolean) => {
  if (key === '-' && allowEnd) return array.length;
  if (!/^(0|[1-9]\d*)$/.test(key)) throw new PatchError(`${key} is not an array index`);
  const index = Number(key);
  if (index > array.length || (!allowEnd && index === array.length))
    throw new PatchError(`index ${index} is out of range`);
  return index;
};

const read = (root: unknown, pointer: string): unknown => {
  let current: unknown = root;
  for (const segment of pointerSegments(pointer)) {
    if (!isContainer(current)) throw new PatchError(`nothing at ${pointer}`);
    if (Array.isArray(current)) current = current[indexOf(current, segment, false)];
    else {
      if (!Object.hasOwn(current, segment)) throw new PatchError(`nothing at ${pointer}`);
      current = current[segment];
    }
  }
  return current;
};

const remove = (root: unknown, pointer: string): unknown => {
  const { parent, key } = parentOf(root, pointerSegments(pointer));
  if (Array.isArray(parent)) return parent.splice(indexOf(parent, key, false), 1)[0];
  if (!Object.hasOwn(parent, key)) throw new PatchError(`nothing at ${pointer}`);
  const value = parent[key];
  Reflect.deleteProperty(parent, key);
  return value;
};

const add = (root: unknown, pointer: string, value: unknown) => {
  const { parent, key } = parentOf(root, pointerSegments(pointer));
  if (Array.isArray(parent)) parent.splice(indexOf(parent, key, true), 0, value);
  else parent[key] = value;
};

const replace = (root: unknown, pointer: string, value: unknown) => {
  const { parent, key } = parentOf(root, pointerSegments(pointer));
  if (Array.isArray(parent)) parent[indexOf(parent, key, false)] = value;
  else {
    if (!Object.hasOwn(parent, key)) throw new PatchError(`nothing at ${pointer}`);
    parent[key] = value;
  }
};

export const sameJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!isContainer(a) || !isContainer(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  const ak = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const bk = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return (
    ak.length === bk.length &&
    ak.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
};

export const applyPatch = <T>(document: T, ops: JsonPatchOp[]): T => {
  const copy = structuredClone(document);
  for (const op of ops) {
    switch (op.op) {
      case 'add':
        add(copy, op.path, structuredClone(op.value));
        break;
      case 'remove':
        remove(copy, op.path);
        break;
      case 'replace':
        replace(copy, op.path, structuredClone(op.value));
        break;
      case 'move': {
        if (op.path.startsWith(`${op.from}/`))
          throw new PatchError('cannot move a value into itself');
        add(copy, op.path, remove(copy, op.from));
        break;
      }
      case 'copy':
        add(copy, op.path, structuredClone(read(copy, op.from)));
        break;
      case 'test':
        if (!sameJson(read(copy, op.path), op.value))
          throw new PatchError(`test failed at ${op.path}`);
        break;
    }
  }
  return copy;
};
