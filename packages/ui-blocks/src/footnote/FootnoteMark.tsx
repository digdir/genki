import { Link } from '@digdir/designsystemet-react';
import type { MouseEvent, Ref } from 'react';

export interface FootnoteMarkProps {
  /** The number drawn, the excerpt's: the same wherever the footnote is shown. */
  number: number;
  /** What a screen reader hears, and the title under the pointer. */
  label: string;
  href?: string | undefined;
  onClick?: ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
  id?: string | undefined;
  /** Raised beside the word before it, as in an answer's text; level in a row otherwise. */
  raised?: boolean | undefined;
  linkRef?: Ref<HTMLAnchorElement> | undefined;
}

/**
 * A footnote's number in a small round mark, as kunnskapsassistenten draws it, wherever a
 * footnote is shown: in the answer's text, and beside an excerpt's title in Sources. Named by
 * `aria-label`, since a bare «[3]» tells a screen reader nothing. The brackets stay in the text,
 * out of sight, so a copied answer still reads «[1]». With nowhere to go it is a mark and not a
 * link, which would jump to the top of the page.
 */
export const FootnoteMark = ({
  number,
  label,
  href,
  onClick,
  id,
  raised,
  linkRef,
}: FootnoteMarkProps) => {
  const drawn = (
    <>
      <span className="uib-footnote-copy">[</span>
      {number}
      <span className="uib-footnote-copy">]</span>
    </>
  );
  return href === undefined && onClick === undefined ? (
    <span
      id={id}
      className="uib-footnote-mark"
      data-raised={raised || undefined}
      role="img"
      aria-label={label}
      title={label}
    >
      {drawn}
    </span>
  ) : (
    <Link
      ref={linkRef}
      id={id}
      className="uib-footnote-mark"
      data-raised={raised || undefined}
      href={href ?? '#'}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {drawn}
    </Link>
  );
};
