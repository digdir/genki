import { Link, Paragraph } from '@digdir/designsystemet-react';
import { LeaveIcon, PersonIcon } from '@navikt/aksel-icons';
import { useT } from '../i18n.js';

export interface SignedInProps {
  /** Who is signed in, as the reader knows themselves. Nothing is drawn without it. */
  name?: string | undefined;
  /** The reader's e-mail address, shown on hover. */
  email?: string | undefined;
  /** Where «Logg ut» leads: a full navigation to the host's sign-out. */
  signOutHref: string;
  /**
   * The reader is leaving by «Logg ut», a middle click included, and the browser is about to go.
   * The host forgets what this browser kept for them here, such as the filter, the collection and
   * the experiments, so the next person on a shared machine does not start with them.
   */
  onSignOut?: (() => void) | undefined;
  className?: string | undefined;
}

/**
 * Who is signed in, and «Logg ut», for the thread list's `footer`. At the end of the list, not
 * pinned to the panel's foot, where it would cover rows the keyboard scrolls to (WCAG 2.4.11).
 */
export const SignedIn = ({ name, email, signOutHref, onSignOut, className }: SignedInProps) => {
  const t = useT();
  if (!name) return null;

  return (
    <div className={['uib-threads-signed-in', className].filter(Boolean).join(' ')}>
      <Paragraph data-size="sm" className="uib-threads-user" title={email}>
        <PersonIcon aria-hidden="true" />
        <span>
          <span className="uib-visually-hidden">{t('threads.signedInAs')} </span>
          {name}
        </span>
      </Paragraph>
      {/* A plain link: signing out is a full navigation. A middle click fires only `auxclick`,
          which a right click fires too, hence button 1. */}
      <Link
        href={signOutHref}
        data-size="sm"
        onClick={() => onSignOut?.()}
        onAuxClick={(event) => {
          if (event.button === 1) onSignOut?.();
        }}
      >
        <LeaveIcon aria-hidden="true" />
        {t('threads.signOut')}
      </Link>
    </div>
  );
};
