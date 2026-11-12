import { describe, expect, it } from 'vitest';
import { loadPlan } from './client.ts';
import {
  acceptProposals,
  checkFindings,
  escapedCandidates,
  layerCounts,
  maxProposals,
  parseFindings,
  parseProposal,
  toolboxOf,
  type Finding,
  type Toolbox,
} from './review.ts';

const toolbox: Toolbox = {
  variants: ['default', 'retrieve-only'],
  models: ['foundry-openai/gpt-5.4-mini'],
  screens: { portal: ['#/overview'], console: ['#/tenants'] },
  operatorReads: ['/operator/tenants'],
};

describe('the toolbox', () => {
  it('accepts a question to a listed variant', () => {
    expect(
      parseProposal({ action: 'ask', variant: 'default', question: 'Hei?', stream: true }, toolbox),
    ).toEqual({ action: 'ask', variant: 'default', question: 'Hei?', stream: true });
  });

  it('refuses a variant, model, screen or operator route that is not listed', () => {
    expect(parseProposal({ action: 'ask', variant: 'other', question: 'x' }, toolbox)).toBe(
      'unknown variant',
    );
    expect(parseProposal({ action: 'playground', model: 'gpt-x', question: 'x' }, toolbox)).toBe(
      'unknown model',
    );
    expect(parseProposal({ action: 'screen', app: 'portal', path: '#/access' }, toolbox)).toBe(
      'not a listed screen',
    );
    expect(parseProposal({ action: 'operator-read', path: '/operator/audit' }, toolbox)).toBe(
      'not a listed operator read',
    );
  });

  it('refuses any action outside the toolbox, such as a free HTTP call', () => {
    expect(parseProposal({ action: 'http', method: 'DELETE', url: 'https://x' }, toolbox)).toBe(
      'unknown action',
    );
  });

  it('refuses a question that is empty or too long', () => {
    expect(parseProposal({ action: 'ask', variant: 'default', question: '  ' }, toolbox)).toBe(
      'a question of 1 to 300 characters',
    );
    expect(
      parseProposal({ action: 'ask', variant: 'default', question: 'x'.repeat(301) }, toolbox),
    ).toBe('a question of 1 to 300 characters');
  });

  it('validates only definitions whose id starts with smoke-', () => {
    expect(
      parseProposal({ action: 'validate', definition: 'metadata:\n  id: smoke-new\n' }, toolbox),
    ).toMatchObject({ action: 'validate' });
    expect(
      parseProposal({ action: 'validate', definition: 'metadata:\n  id: veileder\n' }, toolbox),
    ).toBe('the definition id must start with smoke-');
  });

  it('reads the id from the definition, not from a comment or a text field', () => {
    expect(
      parseProposal({ action: 'validate', definition: 'metadata: { id: smoke-flow }\n' }, toolbox),
    ).toMatchObject({ action: 'validate' });
    expect(
      parseProposal(
        {
          action: 'validate',
          definition: '# id: smoke-x\nmetadata:\n  description: "id: smoke-y"\n  id: veileder\n',
        },
        toolbox,
      ),
    ).toBe('the definition id must start with smoke-');
    expect(parseProposal({ action: 'validate', definition: 'id: [' }, toolbox)).toBe(
      'the definition id must start with smoke-',
    );
  });

  it('is built from the plan without screens that show personal data', () => {
    const plan = loadPlan();
    const built = toolboxOf(plan, ['default']);
    const personal = [...plan.screens.portal, ...plan.screens.console]
      .filter((s) => s.personal)
      .map((s) => s.path);
    expect(personal.length).toBeGreaterThan(0);
    for (const path of personal)
      expect([...built.screens.portal, ...built.screens.console]).not.toContain(path);
    expect(built.models).toEqual(plan.models.map((m) => m.model));
  });

  it('offers only reads under /operator/', () => {
    for (const path of toolboxOf(loadPlan(), []).operatorReads)
      expect(path).toMatch(/^\/operator\/[\w/-]+$/);
  });

  it('offers no read the test-runner key is refused', () => {
    const plan = loadPlan();
    const refused = plan.operatorReads.filter((r) => r.refused).map((r) => r.path);
    expect(refused.length).toBeGreaterThan(0);
    for (const path of refused) expect(toolboxOf(plan, []).operatorReads).not.toContain(path);
  });

  it('keeps a screen in Norwegian unless English is asked for', () => {
    expect(parseProposal({ action: 'screen', app: 'console', path: '#/tenants' }, toolbox)).toEqual(
      { action: 'screen', app: 'console', path: '#/tenants', language: 'nb' },
    );
  });
});

describe('proposals', () => {
  it('keeps valid proposals, says why the others were dropped, and keeps only known pull requests', () => {
    const { accepted, rejected } = acceptProposals(
      {
        checks: [
          {
            check: { action: 'operator-read', path: '/operator/tenants' },
            why: 'w',
            pullRequest: 7,
          },
          { check: { action: 'operator-read', path: '/operator/audit' }, why: 'w' },
          {
            check: { action: 'operator-read', path: '/operator/tenants' },
            why: 'w',
            pullRequest: 99,
          },
        ],
      },
      toolbox,
      [7],
    );
    expect(accepted.map((a) => a.pullRequest)).toEqual([7, undefined]);
    expect(rejected).toEqual([{ index: 1, reason: 'not a listed operator read' }]);
  });

  it(`runs at most ${maxProposals} checks`, () => {
    const checks = Array.from({ length: 12 }, () => ({
      check: { action: 'operator-read', path: '/operator/tenants' },
      why: 'w',
    }));
    const { accepted, rejected } = acceptProposals({ checks }, toolbox, []);
    expect(accepted).toHaveLength(maxProposals);
    expect(rejected).toHaveLength(4);
  });

  it('accepts nothing from output that is not the expected shape', () => {
    expect(acceptProposals('run rm -rf', toolbox, []).accepted).toEqual([]);
  });
});

describe('findings', () => {
  it('keeps only checks and pull requests that exist in this run', () => {
    const [f] = parseFindings(
      {
        findings: [
          {
            title: 't',
            severity: 'urgent',
            evidence: 'e',
            checks: ['health', 'made-up'],
            suspectedPrs: [1, 2, 2],
          },
        ],
      },
      ['health'],
      [2],
    );
    expect(f).toEqual({
      source: 'model',
      title: 't',
      severity: 'low',
      evidence: 'e',
      checks: ['health'],
      suspectedPrs: [2],
    });
  });

  it('drops a finding without a title or evidence', () => {
    expect(parseFindings({ findings: [{ title: 't' }] }, [], [])).toEqual([]);
  });

  it('suspects the pull requests that touched a failed check’s group', () => {
    expect(
      checkFindings([{ id: 'model:x', group: 'models', detail: 'd' }], { models: [3, 4] }),
    ).toEqual([
      {
        source: 'checks',
        title: 'model:x failed',
        severity: 'high',
        evidence: 'd',
        checks: ['model:x'],
        suspectedPrs: [3, 4],
      },
    ]);
  });
});

describe('the experiment', () => {
  const finding = (title: string, suspectedPrs: number[]): Finding => ({
    source: 'model',
    title,
    severity: 'medium',
    evidence: 'e',
    checks: [],
    suspectedPrs,
  });
  const prs = [
    { number: 1, mergedAt: '2026-11-10T08:00:00Z', aiReviewed: true },
    { number: 2, mergedAt: '2026-11-10T08:00:00Z', aiReviewed: false },
    { number: 3, mergedAt: '2026-11-01T08:00:00Z', aiReviewed: true },
  ];

  it('lists escaped candidates per pull request in the experiment, with their findings', () => {
    expect(escapedCandidates([finding('a', [1, 2, 3]), finding('b', [1])], prs)).toEqual([
      { pullRequest: 1, findings: ['a', 'b'] },
    ]);
  });

  it('counts model findings that a failed check does not already cover', () => {
    const fromChecks = checkFindings([{ id: 'c1', group: 'g', detail: 'd' }], {});
    const fromModel = [
      { ...finding('same', []), checks: ['c1'] },
      { ...finding('new', []), checks: ['c2'] },
      finding('loose', []),
    ];
    expect(layerCounts(fromChecks, fromModel)).toEqual({ checks: 1, model: 2 });
  });
});
