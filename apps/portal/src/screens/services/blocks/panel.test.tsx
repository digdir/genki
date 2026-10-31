// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { BlocksPanel } from './BlocksPanel';
import { defaultLayout } from './rules';

afterEach(cleanup);

const Harness = () => {
  const [layout, setLayout] = useState(defaultLayout);
  return <BlocksPanel layout={layout} onChange={setLayout} />;
};

const chatIn = (group: string) =>
  within(screen.getByRole('group', { name: group })).getByRole('switch', { name: 'Chat' });

describe('the building blocks per panel', () => {
  it('moves Chat to the right panel when it is turned on there', () => {
    render(<Harness />);
    expect((chatIn('Midten') as HTMLInputElement).checked).toBe(true);
    expect((chatIn('Høyre sidepanel') as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(chatIn('Høyre sidepanel'));
    expect((chatIn('Høyre sidepanel') as HTMLInputElement).checked).toBe(true);
    expect((chatIn('Midten') as HTMLInputElement).checked).toBe(false);
  });
});
