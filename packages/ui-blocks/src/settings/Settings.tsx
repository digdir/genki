import { Heading, ToggleGroup } from '@digdir/designsystemet-react';
import { MonitorIcon, MoonIcon, SunIcon } from '@navikt/aksel-icons';
import { createContext, useContext, useId, type ReactNode } from 'react';
import { useT } from '../i18n.js';
import { isColorScheme, type ColorScheme } from './colorScheme.js';

type HeadingLevel = 1 | 2 | 3 | 4 | 5;

export interface ColorSchemeToggleProps {
  /** The scheme in use, as the host keeps it. Without it, «Auto» is chosen. */
  value?: ColorScheme | undefined;
  /** The reader chose a scheme. The host stores it and sets `data-color-scheme` on its root. */
  onChange: (scheme: ColorScheme) => void;
  className?: string | undefined;
}

export interface SettingsProps {
  /** The reader's colour scheme, as the host keeps it. Without it, «Auto» is chosen. */
  colorScheme?: ColorScheme | undefined;
  /** The reader chose a colour scheme. The host stores it and sets `data-color-scheme`. */
  onColorSchemeChange: (scheme: ColorScheme) => void;
  /** The level of «Innstillinger». Each section's heading is one below. */
  headingLevel?: HeadingLevel | undefined;
  /** The host's own sections, after the colour scheme, each a `SettingsSection`. */
  children?: ReactNode;
  /** Designsystemet's `data-color` for the block, set only when given. */
  color?: string | undefined;
  className?: string | undefined;
}

export interface SettingsSectionProps {
  /** The section's heading, which also names it. */
  title: ReactNode;
  children?: ReactNode;
  className?: string | undefined;
}

const choices = [
  { value: 'light', Icon: SunIcon },
  { value: 'dark', Icon: MoonIcon },
  { value: 'auto', Icon: MonitorIcon },
] as const;

const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ');
const colored = (color: string | undefined) => (color ? { 'data-color': color } : {});

/** The level of a section's heading, one below the block's. */
const SectionLevel = createContext<HeadingLevel | 6>(3);

/**
 * Light, dark, or follow the operating system. A `ToggleGroup`: three answers and one chosen, read
 * as a radio group. Words beside the icons, since Designsystemet asks for a tooltip on icon-only
 * items. It shows the host's value, not the click: the host decides when the choice is taken.
 */
export const ColorSchemeToggle = ({ value, onChange, className }: ColorSchemeToggleProps) => {
  const t = useT();
  return (
    <ToggleGroup
      aria-label={t('settings.colorScheme')}
      className={classes('uib-settings-color-scheme', className)}
      data-size="sm"
      onChange={(chosen) => {
        if (isColorScheme(chosen)) onChange(chosen);
      }}
      value={isColorScheme(value) ? value : 'auto'}
      variant="secondary"
    >
      {choices.map(({ value: scheme, Icon }) => (
        <ToggleGroup.Item key={scheme} value={scheme}>
          <Icon aria-hidden />
          {t(`settings.${scheme}`)}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup>
  );
};

/** A section of «Innstillinger» with its heading, for the host's own choices. */
export const SettingsSection = ({ title, children, className }: SettingsSectionProps) => {
  const level = useContext(SectionLevel);
  const id = useId();
  return (
    <section className={classes('uib-settings-section', className)} aria-labelledby={id}>
      <Heading className="uib-settings-section-title" data-size="sm" id={id} level={level}>
        {title}
      </Heading>
      {children}
    </section>
  );
};

/**
 * «Innstillinger»: the reader's choices, starting with the colour scheme. Each takes effect at
 * once, so there is no «Lagre». The block draws the choice and reports it; the host stores it and
 * applies it.
 */
export const Settings = ({
  colorScheme,
  onColorSchemeChange,
  headingLevel = 2,
  children,
  color,
  className,
}: SettingsProps) => {
  const t = useT();
  return (
    <SectionLevel.Provider value={(headingLevel + 1) as HeadingLevel | 6}>
      <article className={classes('uib-settings', className)} {...colored(color)}>
        <Heading className="uib-settings-title" data-size="lg" level={headingLevel}>
          {t('settings.title')}
        </Heading>
        {/* The toggle names itself «Fargemodus» to a screen reader; the heading says it to the eye. */}
        <SettingsSection title={t('settings.colorScheme')}>
          <ColorSchemeToggle onChange={onColorSchemeChange} value={colorScheme} />
        </SettingsSection>
        {children}
      </article>
    </SectionLevel.Provider>
  );
};
