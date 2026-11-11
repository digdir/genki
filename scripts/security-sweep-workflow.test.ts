import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const text = read('.github/workflows/security-sweep.yml');

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  'continue-on-error'?: boolean;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
const workflow = parse(text) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: { sweep: { if: string; permissions: Record<string, string>; steps: Step[] } };
};
const job = workflow.jobs.sweep;
const models = job.steps.filter((s) => s.uses?.startsWith('anthropics/claude-code-action@'));
const procedure = read('.claude/skills/security-sweep/SKILL.md');
const checklist = read('.github/review-security.md');

describe('the security sweep workflow', () => {
  it('runs weekly or by hand, never on pull requests', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow.on.schedule).toEqual([{ cron: '17 3 * * 1' }]);
  });

  it('runs only in the repository itself, never in a fork', () => {
    expect(job.if).toBe("github.repository == 'digdir/genki'");
  });

  it('can only read code and sign in to Foundry, and cannot write issues, comments or advisories', () => {
    expect(workflow.permissions).toEqual({});
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('pins every action to a full commit SHA', () => {
    for (const step of job.steps.filter((s) => s.uses)) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it('reaches the model through Foundry with a federated identity, never a stored key', () => {
    for (const step of models) {
      expect(step.with?.use_foundry).toBe('true');
      expect(step.with).not.toHaveProperty('anthropic_api_key');
    }
    expect(text).not.toMatch(/\$\{\{[^}]*\bsecrets\.(?!GITHUB_TOKEN)/);
  });

  it('runs three focused passes and a coordinator, all on Opus with a cost cap', () => {
    expect(models.map((s) => s.id)).toEqual([
      'pass_tenancy',
      'pass_rights',
      'pass_secrets',
      'coordinate',
    ]);
    for (const step of models) {
      const args = step.with?.claude_args ?? '';
      expect(args).toContain('--model claude-opus-5-5');
      expect(args).toMatch(/--max-budget-usd 6\b/);
      expect(args).toMatch(/--max-turns \d+/);
    }
    for (const pass of ['tenancy', 'rights', 'secrets'])
      expect(models.find((s) => s.id === `pass_${pass}`)?.with?.prompt).toContain(`Pass: ${pass}`);
  });

  it('gives every model step only tools that read', () => {
    for (const step of models) {
      const tools = /--allowedTools "([^"]+)"/.exec(step.with?.claude_args ?? '')?.[1]?.split(',');
      expect(tools?.length).toBeGreaterThan(0);
      for (const tool of tools ?? [])
        expect(tool).toMatch(/^(Read|Grep|Glob|Bash\(git (grep|ls-files|log|show):\*\))$/);
    }
  });

  it('never prints what the model saw or found to the public job log or summary', () => {
    for (const step of models) {
      expect(step.with?.show_full_output).toBe('false');
      expect(step.with?.display_report).toBe('false');
    }
    const scripts = job.steps.map((s) => s.run ?? '').join('\n');
    expect(scripts).not.toMatch(/\b(echo|cat|jq|head|tail|printf)\b.*(EXECUTION|sweep-|\.sweep)/);
    expect(scripts).not.toMatch(/set -\w*x/);
    expect(scripts.match(/^.*GITHUB_STEP_SUMMARY.*$/gm)).toEqual([
      'echo "Findings sealed for the maintainers. See the security sweep section in CONTRIBUTING.md to open them." >> "$GITHUB_STEP_SUMMARY"',
    ]);
  });

  it('keeps model output out of every step env, which the runner prints in the job log', () => {
    for (const step of job.steps)
      for (const value of Object.values(step.env ?? {}))
        expect(String(value)).not.toMatch(/structured_output/);
    expect(text).not.toMatch(/outputs\.structured_output/);
  });

  it('hands the seal step only how each model step ended, for the run record', () => {
    expect(job.steps.find((s) => s.id === 'seal')?.env?.OUTCOMES).toBe(
      'tenancy=${{ steps.pass_tenancy.outcome }} rights=${{ steps.pass_rights.outcome }} secrets=${{ steps.pass_secrets.outcome }} coordinate=${{ steps.coordinate.outcome }}',
    );
  });

  it('never expands an expression inside a run script', () => {
    for (const step of job.steps) expect(step.run ?? '').not.toContain('${{');
  });

  it('moves each pass execution file aside so no later step reads a stale one', () => {
    for (const pass of ['tenancy', 'rights', 'secrets']) {
      const move = job.steps.find((s) => s.env?.EXECUTION?.includes(`steps.pass_${pass}.`));
      expect(move?.if).toBe('always()');
      expect(move?.run).toBe(
        `mv "$EXECUTION" "$RUNNER_TEMP/sweep-${pass}.json" 2>/dev/null || true`,
      );
    }
  });

  it('spends nothing unless there is a key to seal the findings to', () => {
    const start = job.steps.findIndex((s) => s.id === 'start');
    const firstModel = job.steps.findIndex((s) => s.uses?.startsWith('azure/login@'));
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(firstModel);
    expect(job.steps[start]?.run).toContain('security-sweep.ts keys');
  });

  it('calls the coordinator only when a pass found something', () => {
    expect(models.find((s) => s.id === 'coordinate')?.if).toContain(
      "steps.merge.outputs.count != '0'",
    );
  });

  it('uploads only the sealed findings and a run record without findings, kept for two weeks', () => {
    const uploads = job.steps.filter((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(uploads).toHaveLength(1);
    expect(
      uploads[0]?.with?.path
        ?.trim()
        .split('\n')
        .map((p) => p.trim()),
    ).toEqual(['security-sweep.sealed.json', 'security-sweep-run.json']);
    expect(uploads[0]?.with?.['retention-days']).toBe(14);
    expect(uploads[0]?.with?.name).not.toMatch(/^review-run-/);
  });

  it('removes the unsealed candidates and execution files from the runner before uploading', () => {
    const seal = job.steps.findIndex((s) => s.id === 'seal');
    const upload = job.steps.findIndex((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(seal).toBeLessThan(upload);
    expect(job.steps[seal]?.run).toContain(
      'rm -rf .sweep "$RUNNER_TEMP"/sweep-*.json "$RUNNER_TEMP/claude-execution-output.json"',
    );
  });
});

describe('what the sweep checks', () => {
  it('follows REVIEW.md and the invariants in the security checklist', () => {
    for (const step of models) {
      expect(step.with?.prompt).toContain('.claude/skills/security-sweep/SKILL.md');
      expect(step.with?.prompt).toContain('.github/review-security.md');
    }
    expect(procedure).toContain('the Invariants are what you check');
  });

  it('keeps only findings with file and line evidence that someone could abuse', () => {
    expect(procedure).toContain('If you cannot name both, drop it.');
    expect(procedure).toContain('evidence with `file:line` for every claim');
  });

  it('names only areas that exist', () => {
    const paths = [...procedure.matchAll(/`((?:apps|packages)\/[^`]+)`/g)].map((m) => m[1] ?? '');
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.filter((p) => !existsSync(join(root, p)))).toEqual([]);
  });
});

describe('the invariants', () => {
  const invariants = checklist.split('## Invariants')[1] ?? '';

  it('are in the checklist both the pull request review and the sweep read', () => {
    expect(invariants).toContain('Only operators change what a service is shared with.');
    expect(invariants).toContain(
      'A key or client gets only the rights it was granted, never every right by default.',
    );
    expect(invariants).toContain(
      'Every route that reads tenant data checks the tenant on that route, not only on a sibling route.',
    );
    expect(read('.claude/skills/review-change/SKILL.md')).toContain(
      'the Invariants in `.github/review-security.md`',
    );
  });

  it('point only to tests that exist under the name they give', () => {
    const named = [...invariants.matchAll(/`([^`]+\.test\.ts)`, "([^"]+)"/g)];
    expect(named.length).toBeGreaterThan(0);
    for (const [, file = '', name = ''] of named) expect(read(file)).toContain(`it('${name}'`);
  });
});
