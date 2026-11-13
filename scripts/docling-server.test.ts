import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The Docling server (ADR 0042, issue 476): its image, the workflows that build and deploy it, and the template.

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Workflow {
  jobs: Record<string, { outputs?: Record<string, string>; steps?: Step[] }>;
}
const workflow = (name: string) => parse(read(`.github/workflows/${name}`)) as Workflow;

describe('the Docling server image', () => {
  it("runs the Docling, Tesseract, Python and torch versions of the parser benchmark's winner", () => {
    const dockerfile = read('docker/docling/Dockerfile');
    const winner = JSON.parse(
      read(
        'benchmarks/ingestion/blocks/results/azure-D32as_v6-swedencentral-run2/docling-tess/meta.json',
      ),
    ) as {
      version: string;
      docling_core: string;
      docling_ibm_models: string;
      tesseract: string;
      torch: string;
      machine: { python: string };
    };
    expect(dockerfile).toMatch(/^FROM python:[\d.]+-slim-trixie@sha256:[0-9a-f]{64}$/m);
    const python = winner.machine.python.split('.').slice(0, 2).join('.');
    expect(dockerfile).toContain(`FROM python:${python}-slim-trixie@`);
    expect(dockerfile).toContain(`grep -qx '${winner.tesseract}'`);
    expect(dockerfile).toContain(`torch==${winner.torch.split('+')[0]}+cpu `);
    const locked = read('docker/docling/requirements.txt');
    for (const pin of [
      `docling==${winner.version}`,
      `docling-slim==${winner.version}`,
      `docling-core==${winner.docling_core}`,
      `docling-ibm-models==${winner.docling_ibm_models}`,
    ])
      expect(locked.split('\n'), pin).toContain(pin);
  });

  it('installs every Python package at the version in its lock file', () => {
    const dockerfile = read('docker/docling/Dockerfile');
    expect(dockerfile).toMatch(
      /^RUN pip install --no-deps -r \/tmp\/requirements\.txt && pip check/m,
    );
    // the torch step pulls in setuptools, which the lock leaves out
    expect(dockerfile).toMatch(/torchvision==[\d.]+\+cpu setuptools==[\d.]+$/m);
    const lines = read('docker/docling/requirements.txt')
      .split('\n')
      .filter((l) => l && !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(100);
    expect(lines.filter((l) => !/^[\w.-]+==[\w.+-]+$/.test(l))).toEqual([]);
  });

  it('lets requests use only Tesseract, with Norwegian when they name no OCR', () => {
    const dockerfile = read('docker/docling/Dockerfile');
    expect(dockerfile).not.toContain('DOCLING_SERVE_DEFAULT_OCR_PRESET');
    expect(dockerfile).toContain(`DOCLING_SERVE_ALLOWED_OCR_PRESETS='["tesseract"]'`);
    expect(dockerfile).toContain(
      `DOCLING_SERVE_CUSTOM_OCR_PRESETS='{"auto": {"kind": "tesseract", "lang": ["nor"]}}'`,
    );
  });

  it('has Tesseract data for Norwegian and English', () => {
    expect(read('docker/docling/Dockerfile')).toContain(
      'tesseract --list-langs 2>&1 | grep -qx nor && tesseract --list-langs 2>&1 | grep -qx eng',
    );
  });
});

describe('the deploy and infra workflows', () => {
  const deploy = workflow('deploy.yml');
  const all = (name: string) =>
    Object.values(deploy.jobs).flatMap((job) => (job.steps ?? []).filter((s) => s.id === name));

  it('builds the Docling image on every deploy and copies it to prod by digest', () => {
    const [build] = all('docling');
    expect(build?.uses).toMatch(/^docker\/build-push-action@[0-9a-f]{40}$/);
    expect(build?.with?.context).toBe('docker/docling');
    expect(build?.with?.outputs).toContain('push=true');
    expect(deploy.jobs.build?.outputs?.docling).toBe('${{ steps.image.outputs.docling }}');
    const prodImport = deploy.jobs['deploy-prod']?.steps?.find((s) => s.id === 'image');
    expect(prodImport?.run).toContain(
      'copy_image genai-docling "${{ needs.build.outputs.docling }}" docling',
    );
    for (const job of ['deploy-test', 'deploy-prod']) {
      const step = deploy.jobs[job]?.steps?.find((s) => s.id === 'deploy');
      expect(step?.run, job).toMatch(
        /doclingImage="\$\{\{ (needs\.build|steps\.image)\.outputs\.docling \}\}"/,
      );
    }
  });

  it('keeps the running Docling image when infra runs alone', () => {
    const steps = workflow('infra.yml').jobs.apply?.steps ?? [];
    const current = steps.find((s) => s.id === 'current');
    expect(current?.run).toContain('echo "docling=$(image_of docling)"');
    expect(
      steps.some((s) => s.run?.includes('doclingImage="${{ steps.current.outputs.docling }}"')),
    ).toBe(true);
  });
});

// The template is checked as Azure gets it: `az bicep build`. GitHub's runners have the Azure CLI; a machine
// without it skips these tests, CI never does.
const hasAz = (() => {
  try {
    execFileSync('az', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

interface Resource {
  type: string;
  name: string;
  condition?: string;
  properties: Record<string, unknown> & {
    configuration?: Record<string, unknown>;
    template?: Record<string, unknown>;
  };
}

interface Template {
  variables: Record<string, unknown>;
  resources: Resource[];
}

describe.skipIf(!hasAz && !process.env.CI)('the Docling server in the template', () => {
  let built: Template | undefined;
  // `az bicep build` takes several seconds, so once, outside any test's timeout
  beforeAll(() => {
    built = (
      JSON.parse(
        execFileSync(
          'az',
          ['bicep', 'build', '--file', join(root, 'infra/main.bicep'), '--stdout'],
          {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          },
        ),
      ) as { resources: Resource[] }
    ).resources.find((r) => r.name === 'containerapps')?.properties.template as Template;
  }, 120_000);
  const template = (): Template => {
    if (!built) throw new Error('the template did not build');
    return built;
  };
  const app = (suffix: string): Resource => {
    const found = template().resources.find(
      (r) => r.type === 'Microsoft.App/containerApps' && r.name.includes(`'{0}-${suffix}'`),
    );
    if (!found) throw new Error(`no container app ${suffix} in the template`);
    return found;
  };
  const docling = () => app('docling');
  const env = () => JSON.stringify(docling().properties.template);

  it('gives the Docling key to the worker and the Docling server only', () => {
    const holders = template()
      .resources.filter((r) =>
        /doclingKeySecret|docling-api-key|DOCLING_API_KEY|DOCLING_SERVE_API_KEY/.test(
          JSON.stringify(r),
        ),
      )
      .map((r) => r.name)
      .sort();
    expect(holders).toEqual([docling().name, app('worker').name].sort());
    // secrets and secretEnv go to the API and the worker alike
    const loops = template().variables.copy as { name: string }[];
    const shared = loops.filter((c) => ['secrets', 'secretEnv'].includes(c.name));
    expect(shared).toHaveLength(2);
    expect(JSON.stringify(shared)).not.toContain('docling');
    expect(JSON.stringify(app('worker').properties.template)).toContain("'DOCLING_API_KEY'");
    expect(env()).toContain(
      `{"name":"DOCLING_SERVE_API_KEY","secretRef":"[variables('doclingKeySecret').name]"}`,
    );
    for (const file of ['test', 'prod'])
      expect(read(`infra/env/${file}.bicepparam`), file).not.toContain('docling-api-key');
  });

  it('reaches the Docling server only by internal TCP ingress, scaling from zero on open connections', () => {
    const { ingress } = docling().properties.configuration as { ingress: Record<string, unknown> };
    expect(ingress).toMatchObject({
      external: false,
      transport: 'tcp',
      targetPort: 5001,
      exposedPort: 5001,
    });
    const { scale } = docling().properties.template as {
      scale: { minReplicas: number; rules: { tcp?: { metadata: Record<string, string> } }[] };
    };
    expect(scale.minReplicas).toBe(0);
    expect(scale.rules).toEqual([
      { name: 'connections', tcp: { metadata: { concurrentConnections: '1' } } },
    ]);
  });

  it('sets DOCLING_URL on the worker in test and prod', () => {
    const worker = JSON.stringify(app('worker').properties.template);
    expect(worker).toMatch(
      /'DOCLING_URL', 'value', format\('http:\/\/\{0\}:5001', reference\(resourceId\('Microsoft\.App\/containerApps', format\('\{0\}-docling'.*?\.configuration\.ingress\.fqdn\)/,
    );
    // No switch: the same template gives both environments the server.
    for (const file of ['test', 'prod'])
      expect(read(`infra/env/${file}.bicepparam`), file).not.toMatch(/docling/i);
    expect(docling().condition).toBeUndefined();
  });

  it("turns off the Docling server's docs, version, capabilities and metrics routes and logs at WARNING", () => {
    for (const [name, value] of [
      ['DOCLING_SERVE_ENABLE_API_DOCS', 'false'],
      ['DOCLING_SERVE_SHOW_VERSION_INFO', 'false'],
      ['DOCLING_SERVE_ENABLE_CAPABILITIES_ENDPOINT', 'false'],
      ['DOCLING_SERVE_OTEL_ENABLE_METRICS', 'false'],
      ['DOCLING_SERVE_OTEL_ENABLE_PROMETHEUS', 'false'],
      ['DOCLING_SERVE_ENABLE_UI', 'false'],
      ['DOCLING_SERVE_LOG_LEVEL', 'WARNING'],
    ])
      expect(env(), name).toContain(`{"name":"${name}","value":"${value}"}`);
  });

  it('keeps no Docling result past its fetch and mounts no volume', () => {
    for (const [name, value] of [
      ['DOCLING_SERVE_SINGLE_USE_RESULTS', 'true'],
      ['DOCLING_SERVE_RESULT_REMOVAL_DELAY', '1'],
    ])
      expect(env(), name).toContain(`{"name":"${name}","value":"${value}"}`);
    expect(env()).not.toMatch(/"volumes"|"volumeMounts"/);
  });

  it('lets the Docling server use the platform identity only to pull its image and read its key', () => {
    const { identitySettings } = docling().properties.configuration as {
      identitySettings?: { identity: string; lifecycle: string }[];
    };
    expect(identitySettings).toEqual([
      { identity: "[parameters('identityId')]", lifecycle: 'None' },
    ]);
  });

  it('gives a Docling conversion ten minutes to finish when its replica is stopped', () => {
    const { terminationGracePeriodSeconds } = docling().properties.template as {
      terminationGracePeriodSeconds?: number;
    };
    expect(terminationGracePeriodSeconds).toBe(600);
  });
});
