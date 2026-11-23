// Refuses a breaking change to the public /v1 OpenAPI that docs/api/README.md does not announce.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const specFile = 'docs/api/openapi-v1.json';
export const readmeFile = 'docs/api/README.md';

export type Rule =
  | 'removed-operation'
  | 'removed-response-field'
  | 'new-required-request-field'
  | 'narrowed-type'
  | 'narrowed-enum'
  | 'changed-auth';

export interface Finding {
  operation: string;
  rule: Rule;
  where: string;
}

type Schema = Record<string, unknown>;
type Operation = {
  parameters?: Schema[];
  requestBody?: Schema;
  responses?: Record<string, Schema>;
  security?: unknown;
};
export interface Spec {
  paths?: Record<string, Record<string, Operation>>;
  components?: Record<string, Record<string, Schema>>;
  security?: unknown;
}

interface View {
  types: Set<string> | 'any';
  values: Set<string> | undefined;
  properties: Map<string, Schema>;
  required: Set<string>;
  items: Schema | undefined;
}

const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

const isRecord = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const shapeOf = (path: string) => path.replace(/\{[^}]*\}/g, '{}');

const resolve = (spec: Spec, value: unknown, depth = 0): Schema => {
  if (!isRecord(value)) return {};
  const ref = value.$ref;
  if (typeof ref !== 'string' || depth > 32) return value;
  const [, , section = '', name = ''] = ref.split('/');
  return resolve(spec, spec.components?.[section]?.[name], depth + 1);
};

const typeOfValue = (value: unknown) =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value === 'number' && Number.isInteger(value)
        ? 'integer'
        : typeof value;

const anyOf = (list: Schema[]): Schema => (list.length === 1 ? (list[0] ?? {}) : { anyOf: list });

const viewOf = (spec: Spec, raw: unknown, depth = 0): View => {
  const schema = resolve(spec, raw);
  const view: View = {
    types: 'any',
    values: undefined,
    properties: new Map(),
    required: new Set(),
    items: undefined,
  };
  if (depth > 16) return view;
  const branches = [schema.anyOf, schema.oneOf].find(Array.isArray) as unknown[] | undefined;
  if (branches && branches.length > 0) {
    const views = branches.map((branch) => viewOf(spec, branch, depth + 1));
    view.types = views.some((v) => v.types === 'any')
      ? 'any'
      : new Set(views.flatMap((v) => [...(v.types as Set<string>)]));
    const valuesOf = (v: View) =>
      v.values ??
      (v.types !== 'any' && [...v.types].every((t) => t === 'null')
        ? new Set(['null'])
        : undefined);
    view.values = views.every(valuesOf)
      ? new Set(views.flatMap((v) => [...(valuesOf(v) as Set<string>)]))
      : undefined;
    const objects = views.filter((v) => v.properties.size > 0);
    const byName = new Map<string, Schema[]>();
    for (const v of objects)
      for (const [k, s] of v.properties) byName.set(k, [...(byName.get(k) ?? []), s]);
    for (const [k, list] of byName) view.properties.set(k, anyOf(list));
    view.required = new Set(
      [...view.properties.keys()].filter((k) => objects.every((v) => v.required.has(k))),
    );
    const items = views.flatMap((v) => (v.items ? [v.items] : []));
    if (items.length > 0) view.items = anyOf(items);
  }
  for (const part of Array.isArray(schema.allOf) ? schema.allOf : []) {
    const v = viewOf(spec, part, depth + 1);
    if (v.types !== 'any') view.types = v.types;
    if (v.values) view.values = v.values;
    for (const [k, s] of v.properties) view.properties.set(k, s);
    for (const k of v.required) view.required.add(k);
    view.items ??= v.items;
  }
  if (typeof schema.type === 'string') view.types = new Set([schema.type]);
  if (Array.isArray(schema.type)) view.types = new Set(schema.type.map(String));
  const listed = 'const' in schema ? [schema.const] : schema.enum;
  if (Array.isArray(listed)) {
    view.values = new Set(listed.map((v) => JSON.stringify(v)));
    if (view.types === 'any') view.types = new Set(listed.map(typeOfValue));
  }
  if (isRecord(schema.properties)) {
    for (const [k, s] of Object.entries(schema.properties)) view.properties.set(k, s as Schema);
    if (view.types === 'any') view.types = new Set(['object']);
  }
  if (Array.isArray(schema.required)) for (const k of schema.required) view.required.add(String(k));
  if (schema.items !== undefined) view.items = schema.items as Schema;
  if (schema.nullable === true && view.types !== 'any') view.types.add('null');
  return view;
};

const covers = (types: Set<string>, type: string) =>
  types.has(type) || (type === 'integer' && types.has('number'));

const field = (where: string, name: string) =>
  where.endsWith(':') ? `${where} ${name}` : `${where}.${name}`;

type Mode = 'request' | 'response';

const compare = (
  spec: { base: Spec; head: Spec },
  base: unknown,
  head: unknown,
  mode: Mode,
  where: string,
  add: (rule: Rule, where: string) => void,
  depth = 0,
) => {
  if (depth > 16) return;
  const b = viewOf(spec.base, base);
  const h = viewOf(spec.head, head);
  const [narrow, wide] = mode === 'request' ? [h, b] : [b, h];
  if (narrow.types !== 'any') {
    const lost =
      wide.types === 'any' || [...wide.types].some((t) => !covers(narrow.types as Set<string>, t));
    if (lost) add('narrowed-type', where);
  }
  if (narrow.values && (!wide.values || [...wide.values].some((v) => !narrow.values?.has(v))))
    add('narrowed-enum', where);
  if (mode === 'request') {
    for (const k of h.required)
      if (!b.required.has(k)) add('new-required-request-field', field(where, k));
  } else {
    for (const k of b.properties.keys())
      if (!h.properties.has(k) || (b.required.has(k) && !h.required.has(k)))
        add('removed-response-field', field(where, k));
  }
  for (const [k, s] of b.properties) {
    const other = h.properties.get(k);
    if (other) compare(spec, s, other, mode, field(where, k), add, depth + 1);
  }
  if (h.items && (b.items || mode === 'request'))
    compare(spec, b.items ?? {}, h.items, mode, `${where}[]`, add, depth + 1);
  else if (b.items && mode === 'response') add('narrowed-type', `${where}[]`);
};

const authOf = (spec: Spec, operation: Operation) =>
  JSON.stringify(
    operation.security ??
      spec.security ??
      ('401' in (operation.responses ?? {}) ? 'credential' : 'open'),
  );

const parameterKey = (p: Schema) =>
  `${String(p.in)}:${p.in === 'header' ? String(p.name).toLowerCase() : String(p.name)}`;

const parametersOf = (spec: Spec, operation: Operation) =>
  new Map(
    (operation.parameters ?? [])
      .map((p) => resolve(spec, p))
      .filter((p) => p.in !== 'path')
      .map((p) => [parameterKey(p), p]),
  );

const operationsOf = (spec: Spec) =>
  new Map(
    Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([method]) => methods.includes(method))
        .map(([method, operation]) => [
          `${method.toUpperCase()} ${shapeOf(path)}`,
          {
            name: `${method.toUpperCase()} ${path}`,
            operation: {
              ...operation,
              parameters: [
                ...((item as { parameters?: Schema[] }).parameters ?? []),
                ...(operation.parameters ?? []),
              ],
            },
          },
        ]),
    ),
  );

export const breakingChanges = (base: Spec, head: Spec): Finding[] => {
  const findings: Finding[] = [];
  const specs = { base, head };
  const headOperations = operationsOf(head);
  for (const [key, { name, operation: b }] of operationsOf(base)) {
    const add = (rule: Rule, where: string) => findings.push({ operation: name, rule, where });
    const h = headOperations.get(key)?.operation;
    if (!h) {
      add('removed-operation', name);
      continue;
    }
    if (authOf(base, b) !== authOf(head, h)) add('changed-auth', 'security');

    const baseParameters = parametersOf(base, b);
    for (const [k, p] of parametersOf(head, h)) {
      const before = baseParameters.get(k);
      const where = `parameter ${k}`;
      if (p.required === true && before?.required !== true)
        add('new-required-request-field', where);
      if (before) compare(specs, before.schema, p.schema, 'request', where, add);
    }

    const bBody = resolve(base, b.requestBody);
    const hBody = resolve(head, h.requestBody);
    if (hBody.required === true && bBody.required !== true)
      add('new-required-request-field', 'request body');
    const hContent = isRecord(hBody.content) ? hBody.content : {};
    for (const [type, media] of Object.entries(isRecord(bBody.content) ? bBody.content : {})) {
      const where = `request ${type}:`;
      const other = hContent[type];
      if (!isRecord(other)) add('narrowed-type', where.slice(0, -1));
      else compare(specs, (media as Schema).schema, other.schema, 'request', where, add);
    }

    const hResponses = h.responses ?? {};
    for (const [status, raw] of Object.entries(b.responses ?? {})) {
      const bResponse = resolve(base, raw);
      const hResponse = resolve(head, hResponses[status]);
      const hMedia = isRecord(hResponse.content) ? hResponse.content : {};
      if (!(status in hResponses)) {
        if (/^[123]/.test(status)) add('removed-response-field', `response ${status}`);
        continue;
      }
      for (const [type, media] of Object.entries(
        isRecord(bResponse.content) ? bResponse.content : {},
      )) {
        const where = `response ${status} ${type}:`;
        const other = hMedia[type];
        if (!isRecord(other)) add('removed-response-field', where.slice(0, -1));
        else compare(specs, (media as Schema).schema, other.schema, 'response', where, add);
      }
    }
  }
  return findings;
};

const changesSection = (readme: string) => {
  const lines = readme.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## API changes');
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  const first = section.findIndex((line) => line.startsWith('### '));
  return first < 0 ? [] : section.slice(first);
};

const operationsNamed = /`(GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE) (\/[^`\s?]*)/g;

export const announcedOperations = (baseReadme: string, headReadme: string): Set<string> => {
  const before = new Map<string, number>();
  for (const line of changesSection(baseReadme)) before.set(line, (before.get(line) ?? 0) + 1);
  const announced = new Set<string>();
  for (const line of changesSection(headReadme)) {
    const seen = before.get(line) ?? 0;
    if (seen > 0) {
      before.set(line, seen - 1);
      continue;
    }
    for (const [, method = '', path = ''] of line.matchAll(operationsNamed))
      announced.add(`${method} ${shapeOf(path)}`);
  }
  return announced;
};

export const unannouncedChanges = (input: {
  baseSpec: Spec;
  headSpec: Spec;
  baseReadme: string;
  headReadme: string;
}): Finding[] => {
  const announced = announcedOperations(input.baseReadme, input.headReadme);
  return breakingChanges(input.baseSpec, input.headSpec).filter((finding) => {
    const [method = '', path = ''] = finding.operation.split(' ');
    return !announced.has(`${method} ${shapeOf(path)}`);
  });
};

const atRef = (ref: string, file: string) => {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(import.meta.dirname, '..');
  let base = process.argv[2] ?? '';
  try {
    base ||= execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {
      stdio: 'ignore',
    });
  } catch {
    console.error(`${base || 'origin/main'} is not a commit here; fetch it first.`);
    process.exit(1);
  }
  const baseSpec = atRef(base, specFile);
  if (baseSpec === undefined) {
    console.log(`${specFile} is not on ${base}, so there is no /v1 baseline to compare with.`);
    process.exit(0);
  }
  const findings = unannouncedChanges({
    baseSpec: JSON.parse(baseSpec) as Spec,
    headSpec: JSON.parse(readFileSync(join(root, specFile), 'utf8')) as Spec,
    baseReadme: atRef(base, readmeFile) ?? '',
    headReadme: readFileSync(join(root, readmeFile), 'utf8'),
  });
  if (findings.length === 0) {
    console.log(`No unannounced breaking change to the /v1 OpenAPI since ${base}.`);
    process.exit(0);
  }
  console.error(
    `Breaking changes to the /v1 OpenAPI since ${base} that ${readmeFile} does not announce:`,
  );
  for (const f of findings) console.error(`  ${f.operation}  ${f.rule}  ${f.where}`);
  console.error(
    `Announce each under "## API changes" in ${readmeFile} with a line naming the operation, like \`${findings[0]?.operation}\`, or keep the change compatible.`,
  );
  process.exit(1);
}
