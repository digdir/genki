import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..');
const text = readFileSync(join(root, '.github/workflows/review.yml'), 'utf8');

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
const workflow = parse(text) as {
  on: Record<string, unknown>;
  jobs: Record<
    string,
    {
      needs?: string;
      if: string;
      permissions: Record<string, string>;
      env?: Record<string, string>;
      steps: Step[];
    }
  >;
};
const job = workflow.jobs['cross-model'] ?? { if: '', permissions: {}, steps: [] };
const step = (id: string) => job.steps.find((s) => s.id === id);
const script = readFileSync(join(root, 'scripts/review-cross.ts'), 'utf8');
const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');

describe('the cross-model review', () => {
  it('stays off until a repository variable names the deployment', () => {
    expect(job.if).toContain("vars.CROSS_REVIEW_DEPLOYMENT != ''");
    expect(step('cross')?.env?.DEPLOYMENT).toBe('${{ vars.CROSS_REVIEW_DEPLOYMENT }}');
  });

  it('passes only the two price variables as cost input', () => {
    const env = step('cross')?.env ?? {};
    expect(env.CROSS_REVIEW_PRICE_IN_USD).toBe('${{ vars.CROSS_REVIEW_PRICE_IN_USD }}');
    expect(env.CROSS_REVIEW_PRICE_OUT_USD).toBe('${{ vars.CROSS_REVIEW_PRICE_OUT_USD }}');
    expect(
      Object.keys(env)
        .filter((k) => k.includes('PRICE'))
        .sort(),
    ).toEqual(['CROSS_REVIEW_PRICE_IN_USD', 'CROSS_REVIEW_PRICE_OUT_USD']);
    for (const value of Object.values(env)) expect(value).not.toContain('steps.cross');
  });

  it('takes the reasoning effort from a repository variable and calls the Responses API', () => {
    expect(step('cross')?.env?.CROSS_REVIEW_REASONING).toBe('${{ vars.CROSS_REVIEW_REASONING }}');
    expect(script).toContain('/openai/v1`');
    expect(script).toContain('/responses`');
    expect(script).not.toContain('chat/completions');
  });

  it('runs after the main review, only when it ran, and not on review again', () => {
    expect(job.needs).toBe('review');
    expect(job.if).toContain("needs.review.result != 'skipped'");
    expect(job.if).toContain("github.event.action != 'labeled'");
  });

  it('signs in and calls a model only when the changed paths are security-sensitive', () => {
    expect(step('scope')?.run).toBe('node "$RUNNER_TEMP/review/review-cross.mts" scope');
    const login = job.steps.find((s) => s.uses?.startsWith('azure/login@'));
    expect(login?.if).toBe("steps.scope.outputs.sensitive == 'true'");
    expect(step('cross')?.if).toBe("steps.scope.outputs.sensitive == 'true'");
  });

  it('reaches the model with the federated review identity, never a stored key', () => {
    const login = job.steps.find((s) => s.uses?.startsWith('azure/login@'));
    expect(login?.with?.['client-id']).toBe('${{ vars.AZURE_REVIEW_CLIENT_ID }}');
    expect(text).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
    expect(script).toContain("'get-access-token'");
    expect(script).not.toMatch(/api-key/i);
  });

  it('can read code and comment on the pull request, and nothing more', () => {
    expect(job.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      'id-token': 'write',
    });
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });

  it('pins every action to a full commit SHA', () => {
    for (const s of job.steps.filter((x) => x.uses)) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it('runs the review scripts from the base branch, never from the pull request', () => {
    const take = job.steps.findIndex(
      (s) => s.name === 'Take the review scripts from the base branch',
    );
    expect(take).toBeGreaterThan(-1);
    expect(job.steps[take]?.run).toContain('review-cross');
    expect(job.steps[take]?.run).toContain('git show "$BASE:scripts/$f.ts"');
    for (const s of job.steps.slice(take + 1).filter((x) => x.run))
      expect(s.run).toContain('$RUNNER_TEMP/review/');
  });

  it('never puts an expression inside a run script', () => {
    for (const s of job.steps) expect(s.run ?? '').not.toContain('${{');
  });

  it('never passes model output through env or step outputs other than a count', () => {
    for (const s of job.steps)
      for (const value of Object.values(s.env ?? {}))
        expect(value).not.toMatch(/outputs\.(structured_output|findings|out)/);
    expect(step('cross')?.env).not.toHaveProperty('OUT');
    expect(script).toContain('output({ posted:');
  });

  it('posts nothing in the silent group, like the main review', () => {
    expect(step('arm')?.run).toBe(
      'node "$RUNNER_TEMP/review/review-run.mts" arm >> "$GITHUB_OUTPUT"',
    );
    expect(step('cross')?.env?.ARM).toBe('${{ steps.arm.outputs.arm }}');
    expect(script).toContain("arm === 'treated' && toPost.length");
  });

  it('records each run apart from the main review records, so the dashboard counts do not change', () => {
    const upload = job.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.name).toMatch(/^cross-review-run-/);
    expect(upload?.with?.path).toBe('cross-review-run.json');
  });

  it('caps the turns and tokens of every run', () => {
    expect(script).toMatch(/turns: \d+,/);
    expect(script).toMatch(/inputTokens: [\d_]+,/);
    expect(script).toMatch(/outputTokens: [\d_]+,/);
    expect(job).toHaveProperty('timeout-minutes');
  });

  it('is documented with its one-time setup', () => {
    expect(contributing).toContain('CROSS_REVIEW_DEPLOYMENT');
    expect(contributing).toContain('Cognitive Services OpenAI User');
    expect(contributing).toContain('CROSS_REVIEW_REASONING');
  });
});
