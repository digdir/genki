export const demoTemplates = ['title', 'screen', 'board', 'code', 'close'] as const;
export type DemoTemplate = (typeof demoTemplates)[number];

export const boardMarks = ['done', 'now', 'next'] as const;
export type BoardMark = (typeof boardMarks)[number];

export const colorSchemes = ['light', 'dark'] as const;
export type ColorScheme = (typeof colorSchemes)[number];

export type SceneItem = string | { text: string; cue?: string };

export interface TitleScene {
  template: 'title';
  title?: string;
  logo?: boolean;
  subtitle?: string;
  centre?: string;
  items?: SceneItem[];
  base?: string;
}

export interface ScreenScene {
  template: 'screen';
  title: string;
  question?: string;
}

export interface BoardColumn {
  title: string;
  mark: BoardMark;
  items: SceneItem[];
}

export interface BoardScene {
  template: 'board';
  title: string;
  columns: BoardColumn[];
}

export interface CodeScene {
  template: 'code';
  eyebrow?: string;
  title: string;
  text?: string;
  definition: string;
  lines?: number;
}

export interface CloseScene {
  template: 'close';
  question?: string;
  action?: string;
  address: string;
}

export type DemoScene = TitleScene | ScreenScene | BoardScene | CodeScene | CloseScene;

export const definitionIdPattern = /^[a-z0-9][a-z0-9-]{0,59}$/;

export const demoPagePattern = /^\/(?![/\\])[^\s\\]{0,299}$/;

const isMap = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;

const optionalText = (value: unknown, max: number) => value === undefined || text(value, max);

const itemOk = (value: unknown) =>
  text(value, 80) ||
  (isMap(value) &&
    Object.keys(value).every((k) => k === 'text' || k === 'cue') &&
    text(value.text, 80) &&
    optionalText(value.cue, 40));

const itemsOk = (value: unknown, max: number) =>
  Array.isArray(value) && value.length >= 1 && value.length <= max && value.every(itemOk);

const fields: Record<DemoTemplate, readonly string[]> = {
  title: ['title', 'logo', 'subtitle', 'centre', 'items', 'base'],
  screen: ['title', 'question'],
  board: ['title', 'columns'],
  code: ['eyebrow', 'title', 'text', 'definition', 'lines'],
  close: ['question', 'action', 'address'],
};

const columnProblem = (value: unknown) =>
  isMap(value) &&
  Object.keys(value).every((k) => ['title', 'mark', 'items'].includes(k)) &&
  text(value.title, 60) &&
  (boardMarks as readonly unknown[]).includes(value.mark) &&
  itemsOk(value.items, 8)
    ? undefined
    : 'a board column has a title, a mark (done, now or next) and 1 to 8 items';

export const sceneProblem = (value: unknown): string | undefined => {
  if (!isMap(value) || !(demoTemplates as readonly unknown[]).includes(value.template))
    return `scene must have a template: ${demoTemplates.join(', ')}`;
  const template = value.template as DemoTemplate;
  const extra = Object.keys(value).find((k) => k !== 'template' && !fields[template].includes(k));
  if (extra) return `a ${template} scene takes only ${fields[template].join(', ')}, not ${extra}`;
  switch (template) {
    case 'title':
      if (!optionalText(value.title, 80) || !optionalText(value.subtitle, 120))
        return 'a title scene has a title of at most 80 and a subtitle of at most 120 characters';
      if (value.logo !== undefined && typeof value.logo !== 'boolean')
        return 'logo must be true or false';
      if (!value.title && value.logo !== true) return 'a title scene has a title or the logo';
      if (!optionalText(value.centre, 40) || !optionalText(value.base, 120))
        return 'centre is at most 40 and base at most 120 characters';
      if (value.items !== undefined && !itemsOk(value.items, 6))
        return 'items lists 1 to 6 short texts, each optionally with the cue word that shows it';
      return undefined;
    case 'screen':
      return text(value.title, 80) && optionalText(value.question, 80)
        ? undefined
        : 'a screen scene has a title, and a question, of at most 80 characters';
    case 'board':
      if (!text(value.title, 80)) return 'a board has a title of at most 80 characters';
      if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 3)
        return 'a board has 1 to 3 columns';
      return value.columns.map(columnProblem).find(Boolean);
    case 'code':
      if (
        !text(value.title, 60) ||
        !optionalText(value.eyebrow, 60) ||
        !optionalText(value.text, 200)
      )
        return 'a code scene has a title of at most 60, an eyebrow of 60 and a text of 200 characters';
      if (typeof value.definition !== 'string' || !definitionIdPattern.test(value.definition))
        return 'definition names an example in packages/definitions/examples, like kunnskapsassistenten';
      return value.lines === undefined ||
        (Number.isInteger(value.lines) &&
          (value.lines as number) >= 3 &&
          (value.lines as number) <= 14)
        ? undefined
        : 'lines is 3 to 14';
    case 'close':
      return text(value.address, 60) &&
        optionalText(value.question, 80) &&
        optionalText(value.action, 40)
        ? undefined
        : 'a close has an address of at most 60, a question of 80 and an action of 40 characters';
  }
};

export const pageProblem = (value: unknown) =>
  typeof value === 'string' && demoPagePattern.test(value)
    ? undefined
    : 'page is a path on the demo app, like /#/developer/frontends';

export const itemText = (item: SceneItem) => (typeof item === 'string' ? item : item.text);

export const itemCue = (item: SceneItem) => (typeof item === 'string' ? undefined : item.cue);
