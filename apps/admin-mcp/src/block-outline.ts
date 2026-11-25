export interface OutlinePayload {
  tier: 'declarative' | 'code';
  reads: string[];
  texts?: Record<string, Record<string, string>> | undefined;
  template?: unknown;
}

type Tree = Record<string, unknown>;

const isRecord = (value: unknown): value is Tree =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const maxLines = 200;
const shownRows = 3;

interface Scope {
  data: Tree;
  items: Map<string, unknown>;
}

const valueAt = (path: string, scope: Scope): unknown => {
  const [head = '', ...rest] = path.split('.');
  let value: unknown = scope.items.has(head)
    ? scope.items.get(head)
    : Object.hasOwn(scope.data, head)
      ? scope.data[head]
      : undefined;
  for (const key of rest) {
    if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
};

const listAt = (path: string, scope: Scope) => {
  const value = valueAt(path, scope);
  return Array.isArray(value) ? value : [];
};

const plain = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';

/** What a declarative block would draw with the given data, as indented lines of text. */
export const blockOutline = (payload: OutlinePayload, data: Tree, state: string): string => {
  if (payload.tier === 'code')
    return `- drawn by its own code in a sandboxed frame, given ${payload.reads.length ? payload.reads.join(', ') : 'no data'}`;
  const texts = payload.texts?.nb ?? {};
  const textOf = (text: unknown, scope: Scope): string => {
    const parts = Array.isArray(text) ? text : [text];
    return parts
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!isRecord(part)) return '';
        if (typeof part.bind === 'string') return plain(valueAt(part.bind, scope));
        if (typeof part.count === 'string') return String(listAt(part.count, scope).length);
        if (typeof part.t !== 'string') return '';
        const args = isRecord(part.args) ? part.args : {};
        let count: number | undefined;
        const values = new Map<string, string>();
        for (const [name, arg] of Object.entries(args)) {
          if (typeof arg === 'string') values.set(name, plain(valueAt(arg, scope)));
          else if (isRecord(arg) && typeof arg.count === 'string') {
            const n = listAt(arg.count, scope).length;
            if (name === 'count') count = n;
            values.set(name, String(n));
          }
        }
        const key = count === undefined ? part.t : `${part.t}.${count === 1 ? 'one' : 'other'}`;
        const template = texts[key] ?? texts[`${part.t}.other`] ?? `[${part.t}]`;
        return template.replace(
          /\{([a-zA-Z][a-zA-Z0-9]{0,31})\}/g,
          (whole, name: string) => values.get(name) ?? whole,
        );
      })
      .join('');
  };
  const holds = (when: unknown, scope: Scope): boolean => {
    if (!isRecord(when)) return false;
    if (typeof when.exists === 'string') return valueAt(when.exists, scope) !== undefined;
    if (typeof when.empty === 'string') return listAt(when.empty, scope).length === 0;
    if (typeof when.state === 'string') return when.state === state;
    if (Array.isArray(when.equals))
      return plain(valueAt(String(when.equals[0]), scope)) === plain(when.equals[1]);
    if ('not' in when) return !holds(when.not, scope);
    return false;
  };
  const out: string[] = [];
  const stack: { node: unknown; depth: number; scope: Scope }[] = [];
  const push = (nodes: unknown, depth: number, scope: Scope) => {
    if (!Array.isArray(nodes)) return;
    for (let i = nodes.length - 1; i >= 0; i -= 1) stack.push({ node: nodes[i], depth, scope });
  };
  const template = isRecord(payload.template) ? payload.template : {};
  const states = isRecord(template.states) ? template.states : {};
  push([states[state] ?? template.root], 0, { data, items: new Map() });
  while (stack.length > 0 && out.length < maxLines) {
    const { node, depth, scope } = stack.pop() as (typeof stack)[number];
    if (!isRecord(node)) continue;
    const line = (text: string) => out.push(`${'  '.repeat(depth)}- ${text}`);
    switch (node.type) {
      case 'each': {
        const rows = listAt(String(node.of), scope);
        const max = typeof node.max === 'number' ? node.max : 10;
        const drawn = rows.slice(0, Math.min(max, shownRows));
        line(`each ${String(node.of)}: ${Math.min(rows.length, max)} rows`);
        for (let i = drawn.length - 1; i >= 0; i -= 1)
          push(node.children, depth + 1, {
            data: scope.data,
            items: new Map(scope.items).set(String(node.as), drawn[i]),
          });
        break;
      }
      case 'if':
        push(holds(node.when, scope) ? node.then : node.else, depth, scope);
        break;
      case 'list':
        line(node.ordered ? 'numbered list' : 'list');
        push(node.items, depth + 1, scope);
        break;
      case 'details':
        line(`details: ${textOf(node.summary, scope)}`);
        push(node.children, depth + 1, scope);
        break;
      case 'stack':
      case 'row':
      case 'card':
        line(String(node.type));
        push(node.children, depth + 1, scope);
        break;
      case 'link':
        line(`link: ${textOf(node.text, scope)}`);
        break;
      case 'button':
        line(
          `button: ${textOf(node.text, scope)} (${isRecord(node.event) ? String(node.event.name) : ''})`,
        );
        break;
      case 'table':
        line(`table of ${String(node.rows)}: ${listAt(String(node.rows), scope).length} rows`);
        break;
      case 'keyValue':
        line('key and value');
        for (const item of Array.isArray(node.items) ? node.items : [])
          if (isRecord(item) && out.length < maxLines)
            out.push(
              `${'  '.repeat(depth + 1)}- ${textOf(item.key, scope)}: ${textOf(item.value, scope)}`,
            );
        break;
      case 'divider':
        line('divider');
        break;
      case 'icon':
        line(`icon ${String(node.name)}`);
        break;
      default:
        line(`${String(node.type)}: ${textOf(node.text, scope)}`);
    }
  }
  return out.join('\n') || '- nothing';
};
