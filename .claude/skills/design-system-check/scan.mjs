#!/usr/bin/env node
// Lists candidates for the design-system-check skill to judge; usage is in SKILL.md.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import console from 'node:console';
import process from 'node:process';

const DOCS = 'https://designsystemet.no/no/components/docs';
const doc = (slug) => `${DOCS}/${slug}/overview`;
const TOKENS = {
  colour: 'https://designsystemet.no/no/fundamentals/theme/colors',
  size: 'https://designsystemet.no/no/fundamentals/theme/sizes-and-spacing',
  type: 'https://designsystemet.no/no/fundamentals/theme/typography',
  shadow: 'https://designsystemet.no/no/fundamentals/theme/shadows',
  icons: 'https://designsystemet.no/no/fundamentals/theme/icons',
};

/** Raw elements in JSX and what Designsystemet has for them. */
const ELEMENTS = [
  [/<button\b/, 'Button', doc('button')],
  [/<input\b[^>]*type=["']checkbox["']/, 'Checkbox / Switch', doc('checkbox')],
  [/<input\b[^>]*type=["']radio["']/, 'Radio', doc('radio')],
  [/<input\b[^>]*type=["']search["']/, 'Search', doc('search')],
  [/<input\b[^>]*type=["']file["']/, 'EXPERIMENTAL_FileUpload', doc('file-upload')],
  [
    /<input\b(?![^>]*type=["'](?:checkbox|radio|search|file|hidden)["'])/,
    'Textfield (or Field + Input)',
    doc('textfield'),
  ],
  [/<select\b/, 'Select', doc('select')],
  [/<textarea\b/, 'Textarea', doc('textarea')],
  [/<table\b/, 'Table', doc('table')],
  [/<a\s/, 'Link (or Button asChild for a link that looks like a button)', doc('link')],
  [/<dialog\b/, 'Dialog', doc('dialog')],
  [/<details\b/, 'Details', doc('details')],
  [/<hr\b/, 'Divider', doc('divider')],
  [/<(?:ul|ol)\b/, 'List.Unordered / List.Ordered', doc('list')],
  [/<h[1-6]\b/, 'Heading', doc('heading')],
  [/<p\b/, 'Paragraph', doc('paragraph')],
  [/<label\b/, 'Label (inside Field)', doc('label')],
  [/<fieldset\b/, 'Fieldset', doc('fieldset')],
  [/<legend\b/, 'Fieldset.Legend', doc('fieldset')],
  [/<nav\b[^>]*aria-label=["'][^"']*(?:brødsmule|breadcrumb)/i, 'Breadcrumbs', doc('breadcrumbs')],
];

/** ARIA roles that mean a widget is being built by hand. */
const ROLES = [
  [/role=["'](?:tab|tablist|tabpanel)["']/, 'Tabs', doc('tabs')],
  [/role=["'](?:dialog|alertdialog)["']/, 'Dialog', doc('dialog')],
  [/role=["']switch["']/, 'Switch', doc('switch')],
  [
    /role=["'](?:menu|menuitem|listbox|option)["']/,
    'Dropdown / Suggestion / Select',
    doc('dropdown'),
  ],
  [/role=["'](?:alert|status)["']/, 'Alert (status) or ValidationMessage', doc('alert')],
  [/role=["']tooltip["']/, 'Tooltip', doc('tooltip')],
  [/role=["']progressbar["']/, 'Spinner / Skeleton', doc('spinner')],
  [/role=["'](?:radiogroup|group)["']/, 'Fieldset / ToggleGroup', doc('fieldset')],
  [/role=["']button["']/, 'Button', doc('button')],
];

/** Class names that describe a component Designsystemet has. */
const CLASS_HINTS = [
  [/spinner|loader|loading/, 'Spinner', doc('spinner')],
  [/skeleton|placeholder-?box/, 'Skeleton', doc('skeleton')],
  [/badge|counter/, 'Badge', doc('badge')],
  [/\b(?:tag|pill|label-chip)\b/, 'Tag', doc('tag')],
  [/chip/, 'Chip', doc('chip')],
  [/\bcard\b|-card\b|card-/, 'Card', doc('card')],
  [/alert|banner|notice|callout/, 'Alert', doc('alert')],
  [/tooltip/, 'Tooltip', doc('tooltip')],
  [/popover|flyout/, 'Popover', doc('popover')],
  [/dropdown|menu\b/, 'Dropdown', doc('dropdown')],
  [/\btabs?\b|tab-/, 'Tabs', doc('tabs')],
  [/toggle|switch/, 'Switch / ToggleGroup', doc('switch')],
  [/segmented/, 'ToggleGroup', doc('toggle-group')],
  [/breadcrumb/, 'Breadcrumbs', doc('breadcrumbs')],
  [/pagination|pager/, 'Pagination', doc('pagination')],
  [/avatar/, 'Avatar', doc('avatar')],
  [/divider|separator|\brule\b/, 'Divider', doc('divider')],
  [/accordion|disclosure|collapsible|expander/, 'Details', doc('details')],
  [/modal|overlay|lightbox/, 'Dialog', doc('dialog')],
  [/error-?summary/, 'ErrorSummary', doc('error-summary')],
  [/field-?error|error-?message|validation/, 'ValidationMessage', doc('validation-message')],
];

/** Icon sets other than Aksel. */
const ICON_IMPORT =
  /from ['"](?:react-icons|lucide-react|@heroicons|@fortawesome|@mui\/icons|@phosphor-icons|@tabler\/icons|feather-icons)/;

/** CSS that hard-codes what a token or a component holds. */
const CSS_RULES = [
  [
    /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i,
    'colour token: --ds-color-*',
    TOKENS.colour,
    'colour',
  ],
  [
    /(?<![\w-])(?:padding|margin|gap|row-gap|column-gap|inset|top|right|bottom|left)(?:-[a-z]+)?\s*:[^;]*\b(?!0px)\d+(?:\.\d+)?(?:px|rem|em)\b/,
    'spacing token: --ds-size-*',
    TOKENS.size,
    'spacing',
  ],
  [
    /\bfont-size\s*:[^;]*\d(?:px|rem|em)\b/,
    'type token: --ds-font-size-* (or Heading/Paragraph data-size)',
    TOKENS.type,
    'type',
  ],
  [
    /\b(?:font-weight\s*:\s*\d{3}|line-height\s*:\s*\d+(?:\.\d+)?(?:px|rem)?\s*;|font-family\s*:(?![^;]*var\())/,
    'type token: --ds-font-* / --ds-line-height-*',
    TOKENS.type,
    'type',
  ],
  [
    /\bborder(?:-[a-z]+)*-radius\s*:[^;]*\d(?:px|rem|em|%)/,
    'radius token: --ds-border-radius-* (a theme choice, not a local one)',
    TOKENS.size,
    'radius',
  ],
  [
    /\bbox-shadow\s*:(?!\s*(?:none|inherit|var\())/,
    'shadow token: --ds-shadow-*',
    TOKENS.shadow,
    'shadow',
  ],
  [
    /\bborder(?:-(?:top|bottom|left|right|block|inline)(?:-start|-end)?)?\s*:\s*[1-9](?![^;]*var\()/,
    'a line: Divider, or --ds-color-border-subtle / -default',
    doc('divider'),
    'border',
  ],
  [
    /@keyframes\s+[\w-]*(?:spin|rotate|pulse|shimmer|loading)/i,
    'Spinner / Skeleton',
    doc('spinner'),
    'animation',
  ],
  [
    /--dsc-[a-zA-Z-]+\s*:(?!\s*var\()/,
    "overrides a component's internal variable: check it is a documented customisation",
    'https://designsystemet.no/no/fundamentals/code/css',
    'override',
  ],
  [
    /\.ds-[a-z-]+/,
    'styles a Designsystemet class directly: prefer variant, data-color or data-size',
    'https://designsystemet.no/no/fundamentals/code/css',
    'override',
  ],
];

const SKIP_DIR = /(?:^|\/)(?:node_modules|dist|build|coverage|vendor|\.git|\.claude)(?:\/|$)/;
const SKIP_FILE = /\.(?:test|spec|stories|test-utils)\.[jt]sx?$|\.d\.ts$/;
const WANTED = /\.(?:tsx|jsx|css)$/;

const walk = (path) => {
  if (SKIP_DIR.test(path)) return [];
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) return WANTED.test(path) && !SKIP_FILE.test(path) ? [path] : [];
  return readdirSync(path).flatMap((name) => walk(join(path, name)));
};

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .filter(Boolean);

const root = git('rev-parse', '--show-toplevel')[0];
process.chdir(root);

const flags = new Set(['--all', '--summary']);
const args = process.argv.slice(2);
const paths = args.filter((a) => !flags.has(a));
let files;
if (args.includes('--all')) {
  files = ['apps', 'packages'].flatMap((top) =>
    readdirSync(top).flatMap((name) => walk(join(top, name, 'src'))),
  );
} else if (paths.length > 0) {
  files = paths.flatMap(walk);
} else {
  const changed = new Set([
    ...git('diff', '--name-only', '--diff-filter=ACMR', 'origin/main...HEAD'),
    ...git('diff', '--name-only', '--diff-filter=ACMR', 'HEAD'),
    ...git('ls-files', '--others', '--exclude-standard'),
  ]);
  files = [...changed].flatMap(walk);
}

/** In a diff run, only lines the change touched; elsewhere every line. */
const touched = new Map();
if (!args.includes('--all') && paths.length === 0) {
  for (const file of files) {
    const lines = new Set();
    let tracked = true;
    try {
      git('ls-files', '--error-unmatch', file);
    } catch {
      tracked = false;
    }
    if (!tracked) continue; // a new file: every line is the change's
    const diff = execFileSync('git', ['diff', '-U0', 'origin/main', '--', file], {
      encoding: 'utf8',
    });
    for (const hunk of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n += 1) lines.add(n);
    }
    touched.set(file, lines);
  }
}

const findings = [];
const add = (file, line, kind, instead, link, text) =>
  findings.push({ file, line, kind, instead, link, text: text.trim().slice(0, 140) });

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const only = touched.get(file);
  const isCss = file.endsWith('.css');
  let inComment = false;

  lines.forEach((text, index) => {
    const n = index + 1;
    if (only && !only.has(n)) return;
    if (/ds-ok:/.test(text) || /ds-ok:/.test(lines[index - 1] ?? '')) return;

    if (isCss) {
      let code = text;
      if (inComment) {
        const end = code.indexOf('*/');
        if (end < 0) return;
        code = code.slice(end + 2);
        inComment = false;
      }
      code = code.replace(/\/\*.*?\*\//g, '');
      const open = code.indexOf('/*');
      if (open >= 0) {
        code = code.slice(0, open);
        inComment = true;
      }
      // A value that falls back to a token, or sits inside var(), is themed already.
      let bare = code;
      for (let prev = ''; prev !== bare;) {
        prev = bare;
        bare = bare.replace(/var\([^()]*\)/g, 'var()');
      }
      for (const [pattern, instead, link, kind] of CSS_RULES) {
        if (pattern.test(kind === 'override' ? code : bare))
          add(file, n, `css:${kind}`, instead, link, text);
      }
      return;
    }

    if (ICON_IMPORT.test(text))
      add(file, n, 'icons', 'Aksel icons: @navikt/aksel-icons', TOKENS.icons, text);
    for (const [pattern, instead, link] of ELEMENTS) {
      if (pattern.test(text) && !/ds-sr-only/.test(text)) {
        add(file, n, 'element', instead, link, text);
        break;
      }
    }
    for (const [pattern, instead, link] of ROLES) {
      if (pattern.test(text)) add(file, n, 'role', instead, link, text);
    }
    for (const match of text.matchAll(/className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)) {
      const names = (match[1] ?? match[2] ?? match[3] ?? '').toLowerCase();
      if (/\bds-/.test(names)) continue; // Designsystemet's own class, used on purpose
      const hint = CLASS_HINTS.find(([pattern]) => pattern.test(names));
      if (hint) add(file, n, 'class', hint[1], hint[2], text);
    }
    if (/style=\{\{[^}]*(?:#[0-9a-f]{3,8}\b|\d+px)/i.test(text))
      add(
        file,
        n,
        'inline-style',
        "tokens in CSS, or the component's own props",
        TOKENS.size,
        text,
      );
  });
}

if (findings.length === 0) {
  console.log(`No candidates in ${files.length} file(s).`);
  process.exit(0);
}

const byFile = Map.groupBy(findings, (f) => f.file);
if (args.includes('--summary')) {
  const rows = [...byFile].sort((a, b) => b[1].length - a[1].length);
  for (const [file, list] of rows) {
    const kinds = [...Map.groupBy(list, (f) => f.kind)]
      .map(([k, v]) => `${k} ${v.length}`)
      .join(', ');
    console.log(`${String(list.length).padStart(5)}  ${file}  (${kinds})`);
  }
  console.log(`\n${findings.length} candidate(s) in ${byFile.size} of ${files.length} file(s).`);
  process.exit(0);
}
for (const [file, list] of byFile) {
  console.log(`\n${relative(root, resolve(root, file))}`);
  for (const f of list)
    console.log(`  ${f.line}  [${f.kind}] → ${f.instead}  ${f.link}\n      ${f.text}`);
}
const kinds = Map.groupBy(findings, (f) => f.kind);
console.log(
  `\n${findings.length} candidate(s) in ${byFile.size} of ${files.length} file(s): ` +
    [...kinds].map(([k, v]) => `${k} ${v.length}`).join(', '),
);
