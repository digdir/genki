import { annotateSchema, type UiText } from '@genai/contracts';
import { commonSchemaLabels } from '@genai/definitions';
import { instructionSchemaLabels } from '@genai/port-model';
import { blockSchemaLabels, builtinBlocks, type BlockRegistry } from '@genai/strategy-step-flow';
import { z } from 'zod';
import { enterTenant } from './access.js';
import { problem } from './http.js';
import { translatorFor } from './i18n/index.js';
import type { PlatformModuleFactory } from './platform-modules.js';

const jsonSchema = (schema: z.ZodType) => {
  const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  delete out.$schema;
  return out;
};

const paramLabels = [blockSchemaLabels, instructionSchemaLabels, commonSchemaLabels];

const catalogueText = (name: string, field: 'Name' | 'Description', fallback: string): UiText => {
  const camel = name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  const key = `platformBlocks.block${camel}${field}`;
  const inLocale = (locale: 'nb' | 'en') => {
    const translate = translatorFor(locale);
    return translate.has(key) ? translate.template(key) : fallback;
  };
  return { nb: inLocale('nb'), en: inLocale('en') };
};

export const describeBlocks = (registry: BlockRegistry) =>
  registry.refs().flatMap((ref) => {
    const block = registry.get(ref);
    return block
      ? [
          {
            ref,
            name: block.name,
            version: block.version,
            description: block.description,
            title: catalogueText(block.name, 'Name', block.name),
            summary: catalogueText(block.name, 'Description', block.description),
            input: jsonSchema(block.input),
            params: annotateSchema(jsonSchema(block.params), paramLabels),
            output: jsonSchema(block.output),
          },
        ]
      : [];
  });

export const stepBlocksModule: PlatformModuleFactory = () => {
  const described = describeBlocks(builtinBlocks());
  return {
    id: 'step-blocks',
    mount: (app, deps) => {
      app.get('/tenants/:tenant/step-flows/blocks', async (c) => {
        const principal = await deps.authenticate(c.req.raw);
        if (!principal) return problem(c, 401, 'Not authenticated');
        const entered = enterTenant(c, deps.access, principal, c.req.param('tenant') ?? '');
        if ('response' in entered) return entered.response;
        return c.json({ blocks: described });
      });
    },
  };
};
