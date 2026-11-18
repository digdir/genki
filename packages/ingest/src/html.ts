export type ContentExtractor = (html: string) => string;

export interface WebPage {
  markdown: string;
  title?: string;
}

interface HtmlElement {
  tag: string;
  attrs: string;
  children: HtmlNode[];
}

type HtmlNode = HtmlElement | string;

const voidTags = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

const droppedTags = new Set([
  'nav',
  'aside',
  'form',
  'button',
  'dialog',
  'footer',
  'svg',
  'iframe',
  'select',
  'textarea',
  'object',
  'canvas',
]);

const droppedRoles =
  /^(navigation|banner|contentinfo|complementary|search|dialog|alertdialog|toolbar)$/i;

const boilerplateMarker =
  /cookie|consent|samtykke|gdpr|skip-?link|skip-?to|hopp-?til|share|sharing|social|deling|breadcrumb|brodsmule|newsletter/i;

const skipLinkText = /^\s*(hopp til|gå til|skip to)\b/i;

const tagPattern = /<(\/?)([a-zA-Z][\w:-]*)(?![\w:-])((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>/g;

const parseHtml = (html: string): HtmlElement => {
  const root: HtmlElement = { tag: '#root', attrs: '', children: [] };
  const stack = [root];
  let at = 0;
  for (const m of html.matchAll(tagPattern)) {
    const top = stack[stack.length - 1] as HtmlElement;
    if (m.index > at) top.children.push(html.slice(at, m.index));
    at = m.index + m[0].length;
    const tag = (m[2] as string).toLowerCase();
    if (m[1]) {
      const open = stack.findLastIndex((e) => e.tag === tag);
      if (open > 0) stack.length = open;
      continue;
    }
    const attrs = m[3] ?? '';
    const selfClosing = attrs.endsWith('/');
    const element: HtmlElement = {
      tag,
      attrs: selfClosing ? attrs.slice(0, -1) : attrs,
      children: [],
    };
    top.children.push(element);
    if (!selfClosing && !voidTags.has(tag)) stack.push(element);
  }
  if (at < html.length) (stack[stack.length - 1] as HtmlElement).children.push(html.slice(at));
  return root;
};

const attrPattern = /([^\s"'=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

const attr = (element: HtmlElement, name: string) => {
  for (const m of element.attrs.matchAll(attrPattern))
    if ((m[1] as string).toLowerCase() === name)
      return m[2] === undefined ? '' : m[2].replace(/^["']|["']$/g, '');
  return undefined;
};

const textOf = (node: HtmlNode): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('');

const isBoilerplate = (element: HtmlElement, region: HtmlElement) => {
  if (droppedTags.has(element.tag)) return true;
  if (element.tag === 'header' && (region.tag === 'body' || region.tag === '#root')) return true;
  if (attr(element, 'hidden') !== undefined || attr(element, 'aria-hidden') === 'true') return true;
  if (droppedRoles.test(attr(element, 'role') ?? '')) return true;
  const markers = [attr(element, 'class'), attr(element, 'id'), attr(element, 'aria-label')];
  if (markers.some((m) => m !== undefined && boilerplateMarker.test(m))) return true;
  return (
    element.tag === 'a' &&
    (attr(element, 'href') ?? '').startsWith('#') &&
    skipLinkText.test(textOf(element))
  );
};

const findFirst = (
  node: HtmlElement,
  match: (e: HtmlElement) => boolean,
): HtmlElement | undefined => {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (match(child)) return child;
    const found = findFirst(child, match);
    if (found) return found;
  }
  return undefined;
};

const render = (node: HtmlNode, region: HtmlElement): string => {
  if (typeof node === 'string') return node;
  if (node !== region && isBoilerplate(node, region)) return '';
  const inner = node.children.map((c) => render(c, region)).join('');
  if (node === region || node.tag === '#root') return inner;
  return voidTags.has(node.tag)
    ? `<${node.tag}${node.attrs}>`
    : `<${node.tag}${node.attrs}>${inner}</${node.tag}>`;
};

const rawTextTags = ['script', 'style', 'noscript', 'template'];

const rawTextTagAt = (lower: string, at: number) =>
  rawTextTags.find(
    (tag) => lower.startsWith(tag, at + 1) && !/\w/.test(lower[at + 1 + tag.length] ?? ''),
  );

const withoutRawText = (html: string) => {
  const lower = html.toLowerCase();
  let out = '';
  let from = 0;
  let at = lower.indexOf('<');
  while (at !== -1) {
    if (lower.startsWith('<!--', at)) {
      const close = lower.indexOf('-->', at + 4);
      out += html.slice(from, at);
      if (close === -1) return out;
      from = close + 3;
    } else {
      const tag = rawTextTagAt(lower, at);
      if (tag) {
        const close = lower.indexOf(`</${tag}`, at);
        const end = close === -1 ? -1 : lower.indexOf('>', close);
        out += html.slice(from, at);
        if (end === -1) return out;
        from = end + 1;
      }
    }
    at = lower.indexOf('<', Math.max(at + 1, from));
  }
  return out + html.slice(from);
};

const withoutTags = (html: string) => {
  let text = html;
  for (let before = ''; before !== text;) {
    before = text;
    text = text.replace(/<[^<>]*>/g, '');
  }
  return text;
};

export const extractMainContent: ContentExtractor = (html) => {
  const root = parseHtml(withoutRawText(html));
  const region =
    findFirst(root, (e) => e.tag === 'main') ??
    findFirst(root, (e) => (attr(e, 'role') ?? '').toLowerCase() === 'main') ??
    findFirst(root, (e) => e.tag === 'article') ??
    findFirst(root, (e) => e.tag === 'body') ??
    root;
  return render(region, region);
};

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const decodeEntities = (text: string) =>
  text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, code: string) =>
    code.startsWith('#')
      ? String.fromCodePoint(
          code[1]?.toLowerCase() === 'x'
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10),
        )
      : (entities[code.toLowerCase()] ?? m),
  );

const collapseWhitespace = (html: string) =>
  html
    .split(/(<pre\b[\s\S]*?<\/pre>)/i)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\s+/g, ' ')))
    .join('');

const plainText = (html: string) => decodeEntities(withoutTags(html)).replace(/\s+/g, ' ').trim();

const contentToMarkdown = (html: string) =>
  decodeEntities(
    withoutTags(
      collapseWhitespace(html)
        .replace(
          /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
          (_, level: string, text: string) =>
            `\n\n${'#'.repeat(Number(level))} ${plainText(text)}\n\n`,
        )
        .replace(/<li\b[^>]*>/gi, '\n- ')
        .replace(/<(td|th)\b[^>]*>/gi, ' ')
        .replace(/<\/(p|blockquote|ul|ol|table|pre|figure)\b[^>]*>/gi, '\n\n')
        .replace(
          /<(br|\/div|\/li|\/tr|\/section|\/article|\/figcaption|\/dd|\/dt|\/main|\/header)\b[^>]*>/gi,
          '\n',
        ),
    ),
  )
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const htmlToPage = (html: string, options: { extract?: ContentExtractor } = {}): WebPage => {
  const content = (options.extract ?? extractMainContent)(html);
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(content);
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = [heading?.[1], titleTag?.[1]]
    .map((t) => (t === undefined ? '' : plainText(t)))
    .find((t) => t !== '');
  return { markdown: contentToMarkdown(content), ...(title ? { title } : {}) };
};

export const htmlToMarkdown = (html: string) => htmlToPage(html).markdown;
