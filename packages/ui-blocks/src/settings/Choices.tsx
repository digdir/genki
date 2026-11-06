import { Fieldset, Link, Radio, Switch } from '@digdir/designsystemet-react';
import { ExternalLinkIcon } from '@navikt/aksel-icons';
import { useId } from 'react';
import { useT } from '../i18n.js';
import { displayLevels, isDisplayLevel, type DisplayLevel } from './displayLevel.js';

const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ');

export interface DisplayLevelChoiceProps {
  /** The level in use, as the host keeps it. Without it, «Standard» is chosen. */
  value?: DisplayLevel | undefined;
  /** The reader chose a level. The host stores it and passes it back. */
  onChange: (level: DisplayLevel) => void;
  className?: string | undefined;
}

/**
 * «Standard» or «Detaljert»: how much an answer shows of how it was made. Radio buttons with a
 * line each, since the two differ by what they add, which a label alone cannot say. It shows the
 * host's value, not the click.
 */
export const DisplayLevelChoice = ({ value, onChange, className }: DisplayLevelChoiceProps) => {
  const t = useT();
  const name = useId();
  const chosen = isDisplayLevel(value) ? value : 'standard';
  return (
    <Fieldset className={classes('uib-settings-display-level', className)}>
      <Fieldset.Legend>{t('settings.displayLevelQuestion')}</Fieldset.Legend>
      {displayLevels.map((level) => (
        <Radio
          checked={chosen === level}
          description={t(`settings.${level}Description`)}
          key={level}
          label={t(`settings.${level}`)}
          name={name}
          onChange={() => onChange(level)}
          value={level}
        />
      ))}
    </Fieldset>
  );
};

/** A trial the reader can turn on: meant to be removed once it is decided, unlike a setting. */
export interface SettingsExperiment {
  /** Stable, and never reused for another trial. */
  id: string;
  title: string;
  /** One line on what changes when it is on. */
  description?: string | undefined;
  on: boolean;
  /** Where the trial is discussed, such as its issue. Opens in a new tab. */
  href?: string | undefined;
  /** The link's text, such as «Sak 115». «Les mer» without it. */
  hrefLabel?: string | undefined;
}

export interface ExperimentSwitchesProps {
  experiments: readonly SettingsExperiment[];
  /** The reader turned a trial on or off. The host stores it and passes it back. */
  onChange: (id: string, on: boolean) => void;
  className?: string | undefined;
}

/**
 * One switch per trial, each with its line and a link to where it is discussed. A switch, as it
 * takes effect at once, which is what Designsystemet says a switch is for.
 */
export const ExperimentSwitches = ({
  experiments,
  onChange,
  className,
}: ExperimentSwitchesProps) => {
  const t = useT();
  return (
    <div className={classes('uib-settings-experiments', className)}>
      {experiments.map((experiment) => {
        const link = experiment.href ? (
          <Link href={experiment.href} rel="noreferrer" target="_blank">
            {experiment.hrefLabel ?? t('settings.readMore')}
            {/* The icon is aria-hidden, so the new tab is said in words too. */}
            <span className="uib-visually-hidden"> {t('settings.newTab')}</span>
            <ExternalLinkIcon aria-hidden />
          </Link>
        ) : null;
        return (
          <Switch
            checked={experiment.on}
            description={
              experiment.description || link ? (
                <>
                  {experiment.description}
                  {experiment.description && link ? ' ' : null}
                  {link}
                </>
              ) : undefined
            }
            key={experiment.id}
            label={experiment.title}
            onChange={(event) => onChange(experiment.id, event.currentTarget.checked)}
          />
        );
      })}
    </div>
  );
};
