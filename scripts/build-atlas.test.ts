import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  crossModuleImports,
  importsOf,
  loadHeadlessRag,
  loadModules,
  loadTraces,
  moduleFileIds,
  outputPath,
  readOrder,
  repoRoot,
  workspacePackages,
  type Module,
} from './build-atlas.ts';

const modules = loadModules();
const byId = new Map(modules.map((m) => [m.id, m]));
const planes = [
  'consumers',
  'adapters',
  'composition',
  'runtime',
  'services',
  'policy',
  'ports',
  'providers',
  'external',
];

describe('atlas data', () => {
  it('lists every module file in order.yaml and nothing else', () => {
    expect([...readOrder()].sort()).toEqual(moduleFileIds());
    expect(new Set(readOrder()).size).toBe(readOrder().length);
  });

  it('puts every module on a known plane', () => {
    for (const m of modules) expect(planes, m.id).toContain(m.plane);
  });

  it('assigns every workspace package to exactly one module', () => {
    const owned = modules.flatMap((m) => m.packages ?? []);
    expect([...owned].sort()).toEqual([...workspacePackages().keys()].sort());
  });

  it('names only files that exist', () => {
    for (const m of modules)
      for (const file of m.files ?? [])
        expect(existsSync(join(repoRoot, file)), `${m.id}: ${file}`).toBe(true);
  });

  it('maps only to headless-rag modules that exist', () => {
    const old = new Set(loadHeadlessRag().map((o) => o.id));
    for (const m of modules)
      for (const r of m.replaces ?? [])
        expect(old.has(r.module), `${m.id} replaces ${r.module}`).toBe(true);
  });

  it('traces only through modules that exist', () => {
    for (const t of loadTraces())
      for (const s of t.steps) expect(byId.has(s.module), `${t.id}: ${s.module}`).toBe(true);
  });
});

describe('atlas edges', () => {
  const real = crossModuleImports(modules);
  const edges = modules.flatMap((m) => (m.edges ?? []).map((e) => ({ from: m.id, ...e })));

  it('points every edge at a module that exists', () => {
    for (const e of edges) expect(byId.has(e.to), `${e.from} -> ${e.to}`).toBe(true);
  });

  it('witnesses every import edge with a real import of the target', () => {
    for (const e of edges.filter((x) => x.kind === 'call')) {
      const target = byId.get(e.to);
      const { file, imports } = e.witness;
      expect(imports, `${e.from} -> ${e.to}`).toBeDefined();
      expect(target?.packages, `${e.from} -> ${e.to}`).toContain(imports);
      expect(
        byId.get(e.from)?.packages?.some((p) => file.startsWith(`${workspacePackages().get(p)}/`)),
      ).toBe(true);
      expect(importsOf(file), `${file} should import ${imports}`).toContain(imports);
    }
  });

  it('has an edge for every real import between modules', () => {
    const drawn = new Set(edges.filter((e) => e.kind === 'call').map((e) => `${e.from}>${e.to}`));
    const missing = [...real.keys()].filter((k) => !drawn.has(k));
    expect(missing, 'imports with no edge').toEqual([]);
    const stale = [...drawn].filter((k) => !real.has(k));
    expect(stale, 'edges with no import').toEqual([]);
  });

  it('witnesses every network edge with text in the named file', () => {
    for (const e of edges.filter((x) => x.kind !== 'call')) {
      const { file, contains } = e.witness;
      expect(contains, `${e.from} -> ${e.to}`).toBeTruthy();
      expect(readFileSync(join(repoRoot, file), 'utf8'), `${file}`).toContain(contains);
    }
  });
});

describe('built page', () => {
  it('is up to date with the module data and template', () => {
    const tsx = join(repoRoot, 'node_modules/.bin/tsx');
    const check = spawnSync(tsx, ['--conditions=source', 'scripts/build-atlas.ts', '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(check.status, check.stderr || check.stdout).toBe(0);
  }, 60_000);

  it('renders every module without script errors', async () => {
    const { JSDOM } = await import('jsdom');
    const errors: string[] = [];
    const dom = new JSDOM(readFileSync(outputPath, 'utf8'), {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse: (window: Window) =>
        window.addEventListener('error', (ev: ErrorEvent) =>
          errors.push(String(ev.error ?? ev.message)),
        ),
    });
    const doc = dom.window.document;
    expect(doc.querySelectorAll('.node').length).toBe(modules.length);
    for (const m of modules) {
      (doc.querySelector(`[data-module="${m.id}"]`) as HTMLElement).click();
      expect(doc.querySelector('.detail-title h2')?.textContent).toBe(m.name);
    }
    (doc.getElementById('mapping-btn') as HTMLElement).click();
    (doc.getElementById('migration-btn') as HTMLElement).click();
    const select = doc.getElementById('trace-select') as HTMLSelectElement;
    select.value = loadTraces()[0]?.id ?? '';
    select.dispatchEvent(new dom.window.Event('change'));
    expect(doc.querySelectorAll('.steps li').length).toBe(loadTraces()[0]?.steps.length);
    (doc.getElementById('trace-stop') as HTMLElement).click();
    dom.window.close();
    expect(errors).toEqual([]);
  }, 60_000);
});

const atlasUrl = 'http://localhost:5173/system-atlas.html';

const openAtlas = async (framed: boolean) => {
  const { JSDOM } = await import('jsdom');
  const parent = new JSDOM('', { url: 'http://localhost:5173/' });
  const posted: { message: Record<string, unknown>; origin: string }[] = [];
  parent.window.postMessage = ((message: Record<string, unknown>, origin: string) =>
    posted.push({ message, origin })) as typeof parent.window.postMessage;
  const errors: string[] = [];
  const dom = new JSDOM(readFileSync(outputPath, 'utf8'), {
    url: atlasUrl,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse: (window: Window) => {
      if (framed)
        Object.defineProperty(window, 'parent', { value: parent.window, configurable: true });
      window.addEventListener('error', (ev: ErrorEvent) =>
        errors.push(String(ev.error ?? ev.message)),
      );
    },
  });
  const doc = dom.window.document;
  const click = (selector: string) => (doc.querySelector(selector) as HTMLElement).click();
  const reply = (data: unknown, source: unknown = parent.window) =>
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        data,
        origin: 'http://localhost:5173',
        source: source as Window,
      }),
    );
  const lastAsk = () => posted.at(-1)?.message as { id: string; messages: { content: string }[] };
  return { dom, doc, posted, errors, click, reply, lastAsk, parent };
};

describe('the GenKI guide in the atlas', () => {
  it('shows a note instead of the composer when the atlas is opened on its own', async () => {
    const { doc, errors, dom } = await openAtlas(false);

    expect(doc.querySelector('.right-rail .panel.chat')).not.toBeNull();
    expect(doc.getElementById('messages')?.textContent).toMatch(
      /works when the atlas is opened from the console/,
    );
    expect((doc.getElementById('chat-form') as HTMLElement).hidden).toBe(true);
    expect((doc.getElementById('console-link') as HTMLElement).hidden).toBe(true);
    expect(doc.querySelectorAll('[data-ask-prompt], [data-ask-edge]')).toHaveLength(0);
    dom.window.close();
    expect(errors).toEqual([]);
  });

  it('links back to the console from the topbar when framed by the console', async () => {
    const { doc, dom } = await openAtlas(true);
    const link = doc.getElementById('console-link') as HTMLAnchorElement;

    expect(link.hidden).toBe(false);
    expect(link.closest('.topbar')).not.toBeNull();
    expect(link.getAttribute('href')).toBe('/#/tenants');
    expect(link.getAttribute('target')).toBe('_top');
    dom.window.close();
  });

  it('builds prepared prompts from the module data and asks the console on its own origin only', async () => {
    const m = modules.find((x) => x.edges?.length && x.files?.length) as (typeof modules)[number];
    const target = byId.get(m.edges?.[0]?.to ?? '')?.name;
    const { doc, posted, click, dom } = await openAtlas(true);
    click(`[data-module="${m.id}"]`);

    const labels = [...doc.querySelectorAll('[data-ask-prompt]')].map((b) => b.textContent);
    expect(labels).toEqual([
      'Explain this module',
      `How does ${m.name} connect to ${target}?`,
      `Where is ${m.name} in the code?`,
      `How do I change or extend ${m.name}?`,
    ]);
    click('[data-ask-prompt="0"]');

    expect(posted).toHaveLength(1);
    expect(posted[0]?.origin).toBe('http://localhost:5173');
    const message = posted[0]?.message as { type: string; messages: { content: string }[] };
    expect(message.type).toBe('genki-atlas:ask');
    const asked = message.messages[0]?.content ?? '';
    expect(asked).toContain(`Explain the ${m.name} module`);
    expect(asked).toContain(`id ${m.id}`);
    expect(asked).toContain(m.summary as string);
    for (const f of m.files ?? []) expect(asked).toContain(f);
    dom.window.close();
  });

  it('asks about a connection from its Ask button', async () => {
    const m = modules.find((x) => x.edges?.length) as (typeof modules)[number];
    const edge = m.edges?.[0] as (typeof m.edges & object)[number];
    const { posted, click, lastAsk, dom } = await openAtlas(true);
    click(`[data-module="${m.id}"]`);

    click('[data-ask-edge="0"]');

    expect(posted).toHaveLength(1);
    expect(lastAsk().messages[0]?.content).toContain(
      `Explain the connection from ${m.name} to ${byId.get(edge.to)?.name}: ${edge.label}`,
    );
    dom.window.close();
  });

  it('explains a traced request flow with its modules in order', async () => {
    const trace = loadTraces()[0] as ReturnType<typeof loadTraces>[number];
    const { doc, dom, click, lastAsk } = await openAtlas(true);
    const select = doc.getElementById('trace-select') as HTMLSelectElement;
    select.value = trace.id;
    select.dispatchEvent(new dom.window.Event('change'));

    expect(doc.querySelector('[data-ask-prompt="0"]')?.textContent).toBe('Explain this flow');
    click('[data-ask-prompt="0"]');

    const path = trace.steps.map((s) => byId.get(s.module)?.name).join(' → ');
    expect(lastAsk().messages[0]?.content).toContain(path);
    (doc.getElementById('trace-stop') as HTMLElement).click();
    dom.window.close();
  });

  it('shows the answer from the console with safe source links and chips that select modules', async () => {
    const m = modules.find((x) => x.files?.some((f) => f.startsWith('packages/'))) as Module;
    const other = modules.find((x) => x.id !== m.id && !x.external) as Module;
    const dir = (m.files?.find((f) => f.startsWith('packages/')) ?? '').split('/').slice(0, 2);
    const { doc, click, reply, lastAsk, dom, errors } = await openAtlas(true);
    click(`[data-module="${other.id}"]`);
    (doc.getElementById('chat-input') as HTMLInputElement).value = 'What runs a task?';
    click('#send');
    const { id } = lastAsk();

    reply({ type: 'genki-atlas:answer', id, text: 'x', html: '<p>forged</p>', sources: [] }, null);
    reply({ type: 'genki-atlas:delta', id, text: 'Streaming' });
    expect(doc.querySelector('.message.assistant:last-child')?.textContent).toBe('Streaming');
    reply({
      type: 'genki-atlas:answer',
      id,
      text: 'See the docs [1].',
      html: '<p>See the docs <a href="https://github.com/x">[1]</a>.</p>',
      sources: [
        {
          index: 1,
          title: 'Readme',
          url: `https://github.com/digdir/genki/blob/main/${dir.join('/')}/README.md`,
        },
        { index: 2, title: 'Bad', url: 'javascript:alert(1)' },
      ],
    });

    expect(doc.getElementById('messages')?.textContent).not.toContain('forged');
    const links = [...doc.querySelectorAll('.source-list a')].map((a) => a.getAttribute('href'));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(/^https:\/\/github\.com\//);
    const chip = doc.querySelector(`[data-answer-module="${m.id}"]`) as HTMLElement;
    chip.click();
    expect(doc.querySelector('.detail-title h2')?.textContent).toBe(m.name);
    dom.window.close();
    expect(errors).toEqual([]);
  });

  it('sends the earlier turns with a follow-up question from the composer', async () => {
    const { doc, click, reply, lastAsk, dom } = await openAtlas(true);
    const input = doc.getElementById('chat-input') as HTMLInputElement;
    input.value = 'What is genki?';
    click('#send');
    reply({
      type: 'genki-atlas:answer',
      id: lastAsk().id,
      text: 'A platform.',
      html: '<p>A platform.</p>',
      sources: [],
    });
    input.value = 'And the console?';
    click('#send');

    expect(lastAsk().messages).toEqual([
      { role: 'user', content: 'What is genki?' },
      { role: 'assistant', content: 'A platform.' },
      { role: 'user', content: 'And the console?' },
    ]);
    dom.window.close();
  });
});
