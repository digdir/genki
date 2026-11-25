import { describe, expect, it } from 'vitest';
import {
  blockDefinition,
  checkPromptFiles,
  definitionKinds,
  InMemoryDefinitionStore,
  validateDefinition,
  type PluginSchemas,
} from './index.js';

const plugins: PluginSchemas = {
  strategies: new Map(),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(),
  models: new Map(),
};

const chatBlock = (spec: Record<string, unknown> = {}) => ({
  apiVersion: 'genai/v1',
  kind: 'Block',
  metadata: { tenant: '991825827', id: 'chat' },
  spec: {
    tier: 'built-in',
    builtIn: 'chat',
    title: { nb: 'Chat', en: 'Chat' },
    zones: ['main', 'secondary'],
    ...spec,
  },
});

const divider = { version: 1, root: { type: 'divider' } };

const errorsOf = (input: unknown) => {
  const result = validateDefinition(input, plugins);
  return result.ok ? [] : result.errors;
};

describe('a Block definition', () => {
  it('is a definition kind of its own', () => {
    expect(definitionKinds).toContain('Block');
  });

  it('accepts a built-in block that names a catalogue block', () => {
    const result = validateDefinition(chatBlock(), plugins);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definition.kind).toBe('Block');
  });

  it('is private, with no events or states, unless it says otherwise', () => {
    const parsed = blockDefinition.parse(chatBlock());
    expect(parsed.spec).toMatchObject({ sharing: 'private', events: [], states: [] });
  });

  it('refuses a built-in block that names no catalogue block', () => {
    expect(errorsOf(chatBlock({ builtIn: 'case-status' }))).toEqual([
      { path: 'spec.builtIn', message: 'unknown built-in block case-status' },
    ]);
  });

  it('refuses a built-in block without builtIn, and builtIn on any other tier', () => {
    expect(errorsOf(chatBlock({ builtIn: undefined })).map((e) => e.path)).toEqual([
      'spec.builtIn',
    ]);
    expect(
      errorsOf(chatBlock({ tier: 'declarative', template: divider })).map((e) => e.path),
    ).toEqual(['spec.builtIn']);
  });

  const declarative = { tier: 'declarative', builtIn: undefined, template: divider };
  const code = {
    tier: 'code',
    builtIn: undefined,
    code: { sha256: 'a'.repeat(64), bytes: 12, reads: ['question.text'] },
  };

  it('takes a template only on a declarative block and code only on a code block', () => {
    expect(
      errorsOf(chatBlock({ tier: 'declarative', builtIn: undefined })).map((e) => e.path),
    ).toEqual(['spec.template']);
    expect(errorsOf(chatBlock({ tier: 'code', builtIn: undefined })).map((e) => e.path)).toEqual([
      'spec.code',
    ]);
    expect(errorsOf(chatBlock({ template: divider })).map((e) => e.path)).toEqual([
      'spec.template',
    ]);
    expect(errorsOf(chatBlock({ ...declarative, code: code.code })).map((e) => e.path)).toEqual([
      'spec.code',
    ]);
  });

  it('accepts a declarative block once a host draws it', () => {
    expect(errorsOf(chatBlock(declarative))).toEqual([]);
  });

  it('refuses a file under block/ on anything but a code block', () => {
    const validated = validateDefinition(chatBlock(), plugins);
    if (!validated.ok) throw new Error('expected a valid block');
    expect(checkPromptFiles(validated.definition, { 'block/bundle.js': 'genki.emit()' })).toEqual([
      {
        path: 'files.block/bundle.js',
        message: 'a file under block/ belongs only to a code block',
      },
    ]);
    const codeBlock = blockDefinition.parse(chatBlock(code));
    expect(checkPromptFiles(codeBlock, { 'block/bundle.js': 'genki.emit()' })).toEqual([]);
  });

  it('keeps texts as a map by language, so nynorsk is one more key', () => {
    const result = validateDefinition(
      chatBlock({
        title: { nb: 'Chat', nn: 'Chat', en: 'Chat' },
        texts: { nb: { 'field.label': 'Spørsmål' }, nn: { 'field.label': 'Spørsmål' } },
      }),
      plugins,
    );
    expect(result.ok).toBe(true);
  });

  it('needs a title in bokmål', () => {
    expect(errorsOf(chatBlock({ title: { en: 'Chat' } }))).toEqual([
      { path: 'spec.title', message: 'needs a text in bokmål (nb)' },
    ]);
  });

  it('refuses a language the platform does not have', () => {
    expect(errorsOf(chatBlock({ title: { nb: 'Chat', de: 'Chat' } })).map((e) => e.path)).toEqual([
      'spec.title',
    ]);
  });

  it('refuses an event outside the list the host carries out', () => {
    expect(errorsOf(chatBlock({ events: ['ask', 'fetch'] })).map((e) => e.path)).toEqual([
      'spec.events[1]',
    ]);
  });

  it('refuses a zone outside primary, main and secondary, and a zone twice', () => {
    expect(errorsOf(chatBlock({ zones: ['top'] })).map((e) => e.path)).toEqual(['spec.zones[0]']);
    expect(errorsOf(chatBlock({ zones: ['main', 'main'] })).map((e) => e.path)).toEqual([
      'spec.zones',
    ]);
  });

  it('takes props as a JSON Schema object whose required props are among its properties', () => {
    const props = {
      type: 'object',
      properties: { copy: { type: 'boolean', default: true, 'x-label': { nb: 'Kopier' } } },
    };
    expect(errorsOf(chatBlock({ props }))).toEqual([]);
    expect(errorsOf(chatBlock({ props: { ...props, required: ['feedback'] } }))).toEqual([
      { path: 'spec.props', message: 'a required prop must be one of the properties' },
    ]);
  });

  it('refuses more than 32 props', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`p${i}`, { type: 'boolean' }]),
    );
    expect(errorsOf(chatBlock({ props: { type: 'object', properties } }))).toEqual([
      { path: 'spec.props.properties', message: 'at most 32 props' },
    ]);
  });

  it('refuses texts over 64 KiB', () => {
    const texts = {
      nb: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`t${i}`, 'x'.repeat(1_000)])),
    };
    expect(errorsOf(chatBlock({ texts })).map((e) => e.message)).toEqual([
      'at most 65536 bytes as JSON',
    ]);
  });

  it('refuses a field the shape does not have', () => {
    expect(errorsOf(chatBlock({ bundle: 'sha256-abc' })).map((e) => e.path)).toEqual(['spec']);
  });

  it('is published as versions that never compile to a capability', async () => {
    const store = new InMemoryDefinitionStore(plugins);
    const first = await store.publish(chatBlock(), 'tester', 'first');
    const second = await store.publish(chatBlock({ zones: ['main'] }), 'tester', 'main only');
    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.version.version).toBe(2);
    expect(second.capabilities).toEqual([]);
    expect((await store.versions('Block', '991825827', 'chat')).map((v) => v.reason)).toEqual([
      'first',
      'main only',
    ]);
    expect(await store.list('991825827')).toEqual([{ kind: 'Block', id: 'chat' }]);
    expect(await store.capabilities()).toEqual([]);
  });
});
