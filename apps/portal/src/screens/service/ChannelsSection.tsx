import type { ReactNode } from 'react';

export const ChannelsSection = ({
  live,
  modes,
  editor,
}: {
  live?: ReactNode;
  modes: ReactNode;
  editor: ReactNode;
}) => (
  <div className="stack">
    {live}
    {modes}
    {editor}
  </div>
);
