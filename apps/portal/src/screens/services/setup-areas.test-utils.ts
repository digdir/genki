import { fireEvent, screen, within } from '@testing-library/react';

export const setupNav = () => screen.getByRole('navigation', { name: 'Deler av oppsettet' });

export const openArea = (name: RegExp) => {
  const nav = setupNav();
  if (!within(nav).queryByRole('button', { name }))
    fireEvent.click(within(nav).getByRole('button', { name: /^Avansert/ }));
  fireEvent.click(within(nav).getByRole('button', { name }));
};
