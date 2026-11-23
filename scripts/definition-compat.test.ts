import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { PluginSchemas } from '@genai/definitions';
import { bootPlatform } from '../apps/api/src/testkit.ts';
import { checkDefinitions, readStored, type StoredDefinition } from './definition-compat.ts';

const service = (spec: string) => `apiVersion: genai/v1
kind: Service
metadata: { tenant: '991825827', id: klarsprak, name: Klarspråk }
spec:
  purpose: Skriv om tekst til klart språk
  riskClass: minimal
  input: { accepts: [text/plain] }
  output: { kind: answer }
${spec}
  model: { primary: foundry/gpt-4o, residency: norway }
  exposure: { rest: true }
  availableTo: '*'
`;

const singleCall = `  strategy:
    id: single-call
    version: 1
    config: { instructions: prompts/klarsprak.nb.md }`;

let plugins: PluginSchemas;
beforeAll(async () => {
  plugins = (await bootPlatform()).platform.plugins;
});

const definitionsOf = (source: string, text: string): StoredDefinition[] => {
  const read = readStored(source, text);
  expect(read.broken).toEqual([]);
  return read.definitions;
};

const problemsOf = (source: string, text: string) =>
  checkDefinitions(definitionsOf(source, text), plugins).flatMap(({ source: at, errors }) =>
    errors.map((e) => `${at} ${e.path}`),
  );

describe('definition-compat', () => {
  it('accepts a stored service that fits the current schema', () => {
    const text = readFileSync(
      join(import.meta.dirname, '../packages/definitions/examples/klarsprak.yaml'),
      'utf8',
    );
    expect(definitionsOf('klarsprak.yaml', text)).toHaveLength(1);
    expect(problemsOf('klarsprak.yaml', text)).toEqual([]);
  });

  it('refuses a stored definition with a field the current schema no longer has', () => {
    const stored = service(`${singleCall}\n  retiredField: true`);
    expect(problemsOf('old.yaml', stored)).toEqual(['old.yaml spec']);
  });

  it('refuses a stored service whose strategy config the current strategy no longer accepts', () => {
    const stored = service(`  strategy:
    id: single-call
    version: 1
    config: { instructions: 42 }`);
    expect(problemsOf('old.yaml', stored)).toEqual(['old.yaml spec.strategy.config.instructions']);
  });

  it('refuses a stored service whose strategy version no longer exists', () => {
    const stored = service(singleCall.replace('version: 1', 'version: 9'));
    expect(problemsOf('old.yaml', stored)).toEqual(['old.yaml spec.strategy']);
  });

  it('refuses a stored step flow whose step no longer fits the step schema', () => {
    const stored = `apiVersion: genai/v1
kind: StepFlow
metadata: { tenant: '991825827', id: flyt, name: Flyt }
spec:
  purpose: Svar
  steps:
    - { block: agent@1, input: { query: '{{input.query}}' } }
`;
    expect(problemsOf('flow.yaml', stored)).toEqual(['flow.yaml spec.steps[0].id']);
  });

  it('does not check models, datasets, rerankers or tools, which each environment decides', () => {
    const stored = service(`${singleCall}
  knowledge: { datasets: [{ dataset: finnes/ikke }], reranker: ukjent/omrangerer }
  tools: [ukjent-verktoy@1]`).replace('foundry/gpt-4o', 'ukjent/modell');
    expect(problemsOf('env.yaml', stored)).toEqual([]);
  });

  it('reads every definition in a tenant export and names the broken one by its place', () => {
    const good = definitionsOf('klarsprak.yaml', service(singleCall))[0]?.definition;
    const bundle = JSON.stringify({
      format: 'genai-tenant-export/v1',
      tenant: '991825827',
      exportedAt: '2026-11-21T00:00:00Z',
      definitions: [
        { definition: good, files: {} },
        { definition: { ...(good as object), apiVersion: 'genai/v0' }, files: {} },
      ],
      settings: { values: {}, pins: {} },
    });
    expect(problemsOf('export.json', bundle)).toEqual(['export.json#definitions[1] apiVersion']);
  });

  it('does not check the blocks a step flow uses, which each environment decides', () => {
    const stored = `apiVersion: genai/v1
kind: StepFlow
metadata: { tenant: '991825827', id: flyt, name: Flyt }
spec:
  purpose: Svar
  steps:
    - { id: svar, block: ukjent-blokk@1, input: { query: '{{input.query}}' } }
`;
    expect(problemsOf('flow.yaml', stored)).toEqual([]);
  });

  it('reads a definition whose kind line ends with a comment', () => {
    const text = service(singleCall).replace('kind: Service', 'kind: Service # a note');
    expect(definitionsOf('note.yaml', text)).toHaveLength(1);
  });

  it('reports invalid JSON that looks like a definition', () => {
    const read = readStored('bad.json', '{"kind": "Service", ');
    expect(read.broken.map((b) => b.source)).toEqual(['bad.json']);
  });

  it('names each document of a multi-document YAML file by its place', () => {
    const one = service(singleCall);
    const read = readStored('many.yaml', `${one}---\n${one}`);
    expect(read.definitions.map((d) => d.source)).toEqual(['many.yaml#0', 'many.yaml#1']);
  });

  it('reports a definition file that is not valid YAML', () => {
    const read = readStored('bad.yaml', 'kind: Service\nspec: [unclosed\n');
    expect(read.broken.map((b) => b.source)).toEqual(['bad.yaml']);
  });

  it('skips YAML and JSON files that are not definitions', () => {
    expect(readStored('models.yaml', 'models:\n  - id: a\n')).toEqual({
      definitions: [],
      broken: [],
    });
    expect(readStored('schemas.json', '{"nested":{"kind":"Service"}}')).toEqual({
      definitions: [],
      broken: [],
    });
  });

  it('runs in CI on every change to code or definitions', () => {
    const workflow = parse(
      readFileSync(join(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8'),
    ) as { jobs: Record<string, { steps: { run?: string; if?: string }[] }> };
    const step = workflow.jobs.static?.steps.find((s) => s.run === 'npm run definitions:compat');
    expect(step?.if).toBe("needs.scope.outputs.static == 'true'");
  });
});
