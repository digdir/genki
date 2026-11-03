// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { templates, type PreviewZoom } from './rules';
import { ServicePreview } from './ServicePreview';

document.getAnimations ??= () => [];

afterEach(cleanup);

const noop = () => undefined;

const Preview = () => {
  const [zoom, setZoom] = useState<PreviewZoom>('fit');
  return (
    <ServicePreview
      layout={templates.classic}
      mode="setup"
      zoom={zoom}
      address="ny-tjeneste.genki.no"
      chat={null}
      onMode={noop}
      onZoom={setZoom}
      onRemove={noop}
      onReload={noop}
    />
  );
};

describe('the size of the preview', () => {
  it('fits the service to the space by default, and can show it at its actual size', () => {
    render(<Preview />);
    const size = screen.getByRole('group', { name: 'Størrelse på forhåndsvisningen' });
    const fit = within(size).getByRole('radio', { name: 'Tilpass' }) as HTMLInputElement;
    const actual = within(size).getByRole('radio', {
      name: 'Faktisk størrelse',
    }) as HTMLInputElement;
    expect(fit.checked).toBe(true);
    expect(screen.queryByRole('radio', { name: 'Mobil' })).toBeNull();

    fireEvent.click(actual);
    expect(actual.checked).toBe(true);
    expect(screen.getByText('100 %')).toBeTruthy();
  });
});
