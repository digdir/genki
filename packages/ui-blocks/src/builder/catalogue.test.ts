import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogueProblems } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import * as exported from '../index.js';
import { en, nb } from '../i18n.js';
import {
  blockCatalogue,
  blockIds,
  movableBlocks,
  nameKey,
  needWords,
  optionKey,
  settingsSchema,
  zones,
} from './catalogue.js';
import { needKey } from './index.js';
import { templateIds, templateKey } from './templates.js';

const has = (key: string) => {
  const [namespace, name] = key.split('.') as [keyof typeof nb, string];
  return name in nb[namespace] && name in en[namespace];
};

describe('the block catalogue', () => {
  it('holds every block id once, in the order of the ids', () => {
    expect(blockCatalogue.map((spec) => spec.id)).toEqual([...blockIds]);
  });

  it('names every block and says what it does, in both languages', () => {
    for (const spec of blockCatalogue) {
      expect(has(nameKey(spec.id)), spec.id).toBe(true);
      expect(has(`${nameKey(spec.id)}Help`), spec.id).toBe(true);
    }
  });

  it('labels every option and says what it does, in both languages', () => {
    for (const spec of blockCatalogue)
      for (const option of spec.options) {
        expect(has(optionKey(spec.id, option.id)), `${spec.id}.${option.id}`).toBe(true);
        expect(has(`${optionKey(spec.id, option.id)}Help`), `${spec.id}.${option.id}`).toBe(true);
      }
  });

  it('names every template and every zone in both languages', () => {
    for (const id of templateIds) expect(has(templateKey(id)), id).toBe(true);
    for (const key of ['builder.zonePrimary', 'builder.zoneMain', 'builder.zoneSecondary'])
      expect(has(key)).toBe(true);
  });

  it('gives a reason in both languages for every need that can go unmet', () => {
    for (const need of needWords) expect(has(needKey(need)), need).toBe(true);
  });

  it('keeps the English catalogue in step with the bokmål one', () => {
    expect(catalogueProblems({ builder: nb.builder }, { builder: en.builder })).toEqual([]);
  });

  it('exports every member of a built block from the package', () => {
    for (const spec of blockCatalogue.filter((s) => s.status === 'built')) {
      expect(spec.members.length, spec.id).toBeGreaterThan(0);
      for (const member of spec.members)
        expect(exported, `${spec.id}: ${member}`).toHaveProperty(member);
    }
  });

  it('lists no members for a block that is not built yet', () => {
    for (const spec of blockCatalogue.filter((s) => s.status === 'planned'))
      expect(spec.members, spec.id).toEqual([]);
  });

  it('gives every block a zone, and an order in each zone it may stand in', () => {
    for (const spec of blockCatalogue) {
      expect(spec.zones.length, spec.id).toBeGreaterThan(0);
      for (const zone of spec.zones)
        expect(spec.order[zone], `${spec.id} in ${zone}`).toBeTypeOf('number');
      for (const zone of Object.keys(spec.order)) expect(spec.zones, spec.id).toContain(zone);
    }
  });

  it('uses only the known zones and the known need words', () => {
    for (const spec of blockCatalogue) {
      for (const zone of spec.zones) expect(zones).toContain(zone);
      for (const need of [...spec.needs, ...spec.options.flatMap((o) => o.needs ?? [])])
        expect(needWords).toContain(need);
    }
  });

  it('uses every need word it knows, so no reason is written for a need nothing has', () => {
    const used = new Set(
      blockCatalogue.flatMap((spec) => [
        ...spec.needs,
        ...spec.options.flatMap((o) => o.needs ?? []),
      ]),
    );
    expect(needWords.filter((need) => !used.has(need))).toEqual([]);
  });

  it('lets four blocks stand in more than one place: Chat, Filter, Approach and Document view', () => {
    expect(movableBlocks.map((spec) => spec.id)).toEqual([
      'chat',
      'filter',
      'approach',
      'document-view',
    ]);
  });

  it('makes Footnotes an option of Chat that needs Sources or Document view, not a block of its own', () => {
    expect(blockIds).not.toContain('footnotes');
    const footnotes = blockCatalogue
      .find((s) => s.id === 'chat')
      ?.options.find((o) => o.id === 'footnotes');
    expect(footnotes?.needs).toEqual(['component:sources|document-view']);
  });

  it('builds Document view from the answer’s sources, in the secondary panel first, without needing Sources', () => {
    const view = blockCatalogue.find((s) => s.id === 'document-view');
    expect(view?.status).toBe('built');
    expect(view?.members).toEqual(['DocumentView']);
    expect(view?.zones).toEqual(['secondary', 'main']);
    expect(view?.needs).toEqual(['service:datasets|documents']);
  });

  it('puts Settings in the foot of the primary panel', () => {
    const settings = blockCatalogue.find((s) => s.id === 'settings');
    expect(settings?.zones).toEqual(['primary']);
    expect(settings?.slot).toBe('foot');
  });

  it('marks Projects and Notes as not built', () => {
    expect(blockCatalogue.filter((s) => s.status === 'planned').map((s) => s.id)).toEqual([
      'projects',
      'notes',
    ]);
  });

  it('describes each block’s options as a JSON Schema with labels and defaults', () => {
    const schema = settingsSchema('approach');
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.properties).toEqual({
      level: {
        type: 'string',
        enum: ['standard', 'detailed'],
        default: 'standard',
        'x-label': 'builder.approachLevel',
        'x-widget': 'radio',
      },
    });
    expect(settingsSchema('chat').properties).toHaveProperty('footnotes.type', 'boolean');
  });
});

describe('the catalogue and the blocks', () => {
  it('is read by the builder, and imported by no block, so a host of a block takes no catalogue along', () => {
    const src = join(import.meta.dirname, '..');
    const offenders: string[] = [];
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'builder') continue;
      for (const file of readdirSync(join(src, entry.name), { recursive: true }) as string[]) {
        if (!/\.tsx?$/.test(file)) continue;
        const text = readFileSync(join(src, entry.name, file), 'utf8');
        if (/from '\.\.\/(\.\.\/)*builder\//.test(text)) offenders.push(`${entry.name}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
