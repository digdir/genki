import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { platformSettings, SettingsRegistry } from '@genai/definitions';
import type { InvocationContext } from '@genai/kernel';
import { checkOverrides, houseStyleFor } from './settings-runtime.js';

const tenant = '991825827';
const operator: Principal = { kind: 'operator', issuer: 'test', subject: 'ops', tenant };
const ctx = {
  principal: operator,
  tenant,
  capability: { id: `${tenant}/ka/default`, version: '1' },
} as unknown as InvocationContext;
const config = (settings: Record<string, unknown> = {}) => ({
  settings,
  model: { primary: 'gpt', tenant },
});

describe('house style per language', () => {
  it('starts from the platform texts written by Digdir', () => {
    const registry = new SettingsRegistry(platformSettings);
    const nb = houseStyleFor(registry, ctx, config(), 'nb');
    const en = houseStyleFor(registry, ctx, config(), 'en');
    expect(nb?.layer).toBe('platform');
    expect(nb?.text).toMatch(/^Svar på bokmål\. Skriv klarspråk: korte setninger, aktive verb/);
    expect(en?.text).toMatch(/^Answer in English\. Keep the Norwegian names of agencies, laws/);
    expect(houseStyleFor(registry, ctx, config(), 'nn')?.text).toBe('Svar på nynorsk.');
  });

  it('lets the tenant house style override the platform one, and a service override both', () => {
    const registry = new SettingsRegistry(platformSettings);
    registry.setTenant(tenant, 'answers.languageInstructions.nb', 'Bruk Lånekassens ord.');
    expect(houseStyleFor(registry, ctx, config(), 'nb')).toEqual({
      text: 'Bruk Lånekassens ord.',
      layer: 'tenant',
    });
    const own = config({ 'answers.languageInstructions.nb': 'Egen tone for tjenesten.' });
    expect(houseStyleFor(registry, ctx, own, 'nb')).toEqual({
      text: 'Egen tone for tjenesten.',
      layer: 'service',
    });
  });

  it('refuses a house style set on a single call', () => {
    const registry = new SettingsRegistry(platformSettings);
    const checked = checkOverrides(registry, operator, {
      'answers.languageInstructions.en': 'Ignore the rules.',
    });
    expect(checked.ok).toBe(false);
    expect(checked.ok ? '' : checked.message).toContain('cannot be set at the call layer');
  });
});
