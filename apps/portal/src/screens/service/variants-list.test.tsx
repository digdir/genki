// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { VariantSpec } from '../../data/service-definition';
import { VariantsList } from './VariantsList';
import { registerStrategies } from '../../data/strategies';
import { platformStrategies } from '../../mock/strategies';

afterEach(cleanup);
registerStrategies(platformStrategies);

const variant = (id: string, extra: Partial<VariantSpec> = {}): VariantSpec => ({
  id,
  title: { nb: '', en: '' },
  aliases: [],
  overrides: {},
  ...extra,
});

describe('the variants on the channels page', () => {
  it('lists each variant with the public name /v1/models shows, read-only', () => {
    render(
      <VariantsList
        service="ka"
        publicName="ka__default"
        variants={[variant('default'), variant('mini'), variant('søk', { publicName: 'ka-sok' })]}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Varianter' })).toBeTruthy();
    expect(screen.getByText('ka__default')).toBeTruthy();
    expect(screen.getByText('ka__mini')).toBeTruthy();
    expect(screen.getByText('ka-sok')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('links to the Varianter section under Oppsett', () => {
    render(<VariantsList service="ka" publicName="ka__default" variants={undefined} />);
    expect(screen.getByRole('link', { name: 'Rediger varianter' }).getAttribute('href')).toBe(
      '#/services/ka/setup/variants',
    );
    expect(screen.getByText('ka__default')).toBeTruthy();
  });

  it('names the way of working of a variant that has its own', () => {
    render(
      <VariantsList
        service="ka"
        publicName="ka__default"
        variants={[
          variant('default'),
          variant('arsrapport-forst', {
            strategy: { id: 'step-flow', version: 1, config: { flow: 'postruting@2' } },
          }),
        ]}
      />,
    );
    expect(screen.getByText('Egen arbeidsmåte: Fast stegflyt')).toBeTruthy();
  });
});
