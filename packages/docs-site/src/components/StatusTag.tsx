import { Tag } from '@digdir/designsystemet-react';
import type { Status } from '@genai/docs-content';
import type { MouseEvent } from 'react';
import { useT } from '../i18n';
import { href } from '../router';

export type AnyStatus = Status | 'planlagt';

export const statusLabels = {
  bygd: { key: 'docsCommon.statusBuilt', color: 'success' },
  delvis: { key: 'docsCommon.statusPartial', color: 'warning' },
  planlagt: { key: 'docsCommon.statusPlanned', color: 'neutral' },
} as const satisfies Record<AnyStatus, { key: string; color: string }>;

const stop = (e: MouseEvent) => e.stopPropagation();

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
  const t = useT();
  const l = statusLabels[status];
  const text = t(l.key);
  return (
    <Tag data-color={l.color} data-size="sm" asChild>
      <a
        href={to ?? href({ page: 'status', id: status })}
        className="tag-link"
        title={title ?? t('docsCommon.showAllWith', { status: text.toLowerCase() })}
        onClick={stop}
      >
        {text}
      </a>
    </Tag>
  );
}
