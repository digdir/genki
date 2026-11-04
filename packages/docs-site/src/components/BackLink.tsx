import { Link } from '@digdir/designsystemet-react';
import { ChevronLeftIcon } from '@navikt/aksel-icons';
import type { ReactNode } from 'react';

export function BackLink({
  href,
  lang,
  children,
}: {
  href: string;
  lang?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Link href={href} data-size="sm" className="back-link">
      <ChevronLeftIcon aria-hidden />
      <span lang={lang}>{children}</span>
    </Link>
  );
}
