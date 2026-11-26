// Where a demo command points, so the recorded pointer can glide there instead of jumping.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Target =
  | { by: 'role'; role: string; name: string; exact: boolean }
  | { by: 'name'; name: string; exact: boolean; text: boolean }
  | { by: 'selector'; selector: string };

const valueFlags = new Set(['--name', '--text', '--timeout', '--load', '--url']);

const positional = (command: string[]) =>
  command.filter((p, i) => !p.startsWith('--') && !valueFlags.has(command[i - 1] ?? ''));

const flag = (command: string[], name: string) => {
  const i = command.indexOf(name);
  return i < 0 ? undefined : command[i + 1];
};

const pointing = new Set([
  'click',
  'dblclick',
  'hover',
  'fill',
  'type',
  'check',
  'uncheck',
  'select',
  'focus',
  'scrollintoview',
]);

const findPointing = new Set(['click', 'fill', 'check', 'hover']);

const gestures = new Set(['hover', 'focus', 'scroll', 'scrollintoview']);

export const targetOf = (command: string[]): Target | undefined => {
  const [name, ...rest] = positional(command);
  const exact = command.includes('--exact');
  if (name === 'find') {
    const [locator, value, action = 'click'] = rest;
    if (!value || !findPointing.has(action)) return undefined;
    if (locator === 'role')
      return { by: 'role', role: value, name: flag(command, '--name') ?? '', exact };
    if (locator === 'label' || locator === 'text')
      return { by: 'name', name: value, exact, text: locator === 'text' };
    return undefined;
  }
  if (!name || !pointing.has(name) || !rest[0]) return undefined;
  return { by: 'selector', selector: rest[0] };
};

export const changesPage = (command: string[]) => {
  const [name, , , action = 'click'] = positional(command);
  if (name === 'find') return action !== 'hover' && action !== 'text';
  return !gestures.has(name ?? '');
};

export const voiceCue = (commands: string[][]) => commands.findLastIndex(changesPage);

const leaving = new Set(['open', 'back', 'forward', 'reload', 'pushstate', 'click', 'dblclick']);

export const navigates = (command: string[]) => {
  const [name, , , action = 'click'] = positional(command);
  return name === 'find' ? action === 'click' : leaving.has(name ?? '');
};

export const focusTarget = (focus: string[]): Target | undefined => {
  const [kind, value, name] = focus;
  if (!value) return undefined;
  if (kind === 'role') return { by: 'role', role: value, name: name ?? '', exact: false };
  if (kind === 'text' || kind === 'label')
    return { by: 'name', name: value, exact: false, text: kind === 'text' };
  if (kind === 'css') return { by: 'selector', selector: value };
  return undefined;
};

export const focusArea = (box: Box, [w, h]: [number, number]): Box => {
  const pad = 16;
  const width = Math.min(w, Math.max(box.width + 2 * pad, w * 0.45));
  const height = Math.min(h, Math.max(box.height + 2 * pad, h * 0.4));
  return {
    x: Math.round(Math.min(Math.max(0, box.x - pad), w - width)),
    y: Math.round(Math.min(Math.max(0, box.y - pad), h - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
};

const line = /^( *)- (\w+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/;
const refIn = /\bref=(e\d+)\b/;

const matches = (name: string, wanted: string, exact: boolean) =>
  exact ? name === wanted : name.toLowerCase().includes(wanted.toLowerCase());

export const refOf = (snapshot: string, target: Target): string | undefined => {
  if (target.by === 'selector') return target.selector;
  const parents: { depth: number; ref: string }[] = [];
  const found: { ref: string; name: string }[] = [];
  for (const row of snapshot.split('\n')) {
    const m = line.exec(row);
    if (!m) continue;
    const depth = (m[1] ?? '').length;
    const role = m[2] ?? '';
    const name = (m[3] ?? '').replace(/\\(.)/g, '$1');
    while (parents.length && (parents.at(-1)?.depth ?? 0) >= depth) parents.pop();
    const ref = refIn.exec(m[4] ?? '')?.[1];
    const own = ref ?? (role === 'StaticText' ? parents.at(-1)?.ref : undefined);
    if (ref) parents.push({ depth, ref });
    if (!own || role === 'generic' || !matches(name, target.name, target.exact)) continue;
    if (target.by === 'role' && role.toLowerCase() !== target.role.toLowerCase()) continue;
    if (target.by === 'name' && !target.text && role === 'StaticText') continue;
    if (target.by === 'role') return own;
    found.push({ ref: own, name });
  }
  const best = found.sort((a, b) => a.name.length - b.name.length)[0]?.ref;
  return best ?? (target.by === 'role' && !target.name ? landmarks[target.role] : undefined);
};

const landmarks: Record<string, string> = {
  table: 'table',
  main: 'main',
  navigation: 'nav',
  form: 'form',
  list: 'ul, ol',
  region: 'section',
};

export const centre = (box: Box): Point => ({
  x: Math.round(box.x + box.width / 2),
  y: Math.round(box.y + Math.min(box.height / 2, 40)),
});

export const glideMs = (from: Point, to: Point) =>
  Math.round(Math.min(1100, Math.max(450, 300 + Math.hypot(to.x - from.x, to.y - from.y) * 0.6)));

export const scrollBy = (box: Box, height: number) => {
  const y = centre(box).y;
  return y < height * 0.15 || y > height * 0.85 ? Math.round(y - height * 0.45) : 0;
};

export const smoothScrollScript = (delta: number) =>
  `(()=>{let e=document.elementFromPoint(innerWidth/2,innerHeight/2);while(e&&e!==document.body&&!(/(auto|scroll)/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight))e=e.parentElement;(e&&e!==document.body?e:document.scrollingElement).scrollBy({top:${JSON.stringify(Number(delta) || 0)},behavior:'smooth'});})()`;
