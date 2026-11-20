import { z } from 'zod';

export const INTERFACE_MAX_BYTES = 256 * 1024;
export const PROFILE_MAX_BYTES = 32 * 1024;
export const PAGE_MAX_BYTES = 32 * 1024;
export const PAGES_MAX_BYTES = 128 * 1024;
export const ICON_MAX_LENGTH = 24 * 1024;

/** The limits of `@genai/ui-blocks`' `profileLimits`, kept alike by a test in `@genai/strategy-builder`. */
export const interfaceLimits = {
  name: 80,
  question: 200,
  description: 500,
  settingsNote: 1_000,
  id: 128,
  url: 500,
  questions: 6,
  corpora: 20,
  fields: 30,
  typePlurals: 200,
  aboutFields: 10,
  experiments: 10,
  blocksPerZone: 16,
  settingsPerBlock: 32,
  setting: 1_000,
  menuItems: 12,
  pages: 12,
} as const;

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const atMost = (max: number) => (record: Record<string, unknown>) =>
  Object.keys(record).length <= max;

/** A text in one wording for every language, or one per language of the platform. */
const text = (max: number) =>
  z.union([
    z.string().max(max),
    z.strictObject({ nb: z.string().max(max), en: z.string().max(max) }),
  ]);

const isHttpsLink = (link: string) => {
  if (!link.startsWith('https://')) return false;
  const rest = link.slice('https://'.length);
  const hostEnd = rest.search(/[/?#]/);
  const host = hostEnd < 0 ? rest : rest.slice(0, hostEnd);
  if (host.length === 0 || host.includes('@') || host.includes('{id}')) return false;
  try {
    return new URL(link.split('{id}').join('0')).protocol === 'https:';
  } catch {
    return false;
  }
};

const isSitePath = (link: string) => {
  if (!/^\/(?![/\\])[^\\\s]*$/.test(link)) return false;
  try {
    return new URL(link.split('{id}').join('0'), 'https://host.invalid').host === 'host.invalid';
  } catch {
    return false;
  }
};

const link = z
  .string()
  .max(interfaceLimits.url)
  .refine(isHttpsLink, 'must be an https address whose host comes before {id}');

const documentLink = z
  .string()
  .max(interfaceLimits.url)
  .refine(
    (value) => isHttpsLink(value) || isSitePath(value),
    "must be an https address whose host comes before {id}, or a path on the host's own site",
  );

const id = z.string().max(interfaceLimits.id);

const field = z.strictObject({
  id,
  label: text(interfaceLimits.name),
  heading: text(interfaceLimits.name).optional(),
  kind: z.enum(['year']).optional(),
  years: z
    .strictObject({ first: z.number().int().optional(), last: z.number().int().optional() })
    .optional(),
});

const corpus = z.strictObject({
  label: text(interfaceLimits.name).optional(),
  description: text(interfaceLimits.description).optional(),
  fields: z.array(field).max(interfaceLimits.fields).optional(),
  typePlurals: z
    .record(id, text(interfaceLimits.id))
    .refine(atMost(interfaceLimits.typePlurals), `at most ${interfaceLimits.typePlurals} types`)
    .optional(),
  typeField: id.optional(),
  documentLinks: z
    .strictObject({
      digits: documentLink.optional(),
      uuid: documentLink.optional(),
      any: documentLink.optional(),
    })
    .optional(),
  about: z
    .strictObject({ idField: id, fields: z.array(id).max(interfaceLimits.aboutFields) })
    .optional(),
});

const experiment = z.strictObject({
  id,
  title: text(interfaceLimits.name),
  description: text(interfaceLimits.description).optional(),
  href: link.optional(),
  hrefLabel: text(interfaceLimits.name).optional(),
});

const questions = z.array(text(interfaceLimits.question)).max(interfaceLimits.questions);

const profile = z
  .strictObject({
    assistantName: text(interfaceLimits.name).optional(),
    suggestions: questions.optional(),
    followUps: questions.optional(),
    corpora: z
      .record(id, corpus)
      .refine(atMost(interfaceLimits.corpora), `at most ${interfaceLimits.corpora} collections`)
      .optional(),
    experiments: z.array(experiment).max(interfaceLimits.experiments).optional(),
    settingsNote: text(interfaceLimits.settingsNote).optional(),
  })
  .refine((p) => bytes(p) <= PROFILE_MAX_BYTES, `at most ${PROFILE_MAX_BYTES} bytes as JSON`);

/** A catalogue block's id, or a host's own block when it starts with `x-`. */
export const interfaceBlockId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'must be lowercase letters, digits and dashes');

export const catalogueBlockIds: readonly string[] = [
  'projects',
  'threads',
  'settings',
  'chat',
  'filter',
  'approach',
  'sources',
  'document-view',
  'notes',
];

const placed = z.strictObject({
  block: interfaceBlockId,
  settings: z
    .record(
      z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/, 'must be letters, digits and dashes'),
      z.union([z.boolean(), z.string().max(interfaceLimits.setting)]),
    )
    .refine(
      atMost(interfaceLimits.settingsPerBlock),
      `at most ${interfaceLimits.settingsPerBlock} settings`,
    )
    .optional(),
});

const zone = z.array(placed).max(interfaceLimits.blocksPerZone);

const layoutId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'must be lowercase letters, digits and dashes');

export const assistantLayout = z.strictObject({
  version: z.literal(1),
  template: layoutId.optional(),
  look: layoutId.optional(),
  zones: z.strictObject({ primary: zone, main: zone, secondary: zone }),
  profile: profile.optional(),
});

/** A page's id, which is also its address on the host: `/{id}`. */
export const interfacePageId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'must be lowercase letters, digits and dashes');

const isMenuLink = (value: string) => {
  if (value.startsWith('mailto:')) return /^mailto:[^\s/?#@]+@[^\s/?#@]+$/.test(value);
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
};

const menuItem = z.union([
  z.strictObject({ label: text(interfaceLimits.name), page: interfacePageId }),
  z.strictObject({
    label: text(interfaceLimits.name),
    href: z.string().max(interfaceLimits.url).refine(isMenuLink, 'must be an https or mailto link'),
  }),
]);

const pageText = z.union([z.string(), z.strictObject({ nb: z.string(), en: z.string() })]);

const page = z.strictObject({
  id: interfacePageId,
  title: text(interfaceLimits.name),
  body: pageText.refine(
    (body) => bytes(body) <= PAGE_MAX_BYTES,
    `at most ${PAGE_MAX_BYTES} bytes as JSON`,
  ),
});

const iconDataUrl = /^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;

export const isIconDataUrl = (value: string) =>
  value.length <= ICON_MAX_LENGTH && iconDataUrl.test(value);

const reserved = new Set(['api', 'auth', 'assets', 'innstillinger', 'callback', 'theme']);

export const serviceInterface = z
  .strictObject({
    layout: assistantLayout.optional(),
    icon: z
      .string()
      .max(ICON_MAX_LENGTH)
      .refine(isIconDataUrl, 'must be a base64 data: address of a PNG or SVG image')
      .optional(),
    menu: z.array(menuItem).max(interfaceLimits.menuItems).optional(),
    pages: z
      .array(page)
      .max(interfaceLimits.pages)
      .refine(
        (pages) => bytes(pages) <= PAGES_MAX_BYTES,
        `at most ${PAGES_MAX_BYTES} bytes as JSON`,
      )
      .refine(
        (pages) => new Set(pages.map((p) => p.id)).size === pages.length,
        'page ids must differ',
      )
      .refine(
        (pages) => pages.every((p) => !reserved.has(p.id)),
        "a page id must not be one of the host's own addresses",
      )
      .optional(),
  })
  .refine((i) => bytes(i) <= INTERFACE_MAX_BYTES, `at most ${INTERFACE_MAX_BYTES} bytes as JSON`)
  .refine(
    (i) =>
      (i.menu ?? []).every(
        (item) => !('page' in item) || (i.pages ?? []).some((p) => p.id === item.page),
      ),
    { message: 'a menu item names a page the interface does not have', path: ['menu'] },
  );

export type ServiceInterface = z.output<typeof serviceInterface>;
