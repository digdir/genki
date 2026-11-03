import { Tag } from '@digdir/designsystemet-react';
import type { Status } from '../data/blocks';
import { href } from '../router';

export type AnyStatus = Status | 'planlagt';

export const statusLabels: Record<AnyStatus, { text: string; color: string }> = {
  bygd: { text: 'Bygd', color: 'success' },
  delvis: { text: 'Delvis bygd', color: 'warning' },
  planlagt: { text: 'Planlagt', color: 'neutral' },
};

const stop = (e: React.MouseEvent) => e.stopPropagation();

/** Statusmerke. Alltid en lenke: til siden som samler alt med den statusen, eller til `href` om den er gitt. */
export function StatusTag({
  status,
  href: to,
  title,
}: {
  status: AnyStatus;
  href?: string;
  title?: string;
}) {
  const l = statusLabels[status];
  return (
    <Tag data-color={l.color} data-size="sm" asChild>
      <a
        href={to ?? href({ page: 'status', id: status })}
        className="tag-link"
        title={title ?? `Vis alt som er ${l.text.toLowerCase()}`}
        onClick={stop}
      >
        {l.text}
      </a>
    </Tag>
  );
}
