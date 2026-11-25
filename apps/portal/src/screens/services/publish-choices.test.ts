import { describe, expect, it } from 'vitest';
import type { ServiceDefinition } from '../../data/service-definition';
import { newVariantsOf, withVariantChoices } from './publish-choices';

const withVariants = (variants: unknown[]) =>
  ({
    apiVersion: 'genai/v1',
    kind: 'Service',
    metadata: { tenant: '999888777', id: 'ka', name: 'KA', version: 1 },
    spec: { variants },
  }) as unknown as ServiceDefinition;

const fast = {
  id: 'fast',
  title: { nb: 'Raskere svar', en: 'Faster' },
  aliases: [],
  overrides: {},
};

describe('choices for new variants on the publish page', () => {
  it('lists only variants the edition in use does not have, and never the standard one', () => {
    const inUse = withVariants(['default']).spec;
    const draft = withVariants(['default', { ...fast, chat: false }]).spec;
    expect(newVariantsOf(inUse, draft)).toEqual([
      { id: 'fast', title: fast.title, choice: 'hidden' },
    ]);
    expect(newVariantsOf(draft, draft)).toEqual([]);
    expect(newVariantsOf(undefined, withVariants(['default']).spec)).toEqual([]);
  });

  it('hides a variant from users or lets them choose it', () => {
    const draft = withVariants(['default', fast]);
    expect(withVariantChoices(draft, { fast: 'hidden' }).spec.variants?.[1]).toMatchObject({
      id: 'fast',
      chat: false,
    });
    expect(
      withVariantChoices(withVariants(['default', { ...fast, chat: false }]), { fast: 'choosable' })
        .spec.variants?.[1],
    ).not.toHaveProperty('chat');
  });

  it('puts a variant that replaces the standard one first, where the standard one lives', () => {
    const chosen = withVariantChoices(withVariants(['default', { ...fast, chat: false }]), {
      fast: 'replaces',
    });
    expect(chosen.spec.variants?.map((v) => (typeof v === 'string' ? v : v.id))).toEqual([
      'fast',
      'default',
    ]);
    expect(chosen.spec.variants?.[0]).not.toHaveProperty('chat');
  });
});
