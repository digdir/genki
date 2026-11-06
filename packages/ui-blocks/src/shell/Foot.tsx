import { Link, Paragraph } from '@digdir/designsystemet-react';
import { LeaveIcon, PersonIcon } from '@navikt/aksel-icons';
import type { ComponentType, MouseEvent } from 'react';
import { useT } from '../i18n.js';

export interface ShellLink {
  href: string;
  title: string;
  /** An icon component, such as one from `@navikt/aksel-icons`. Drawn hidden from screen readers. */
  icon?: ComponentType<{ 'aria-hidden'?: boolean }> | undefined;
  /** The page on screen. Marked with `aria-current="page"` and drawn in bold. */
  current?: boolean | undefined;
}

export interface ShellLinksProps {
  links: readonly ShellLink[];
  /** The list's name, saying what is in it: «Innstillinger og om Kunnskapsassistenten». */
  label: string;
  /** A plain click on a link, for an app that routes on the page. Middle and modified clicks pass. */
  onNavigate?: ((link: ShellLink, event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
}

/** A click that would open the link elsewhere: the browser's, not the app's. */
const elsewhere = (event: MouseEvent) =>
  event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

/**
 * A panel's foot: settings and pages about the app, as in kunnskapsassistenten's navigation
 * panel. A named list, not a `nav`: the panel is a landmark already, and a second one would
 * announce two places to navigate from.
 */
export const ShellLinks = ({ links, label, onNavigate }: ShellLinksProps) => (
  <ul aria-label={label} className="uib-shell-links">
    {links.map((link) => {
      const Icon = link.icon;
      return (
        <li key={link.href}>
          <Link
            aria-current={link.current ? 'page' : undefined}
            data-size="sm"
            href={link.href}
            onClick={(event) => {
              if (!onNavigate || elsewhere(event)) return;
              onNavigate(link, event);
            }}
          >
            {Icon ? <Icon aria-hidden /> : null}
            {link.title}
          </Link>
        </li>
      );
    })}
  </ul>
);

export interface SignedInProps {
  /** Who is signed in, as the host knows them. */
  name: string;
  /** Shown on hover, when the name is not the address. */
  email?: string | undefined;
  /** Where «Logg ut» goes: a full navigation, so it works in a new tab too. */
  signOutHref: string;
  /** Before the browser leaves for `signOutHref`, as to forget what this browser keeps. */
  onSignOut?: (() => void) | undefined;
}

/**
 * Who is signed in, and «Logg ut», for the end of a panel's list: not pinned to its bottom, where
 * it would cover what the keyboard scrolls to (WCAG 2.4.11).
 */
export const SignedIn = ({ name, email, signOutHref, onSignOut }: SignedInProps) => {
  const t = useT();
  return (
    <div className="uib-shell-signed-in">
      <Paragraph className="uib-shell-user" data-size="sm" title={email}>
        <PersonIcon aria-hidden />
        <span>
          <span className="uib-visually-hidden">{t('shell.signedInAs')} </span>
          {name}
        </span>
      </Paragraph>
      <Link
        data-size="sm"
        href={signOutHref}
        onAuxClick={(event) => {
          // A middle click fires only `auxclick`, which a right click fires too.
          if (event.button === 1) onSignOut?.();
        }}
        onClick={() => onSignOut?.()}
      >
        <LeaveIcon aria-hidden />
        {t('shell.signOut')}
      </Link>
    </div>
  );
};
