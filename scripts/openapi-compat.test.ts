import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  announcedOperations,
  breakingChanges,
  unannouncedChanges,
  type Spec,
} from './openapi-compat.ts';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/openapi-compat', name), 'utf8'),
  ) as Spec;

const base = () => fixture('base.json');

type Edit = [path: string[], value: unknown];
const at = (path: string[]): unknown =>
  path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], base());
const changed = (...edits: Edit[]) => {
  const spec = base();
  for (const [path, value] of edits) {
    const parent = path
      .slice(0, -1)
      .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], spec) as Record<
      string,
      unknown
    >;
    const key = path.at(-1) ?? '';
    if (value === undefined) Reflect.deleteProperty(parent, key);
    else parent[key] = value;
  }
  return spec;
};
const models = ['paths', '/v1/models', 'get'];
const hosts = ['paths', '/v1/hosts/{hostname}'];
const schemas = ['components', 'schemas'];

const rulesOf = (head: Spec) =>
  breakingChanges(base(), head).map((f) => `${f.operation} ${f.rule} ${f.where}`);

const readme = (...lines: string[]) =>
  ['# Platform HTTP API', '', '## API changes', '', ...lines, '', '## Areas', ''].join('\n');

describe('openapi-compat', () => {
  it('finds nothing when the /v1 OpenAPI is unchanged', () => {
    expect(breakingChanges(base(), base())).toEqual([]);
  });

  it('names every break in the deliberately breaking fixture', () => {
    expect(rulesOf(fixture('breaking.json'))).toEqual([
      'GET /v1/models removed-response-field response 200 application/json: data[].name',
      'POST /v1/chat/completions new-required-request-field request application/json: purpose',
      'POST /v1/chat/completions narrowed-type request application/json: temperature',
      'GET /v1/hosts/{hostname} removed-operation GET /v1/hosts/{hostname}',
    ]);
  });

  it('a removed method is breaking', () => {
    expect(rulesOf(changed([models, undefined]))).toEqual([
      'GET /v1/models removed-operation GET /v1/models',
    ]);
  });

  it('a renamed path parameter is not breaking', () => {
    const head = changed([['paths', '/v1/hosts/{name}'], at(hosts)], [hosts, undefined]);
    expect(rulesOf(head)).toEqual([]);
  });

  it('a response field that is no longer always present is breaking', () => {
    const head = changed([[...schemas, 'Model', 'required'], ['id']]);
    expect(rulesOf(head)).toEqual([
      'GET /v1/models removed-response-field response 200 application/json: data[].name',
    ]);
  });

  it('a removed success response is breaking', () => {
    const head = changed(
      [[...models, 'responses', '201'], at([...models, 'responses', '200'])],
      [[...models, 'responses', '200'], undefined],
    );
    expect(rulesOf(head)).toEqual(['GET /v1/models removed-response-field response 200']);
  });

  it('a new required query parameter is breaking, a new optional one is not', () => {
    const add = (required: boolean) =>
      changed([
        [...models, 'parameters', '1'],
        { name: 'tenant', in: 'query', required, schema: { type: 'string' } },
      ]);
    expect(rulesOf(add(true))).toEqual([
      'GET /v1/models new-required-request-field parameter query:tenant',
    ]);
    expect(rulesOf(add(false))).toEqual([]);
  });

  it('a request body that becomes required is breaking', () => {
    const optional = changed([
      ['paths', '/v1/chat/completions', 'post', 'requestBody', 'required'],
      false,
    ]);
    expect(
      breakingChanges(optional, base()).map((f) => `${f.operation} ${f.rule} ${f.where}`),
    ).toEqual(['POST /v1/chat/completions new-required-request-field request body']);
  });

  it('a request enum that drops a value is breaking, one that adds a value is not', () => {
    const mode = (values: string[]) =>
      changed([[...schemas, 'ChatRequest', 'properties', 'mode', 'enum'], values]);
    expect(rulesOf(mode(['fast']))).toEqual([
      'POST /v1/chat/completions narrowed-enum request application/json: mode',
    ]);
    expect(rulesOf(mode(['fast', 'thorough', 'deep']))).toEqual([]);
  });

  it('a response enum that adds a value is breaking, one that drops a value is not', () => {
    const reason = (values: string[]) =>
      changed([
        [
          ...['paths', '/v1/chat/completions', 'post', 'responses', '200', 'content'],
          ...['application/json', 'schema', 'properties', 'finish_reason', 'enum'],
        ],
        values,
      ]);
    expect(rulesOf(reason(['stop', 'length', 'tool_calls']))).toEqual([
      'POST /v1/chat/completions narrowed-enum response 200 application/json: finish_reason',
    ]);
    expect(rulesOf(reason(['stop']))).toEqual([]);
  });

  it('a request type that accepts more is not breaking', () => {
    const head = changed([
      [...schemas, 'ChatRequest', 'properties', 'stream', 'type'],
      ['boolean', 'string'],
    ]);
    expect(rulesOf(head)).toEqual([]);
  });

  it('a response field that may now be null is breaking', () => {
    const head = changed([
      [...schemas, 'Model', 'properties', 'name'],
      { type: ['string', 'null'] },
    ]);
    expect(rulesOf(head)).toEqual([
      'GET /v1/models narrowed-type response 200 application/json: data[].name',
    ]);
  });

  it('an open operation that starts to need a credential is breaking, and so is the reverse', () => {
    const closed = changed([[...hosts, 'get', 'responses', '401'], { description: 'No' }]);
    expect(rulesOf(closed)).toEqual(['GET /v1/hosts/{hostname} changed-auth security']);
    const opened = changed([[...models, 'responses', '401'], undefined]);
    expect(rulesOf(opened)).toEqual(['GET /v1/models changed-auth security']);
  });

  it('a changed security requirement is breaking', () => {
    const head = changed([[...models, 'security'], [{ apiKey: [] }]]);
    expect(rulesOf(head)).toEqual(['GET /v1/models changed-auth security']);
  });

  it('a new operation, an optional request field and a new response field are not breaking', () => {
    const head = changed(
      [['paths', '/v1/sessions'], { get: { responses: { '200': { description: 'Opened' } } } }],
      [[...schemas, 'ChatRequest', 'properties', 'seed'], { type: 'integer' }],
      [[...schemas, 'Model', 'properties', 'maker'], { type: 'string' }],
    );
    expect(rulesOf(head)).toEqual([]);
  });

  it('matches a header parameter without regard to case', () => {
    const head = changed([
      [...models, 'parameters', '0'],
      { name: 'Accept-Language', in: 'header', schema: { type: 'string', enum: ['nb'] } },
    ]);
    expect(rulesOf(head)).toEqual([
      'GET /v1/models narrowed-enum parameter header:accept-language',
    ]);
  });

  it('a request that widens integer to number is not breaking', () => {
    const integer = changed([
      [...schemas, 'ChatRequest', 'properties', 'temperature', 'type'],
      'integer',
    ]);
    expect(breakingChanges(integer, base())).toEqual([]);
  });

  it('a request media type that is no longer accepted is breaking', () => {
    const chat = ['paths', '/v1/chat/completions', 'post'];
    const head = changed([
      [...chat, 'requestBody', 'content'],
      { 'application/yaml': at([...chat, 'requestBody', 'content', 'application/json']) },
    ]);
    expect(rulesOf(head)).toEqual([
      'POST /v1/chat/completions narrowed-type request application/json',
    ]);
  });

  it('a response media type that is no longer sent is breaking', () => {
    const ok = [...models, 'responses', '200', 'content'];
    const head = changed([ok, { 'text/plain': { schema: { type: 'string' } } }]);
    expect(rulesOf(head)).toEqual([
      'GET /v1/models removed-response-field response 200 application/json',
    ]);
  });

  it('a response field marked nullable is breaking', () => {
    const head = changed([
      [...schemas, 'Model', 'properties', 'name'],
      { type: 'string', nullable: true },
    ]);
    expect(rulesOf(head)).toEqual([
      'GET /v1/models narrowed-type response 200 application/json: data[].name',
    ]);
  });

  it('reads fields through allOf and anyOf, and a union that adds a type to a response is breaking', () => {
    const head = changed(
      [[...schemas, 'ModelList'], { allOf: [at([...schemas, 'ModelList'])] }],
      [
        [...schemas, 'Model', 'properties', 'id'],
        { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      ],
    );
    expect(rulesOf(head)).toEqual([
      'GET /v1/models narrowed-type response 200 application/json: data[].id',
    ]);
  });

  it('a response enum beside a null branch that adds a value is breaking', () => {
    const reason = (values: string[]) =>
      [
        [...schemas, 'Model', 'properties', 'name'],
        { anyOf: [{ type: 'string', enum: values }, { type: 'null' }] },
      ] as Edit;
    expect(
      breakingChanges(changed(reason(['a'])), changed(reason(['a', 'b']))).map((f) => f.rule),
    ).toEqual(['narrowed-enum']);
  });

  it('a response array that drops its item schema is breaking', () => {
    const head = changed([[...schemas, 'ModelList', 'properties', 'data'], { type: 'array' }]);
    expect(rulesOf(head)).toEqual([
      'GET /v1/models narrowed-type response 200 application/json: data[]',
    ]);
  });

  it('compares a field across every union branch, not only the last', () => {
    const model = at([...schemas, 'Model']) as Record<string, unknown>;
    const props = model.properties as Record<string, unknown>;
    const integerId = { ...model, properties: { ...props, id: { type: 'integer' } } };
    const response = changed([[...schemas, 'Model'], { anyOf: [integerId, model] }]);
    expect(rulesOf(response)).toEqual([
      'GET /v1/models narrowed-type response 200 application/json: data[].id',
    ]);
    const chat = at([...schemas, 'ChatRequest']) as Record<string, unknown>;
    const fields = chat.properties as Record<string, unknown>;
    const textStream = { ...chat, properties: { ...fields, stream: { type: 'string' } } };
    const request = changed([[...schemas, 'ChatRequest'], { anyOf: [textStream, chat] }]);
    expect(breakingChanges(request, base()).map((f) => `${f.rule} ${f.where}`)).toEqual([
      'narrowed-type request application/json: stream',
    ]);
  });

  it('a request array that gains an item schema is breaking, a response array is not', () => {
    const tags = (schema: Record<string, unknown>) =>
      [[...schemas, 'ChatRequest', 'properties', 'tags'], schema] as Edit;
    const before = changed(tags({ type: 'array' }));
    const after = changed(tags({ type: 'array', items: { type: 'string' } }));
    expect(breakingChanges(before, after).map((f) => `${f.rule} ${f.where}`)).toEqual([
      'narrowed-type request application/json: tags[]',
    ]);
    const untyped = changed([[...schemas, 'ModelList', 'properties', 'data'], { type: 'array' }]);
    expect(breakingChanges(untyped, base())).toEqual([]);
  });

  it('a new required parameter declared on the path item is breaking', () => {
    const head = changed([
      [...hosts, 'parameters'],
      [{ name: 'tenant', in: 'query', required: true, schema: { type: 'string' } }],
    ]);
    expect(rulesOf(head)).toEqual([
      'GET /v1/hosts/{hostname} new-required-request-field parameter query:tenant',
    ]);
  });

  it('a removed informational or redirect response is breaking like a success', () => {
    const switching = changed([[...models, 'responses', '101'], { description: 'Switching' }]);
    expect(breakingChanges(switching, base()).map((f) => f.where)).toEqual(['response 101']);
  });

  it('ignores the convention text above the first dated entry', () => {
    const after = readme(
      'Name the operation, such as `POST /v1/chat/completions`.',
      '',
      '### 2026-11-21: x',
      '',
    );
    expect(announcedOperations(readme('### 2026-11-21: x', ''), after)).toEqual(new Set());
  });

  it('counts a repeated line as announced when this change adds it again', () => {
    const line = '- `GET /v1/models` changed.';
    const before = readme('### 2026-11-01: old', '', line);
    const after = readme('### 2026-11-21: new', '', line, '', '### 2026-11-01: old', '', line);
    expect(announcedOperations(before, after)).toEqual(new Set(['GET /v1/models']));
  });

  it('counts an operation as announced only from a line added under API changes', () => {
    const before = readme('### 2026-11-01: older', '', '- `GET /v1/models` changed earlier.');
    const after = readme(
      '### 2026-11-21: newer',
      '',
      '- `POST /v1/chat/completions` requires `purpose`.',
      '- `DELETE /v1/hosts/{name}?x=1` is gone.',
      '',
      '### 2026-11-01: older',
      '',
      '- `GET /v1/models` changed earlier.',
    );
    expect([...announcedOperations(before, after)].sort()).toEqual([
      'DELETE /v1/hosts/{}',
      'POST /v1/chat/completions',
    ]);
  });

  it('ignores an operation named outside the API changes section', () => {
    const after = `${readme()}\nSee \`GET /v1/hosts/{hostname}\`.\n`;
    expect(announcedOperations(readme(), after)).toEqual(new Set());
  });

  it('refuses an unannounced breaking change and accepts it once README announces it', () => {
    const input = { baseSpec: base(), headSpec: fixture('breaking.json'), baseReadme: readme() };
    expect(unannouncedChanges({ ...input, headReadme: readme() }).map((f) => f.operation)).toEqual([
      'GET /v1/models',
      'POST /v1/chat/completions',
      'POST /v1/chat/completions',
      'GET /v1/hosts/{hostname}',
    ]);
    const announced = readme(
      '### 2026-11-21: a breaking release',
      '',
      '- `GET /v1/models` no longer gives `name`.',
      '- `POST /v1/chat/completions` requires `purpose` and an integer `temperature`.',
      '- `GET /v1/hosts/{hostname}` is removed.',
    );
    expect(unannouncedChanges({ ...input, headReadme: announced })).toEqual([]);
  });

  it('passes on the committed /v1 OpenAPI against itself', () => {
    const spec = JSON.parse(
      readFileSync(join(import.meta.dirname, '../docs/api/openapi-v1.json'), 'utf8'),
    ) as Spec;
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(5);
    expect(breakingChanges(spec, spec)).toEqual([]);
  });

  it('runs in CI against the base of a pull request or merge group', () => {
    const workflow = parse(
      readFileSync(join(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8'),
    ) as { jobs: Record<string, { steps: { run?: string; env?: Record<string, string> }[] }> };
    const step = workflow.jobs.static?.steps.find((s) => s.run?.includes('npm run api:compat'));
    expect(step?.env?.BASE).toBe(
      '${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}',
    );
    expect(step?.run).toContain('git fetch --no-tags --depth=1 origin "$BASE"');
    expect(step?.run).toContain('npm run api:compat -- "$BASE"');
  });
});
