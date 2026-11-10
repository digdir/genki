// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BlocksPanel } from './BlocksPanel';
import { useBlocksState } from './BlocksStep';

afterEach(cleanup);

const Harness = () => {
  const blocks = useBlocksState();
  return <BlocksPanel state={blocks.state} onChange={blocks.change} />;
};

const notInForce = 'Fotnoter: Trenger Kilder eller Dokumentvisning.';
const turnOffInRight = (name: string) =>
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Høyre panel' })).getByRole('switch', { name }),
  );

describe('the footnotes on Chat', () => {
  it('says Fotnoter is not in force with neither Kilder nor Dokumentvisning in the layout', () => {
    render(<Harness />);
    turnOffInRight('Kilder');
    turnOffInRight('Dokumentvisning');
    fireEvent.click(screen.getByText('Valg for Chat'));
    expect(screen.getByText(notInForce)).toBeTruthy();
  });

  it('keeps Fotnoter in force with Dokumentvisning and no Kilder, since a footnote opens the document', () => {
    render(<Harness />);
    turnOffInRight('Kilder');
    fireEvent.click(screen.getByText('Valg for Chat'));
    expect(screen.queryByText(notInForce)).toBeNull();
  });
});
