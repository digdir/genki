import { describe, expect, it } from 'vitest';
import { screenFile, sessionFor } from './browser.ts';
import { estimateOf, playgroundVersionOf, priceOf } from './extra.ts';
import { loadPlan } from './client.ts';
import { finalOutcome, portalClientIdOf, reviewDecision } from './run.ts';

const asked = { asked: true, prs: 2, healthy: true, runsToday: 1, maxPerDay: 3 };

describe('the model review', () => {
  it('runs when asked, with merged pull requests, on a healthy deploy, under the daily cap', () => {
    expect(reviewDecision(asked)).toEqual({ review: true });
  });

  it('is skipped when no pull request was merged since the last green run', () => {
    expect(reviewDecision({ ...asked, prs: 0 }).review).toBe(false);
  });

  it('still runs on the run that reaches the daily cap', () => {
    expect(reviewDecision({ ...asked, runsToday: 3 }).review).toBe(true);
  });

  it('is skipped over the daily cap, or when the count is unknown', () => {
    expect(reviewDecision({ ...asked, runsToday: 4 }).review).toBe(false);
    expect(reviewDecision({ ...asked, runsToday: undefined }).review).toBe(false);
  });

  it('is skipped when genki-test runs another version, or when not asked', () => {
    expect(reviewDecision({ ...asked, healthy: false }).review).toBe(false);
    expect(reviewDecision({ ...asked, asked: false }).review).toBe(false);
  });
});

describe('the outcome', () => {
  it('is partial when genki-test went down during a run that passed', () => {
    expect(finalOutcome('pass', true, false)).toBe('partial');
  });

  it('keeps a failure, and a pass when genki-test stayed up', () => {
    expect(finalOutcome('fail', true, false)).toBe('fail');
    expect(finalOutcome('pass', true, true)).toBe('pass');
  });
});

describe('the browser', () => {
  it('reads the portal’s client id from its runtime config', () => {
    expect(
      portalClientIdOf('globalThis.__GENKI_CONFIG__ = {"OIDC_CLIENT_ID":"genki-portal"};'),
    ).toBe('genki-portal');
    expect(portalClientIdOf('globalThis.__GENKI_CONFIG__ = {};')).toBe('local-portal');
  });

  it('gives the portal a session in the platform organisation that has not expired', () => {
    expect(sessionFor('portal', 't', '312521172', 1000)).toEqual({
      name: 'Smoke test',
      organisations: [{ orgNumber: '312521172', name: 'Smoke test' }],
      token: 't',
      expiresAt: 3_601_000,
    });
  });

  it('gives the console an operator session', () => {
    expect(sessionFor('console', 't', '1', 0)).toEqual({
      name: 'Smoke test',
      roles: ['GenAI.Operator'],
      token: 't',
    });
  });

  it('names screenshots after the screen', () => {
    expect(screenFile('portal', '#/services/smoke/test')).toBe('portal-services-smoke-test');
    expect(screenFile('console', '#/')).toBe('console-home');
  });
});

describe('extra checks', () => {
  const plan = loadPlan();

  it('find no playground version when the options response is not JSON', () => {
    expect(playgroundVersionOf('network error', plan.service)).toBeUndefined();
    expect(playgroundVersionOf('<html>Bad gateway</html>', plan.service)).toBeUndefined();
  });

  it('find the latest playground version of the smoke service', () => {
    const options = JSON.stringify({ services: [{ id: plan.service, latestVersion: 4 }] });
    expect(playgroundVersionOf(options, plan.service)).toBe(4);
  });

  it('are estimated by what they do, and reads are free', () => {
    expect(
      estimateOf({ action: 'ask', variant: 'retrieve-only', question: 'q', stream: false }, plan),
    ).toBe(0.02);
    expect(
      estimateOf({ action: 'ask', variant: 'default', question: 'q', stream: true }, plan),
    ).toBe(0.2);
    expect(estimateOf({ action: 'operator-read', path: '/operator/tenants' }, plan)).toBe(0);
  });

  it('are estimated at the model’s playground price in the playground', () => {
    const model = plan.models[0];
    expect(
      model && estimateOf({ action: 'playground', model: model.model, question: 'q' }, plan),
    ).toBe(model?.playgroundKr);
  });

  it('are priced at the model they run on', () => {
    const haiku = plan.models.find((m) => m.model.includes('haiku'));
    expect(haiku).toBeDefined();
    if (!haiku) return;
    expect(priceOf({ action: 'playground', model: haiku.model, question: 'q' }, plan)).toBe(
      plan.prices[haiku.model],
    );
    expect(
      priceOf({ action: 'ask', variant: haiku.variant, question: 'q', stream: false }, plan),
    ).toBe(plan.prices[haiku.model]);
    expect(priceOf({ action: 'operator-read', path: '/operator/tenants' }, plan)).toBeUndefined();
  });
});
