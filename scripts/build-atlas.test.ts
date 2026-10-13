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
