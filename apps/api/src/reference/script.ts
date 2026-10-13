export const referenceScript = String.raw`const documentUrl = new URL('../openapi.json', import.meta.url);
const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
const untagged = 'Other';

const el = (tag, attrs, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const refName = (ref) => decodeURIComponent(ref.split('/').pop() || ref);

const resolve = (doc, node) => {
  let current = node;
  const seen = new Set();
  while (current && typeof current.$ref === 'string' && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    const parts = current.$ref.replace(/^#\//, '').split('/').map((p) => decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~')));
    let target = doc;
    for (const part of parts) target = target ? target[part] : undefined;
    current = target;
  }
  return current || {};
};

const nonNull = (list) => list.filter((s) => !(s && (s.type === 'null' || (Array.isArray(s.type) && s.type.length === 1 && s.type[0] === 'null'))));

const typeLabel = (doc, schema) => {
  if (!schema || typeof schema !== 'object') return 'any';
  if (schema.$ref) return refName(schema.$ref);
  if ('const' in schema) return 'const';
  const type = Array.isArray(schema.type) ? schema.type.filter((t) => t !== 'null').join(' | ') : schema.type;
  if (type === 'array') return 'array of ' + typeLabel(doc, schema.items);
  if (type) return type + (schema.format ? ' (' + schema.format + ')' : '');
  if (schema.oneOf) return 'one of';
  if (schema.anyOf) {
    const options = nonNull(schema.anyOf);
    return options.length === 1 ? typeLabel(doc, options[0]) : 'any of';
  }
  if (schema.allOf) return 'all of';
  if (schema.properties) return 'object';
  return 'any';
};

const isNullable = (schema) =>
  !!schema && ((Array.isArray(schema.type) && schema.type.includes('null')) || schema.nullable === true ||
    (Array.isArray(schema.anyOf) && schema.anyOf.some((s) => s && s.type === 'null')));

const constraints = (schema) => {
  const out = [];
  const add = (label, value) => { if (value !== undefined) out.push(label + ' ' + JSON.stringify(value)); };
  add('min', schema.minimum);
  add('max', schema.maximum);
  add('> ', schema.exclusiveMinimum);
  add('< ', schema.exclusiveMaximum);
  add('min length', schema.minLength);
  add('max length', schema.maxLength);
  add('min items', schema.minItems);
  add('max items', schema.maxItems);
  add('pattern', schema.pattern);
  add('default', schema.default);
  return out;
};

const exampleOf = (schema) => {
  if (!schema || typeof schema !== 'object') return undefined;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  return undefined;
};

const describe = (doc, schema, depth, trail) => {
  const resolved = resolve(doc, schema);
  const bits = [];
  if (isNullable(resolved)) bits.push(el('span', { class: 'desc' }, ' or null'));
  if (resolved.deprecated) bits.push(el('span', { class: 'desc' }, ' deprecated'));
  if (resolved.readOnly) bits.push(el('span', { class: 'desc' }, ' read-only'));
  const description = (schema && schema.description) || resolved.description;
  if (description) bits.push(el('div', { class: 'desc' }, description));
  if ('const' in resolved) bits.push(el('div', { class: 'enum' }, 'Value: ', el('code', {}, JSON.stringify(resolved.const))));
  const values = resolved.enum || (resolved.items && resolve(doc, resolved.items).enum);
  if (Array.isArray(values)) bits.push(el('div', { class: 'enum' }, 'One of: ', values.map((v) => el('code', {}, JSON.stringify(v)))));
  const limits = constraints(resolved);
  if (limits.length > 0) bits.push(el('div', { class: 'desc' }, limits.join(', ')));
  const example = exampleOf(schema) !== undefined ? exampleOf(schema) : exampleOf(resolved);
  if (example !== undefined) {
    const text = typeof example === 'string' ? example : JSON.stringify(example);
    bits.push(el('div', { class: 'desc' }, 'Example: ', el('code', {}, text.length > 160 ? text.slice(0, 157) + '...' : text)));
  }
  const nested = children(doc, schema, depth, trail);
  if (nested) bits.push(nested);
  return bits;
};

const children = (doc, schema, depth, trail) => {
  const ref = schema && schema.$ref;
  if (ref && trail.includes(ref)) return el('div', { class: 'ref' }, 'See ' + refName(ref) + ' above');
  if (depth > 8) return el('div', { class: 'ref' }, '...');
  const nextTrail = ref ? trail.concat(ref) : trail;
  const resolved = resolve(doc, schema);
  const list = el('ul', { class: 'schema' });
  const required = new Set(Array.isArray(resolved.required) ? resolved.required : []);
  for (const [name, prop] of Object.entries(resolved.properties || {})) {
    list.append(el('li', {}, el('span', { class: 'prop mono' }, name), required.has(name) ? el('span', { class: 'req' }, 'required') : null,
      ' ', el('span', { class: 'type' }, typeLabel(doc, prop)), describe(doc, prop, depth + 1, nextTrail)));
  }
  const extra = resolved.additionalProperties;
  if (extra && typeof extra === 'object') {
    list.append(el('li', {}, el('span', { class: 'prop mono' }, '[key: string]'), ' ', el('span', { class: 'type' }, typeLabel(doc, extra)), describe(doc, extra, depth + 1, nextTrail)));
  }
  const type = Array.isArray(resolved.type) ? resolved.type.find((t) => t !== 'null') : resolved.type;
  if (type === 'array' && resolved.items) {
    const items = resolve(doc, resolved.items);
    if (items.properties || items.oneOf || items.anyOf || items.allOf || items.additionalProperties) {
      list.append(el('li', {}, el('span', { class: 'prop mono' }, '[item]'), ' ', el('span', { class: 'type' }, typeLabel(doc, resolved.items)), describe(doc, resolved.items, depth + 1, nextTrail)));
    }
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (!Array.isArray(resolved[key])) continue;
    const options = key === 'anyOf' ? nonNull(resolved[key]) : resolved[key];
    if (key === 'anyOf' && options.length === 1) {
      const only = children(doc, options[0], depth + 1, nextTrail);
      if (only) list.append(...only.childNodes);
      continue;
    }
    options.forEach((option, index) => {
      const label = key === 'allOf' ? 'and' : 'option ' + (index + 1);
      list.append(el('li', {}, el('span', { class: 'prop' }, label), ' ', el('span', { class: 'type' }, typeLabel(doc, option)), describe(doc, option, depth + 1, nextTrail)));
    });
  }
  return list.childNodes.length > 0 ? list : null;
};

const schemaBlock = (doc, schema) => {
  if (!schema) return el('p', { class: 'desc' }, 'No schema.');
  return el('div', {}, el('span', { class: 'type' }, typeLabel(doc, schema)), describe(doc, schema, 0, []));
};

const examplesOf = (media) => {
  if (!media) return [];
  if (media.example !== undefined) return [media.example];
  return Object.values(media.examples || {}).map((e) => (e && e.value !== undefined ? e.value : e));
};

const contentBlock = (doc, content) =>
  Object.entries(content || {}).map(([type, media]) =>
    el('div', {}, el('span', { class: 'ctype mono' }, type), schemaBlock(doc, media && media.schema),
      examplesOf(media).map((example) => el('pre', { class: 'example' }, typeof example === 'string' ? example : JSON.stringify(example, null, 2)))));

const parametersBlock = (doc, parameters) => {
  if (parameters.length === 0) return null;
  const rows = parameters.map((raw) => {
    const p = resolve(doc, raw);
    return el('tr', {},
      el('td', {}, el('span', { class: 'prop mono' }, p.name), p.required ? el('span', { class: 'req' }, 'required') : null),
      el('td', {}, p.in),
      el('td', {}, el('span', { class: 'type' }, typeLabel(doc, p.schema))),
      el('td', {}, describe(doc, Object.assign({}, p.schema || {}, p.description ? { description: p.description } : {}, p.example !== undefined ? { example: p.example } : {}), 1, [])));
  });
  return [el('h3', {}, 'Parameters'), el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'In'), el('th', {}, 'Type'), el('th', {}, 'Details'))), el('tbody', {}, rows))];
};

const operationBody = (doc, op) => {
  const parts = [];
  if (op.operation.description) op.operation.description.split(/\n{2,}/).forEach((para) => parts.push(el('p', {}, para)));
  if (op.operation.security && op.operation.security.length === 0) parts.push(el('p', { class: 'desc' }, 'No authentication needed.'));
  const params = parametersBlock(doc, op.parameters);
  if (params) parts.push(...params);
  if (op.operation.requestBody) {
    const body = resolve(doc, op.operation.requestBody);
    parts.push(el('h3', {}, 'Request body', body.required ? el('span', { class: 'req' }, 'required') : null));
    if (body.description) parts.push(el('p', { class: 'desc' }, body.description));
    parts.push(...contentBlock(doc, body.content));
  }
  parts.push(el('h3', {}, 'Responses'));
  for (const [status, raw] of Object.entries(op.operation.responses || {})) {
    const response = resolve(doc, raw);
    parts.push(el('div', { class: 'response' }, el('span', { class: 'status mono s' + status.charAt(0) }, status), ' ', response.description || '', contentBlock(doc, response.content)));
  }
  return parts;
};

const methodClass = (method) => 'method m-' + (['get', 'post', 'put', 'patch', 'delete'].includes(method) ? method : 'other');

const schemaNames = (doc, node, out, depth) => {
  if (!node || typeof node !== 'object' || depth > 6) return out;
  if (typeof node.$ref === 'string') { out.push(refName(node.$ref)); return out; }
  for (const value of Object.values(node)) schemaNames(doc, value, out, depth + 1);
  return out;
};

const collect = (doc) => {
  const ops = [];
  for (const [path, item] of Object.entries(doc.paths || {})) {
    for (const method of methods) {
      const operation = item[method];
      if (!operation) continue;
      const tag = (operation.tags && operation.tags[0]) || untagged;
      const parameters = (item.parameters || []).concat(operation.parameters || []);
      const id = slug(operation.operationId || method + '-' + path);
      const names = schemaNames(doc, { r: operation.requestBody, s: operation.responses }, [], 0);
      const haystack = [method, path, operation.summary, operation.description, tag, operation.operationId, names.join(' ')].filter(Boolean).join(' ').toLowerCase();
      ops.push({ path, method, operation, tag, parameters, id, haystack });
    }
  }
  return ops;
};

const render = (doc) => {
  const ops = collect(doc);
  const declared = (doc.tags || []).map((t) => t.name);
  const used = [...new Set(ops.map((o) => o.tag))];
  const order = declared.filter((t) => used.includes(t)).concat(used.filter((t) => !declared.includes(t)));
  const info = new Map((doc.tags || []).map((t) => [t.name, t]));
  const content = document.getElementById('content');
  const nav = document.getElementById('nav');
  const navList = el('ul');
  const sections = [];
  content.replaceChildren();
  for (const tag of order) {
    const tagOps = ops.filter((o) => o.tag === tag);
    const anchor = 'tag-' + slug(tag);
    const count = el('span', { class: 'count' }, String(tagOps.length));
    navList.append(el('li', {}, el('a', { href: '#' + anchor }, el('span', {}, tag), count)));
    const section = el('section', { class: 'tag', id: anchor }, el('h2', {}, tag), info.get(tag) && info.get(tag).description ? el('p', {}, info.get(tag).description) : null);
    const entries = tagOps.map((op) => {
      const summary = el('summary', {}, el('span', { class: methodClass(op.method) }, op.method), el('span', { class: 'path mono' + (op.operation.deprecated ? ' deprecated' : '') }, op.path), el('span', { class: 'summary' }, op.operation.summary || ''));
      const details = el('details', { class: 'op', id: op.id }, summary);
      let filled = false;
      details.addEventListener('toggle', () => {
        if (!details.open || filled) return;
        filled = true;
        details.append(el('div', { class: 'op-body' }, el('p', { class: 'desc' }, el('a', { href: '#' + op.id }, 'Link to this operation')), operationBody(doc, op)));
      });
      section.append(details);
      return { op, details };
    });
    content.append(section);
    sections.push({ section, entries, count, total: tagOps.length });
  }
  const empty = el('p', { class: 'empty', hidden: true }, 'No operations match the search.');
  content.append(empty);
  nav.replaceChildren(navList);

  const search = document.getElementById('search');
  const apply = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const s of sections) {
      let visible = 0;
      for (const { op, details } of s.entries) {
        const match = words.every((w) => op.haystack.includes(w));
        details.hidden = !match;
        if (match) visible += 1;
      }
      s.section.hidden = visible === 0;
      s.count.textContent = words.length > 0 ? visible + ' / ' + s.total : String(s.total);
      shown += visible;
    }
    empty.hidden = shown > 0;
  };
  search.addEventListener('input', apply);

  const openHash = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    const target = id ? document.getElementById(id) : null;
    if (target && target.tagName === 'DETAILS') {
      target.hidden = false;
      target.open = true;
      target.scrollIntoView({ block: 'start' });
    }
  };
  window.addEventListener('hashchange', openHash);
  openHash();
  return ops.length;
};

const start = async () => {
  const meta = document.getElementById('meta');
  try {
    const response = await fetch(documentUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const doc = await response.json();
    const title = (doc.info && doc.info.title) || 'API reference';
    document.getElementById('title').textContent = title;
    document.title = title + ' reference';
    const total = render(doc);
    meta.replaceChildren(total + ' operations, version ' + ((doc.info && doc.info.version) || '?') + ', OpenAPI ' + (doc.openapi || '?') + '. Source: ', el('a', { href: documentUrl.href }, documentUrl.pathname));
  } catch (error) {
    meta.textContent = '';
    meta.append(el('span', { class: 'error' }, 'Could not load ' + documentUrl.pathname + ': ' + (error && error.message ? error.message : String(error))));
  }
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
`;
