// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { templates, type BlockLayout } from './rules';
import { ServicePreview } from './ServicePreview';

document.getAnimations ??= () => [];

afterEach(cleanup);

const note = 'Fotnotene i svaret peker til kildene: 1, 2 og 3.';
const noop = () => undefined;
const Chat = ({ note }: { note?: ReactNode }) => <section aria-label="Chat">{note}</section>;

const tryOut = (layout: BlockLayout) =>
  render(
    <ServicePreview
      layout={layout}
      mode="try"
      device="desktop"
      address="ny-tjeneste.genki.no"
      chat={<Chat />}
      onMode={noop}
      onDevice={noop}
      onRemove={noop}
      onReload={noop}
    />,
  );

describe('the footnotes in the preview', () => {
  it('tells that the answer has footnotes when Sources is in the layout', () => {
    tryOut(templates.classic);
    expect(within(screen.getByRole('region', { name: 'Chat' })).getByText(note)).toBeTruthy();
  });

  it('says nothing about footnotes without Sources', () => {
    tryOut(templates.chatOnly);
    expect(screen.queryByText(note)).toBeNull();
  });
});
