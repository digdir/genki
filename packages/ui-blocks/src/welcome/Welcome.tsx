import { Button, Heading } from '@digdir/designsystemet-react';
import { FileTextIcon } from '@navikt/aksel-icons';
import { useT } from '../i18n.js';

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

export interface WelcomeProps {
  /** The reader's first name. Without it the greeting is «Hei». */
  name?: string | undefined;
  /** Designsystemet's `data-color` for the block, set only when given. */
  color?: string | undefined;
  className?: string | undefined;
}

/**
 * What a reader meets before the first question. Both lines are one heading, since a second
 * would be an outline entry with nothing under it.
 */
export const Welcome = ({ name, color, className }: WelcomeProps) => {
  const t = useT();
  return (
    <div className={classes('uib-welcome', className)} data-color={color}>
      <Heading data-size="lg" level={2}>
        {name ? t('welcome.greeting', { name }) : t('welcome.greetingUnnamed')}{' '}
        <span aria-hidden="true">👋</span>
        <br />
        {t('welcome.question')}
      </Heading>
    </div>
  );
};

export interface SuggestionsProps {
  /** Ready-made questions. Nothing is drawn without them. */
  suggestions: readonly string[];
  /** The reader picked one. Fill the field with it and put the caret there; do not send it. */
  onPick: (question: string) => void;
  color?: string | undefined;
  className?: string | undefined;
}

/** Ready-made questions under the field, a row each because they are long. */
export const Suggestions = ({ suggestions, onPick, color, className }: SuggestionsProps) => {
  const t = useT();
  if (suggestions.length === 0) return null;
  return (
    <div className={classes('uib-welcome-suggestions', className)} data-color={color}>
      <Heading className="uib-welcome-suggestions-title" data-size="2xs" level={3}>
        {t('welcome.suggestions')}
      </Heading>
      <ul className="uib-welcome-suggestions-list">
        {suggestions.map((question) => (
          <li key={question}>
            <Button
              className="uib-welcome-suggestion"
              data-color="neutral"
              onClick={() => onPick(question)}
              variant="tertiary"
            >
              <FileTextIcon aria-hidden className="uib-welcome-suggestion-icon" />
              {question}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
};
