import { Label, Paragraph, Select } from '@digdir/designsystemet-react';
import { demoVoiceOf, demoVoices, type DemoVoice } from '@genai/contracts';
import { useState } from 'react';
import { useT } from '../../i18n';

const languageKey = {
  'nb-NO': 'demos.voiceNbNo',
  'en-GB': 'demos.voiceEnGb',
  'en-US': 'demos.voiceEnUs',
} as const;

const genderKey = { female: 'demos.voiceFemale', male: 'demos.voiceMale' } as const;

export const VoiceSelect = ({
  id,
  label,
  description,
  value,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  value: string;
  onChange: (voice: string, known: DemoVoice | undefined) => void;
}) => {
  const t = useT();
  const [first] = useState(value);
  const unlisted = [...new Set([first, value])].filter((v) => !demoVoiceOf(v));
  return (
    <div className="field">
      <Label htmlFor={id}>{label}</Label>
      {description ? (
        <Paragraph data-size="sm" className="muted" id={`${id}-help`}>
          {description}
        </Paragraph>
      ) : null}
      <Select
        id={id}
        value={value}
        {...(description ? { 'aria-describedby': `${id}-help` } : {})}
        onChange={(e) => onChange(e.target.value, demoVoiceOf(e.target.value))}
      >
        {unlisted.map((v) => (
          <Select.Option key={v} value={v}>
            {v}
          </Select.Option>
        ))}
        {demoVoices.map((v) => (
          <Select.Option key={v.id} value={v.id}>
            {t('demos.voiceOption', {
              name: v.name,
              language: t(languageKey[v.language]),
              gender: t(genderKey[v.gender]),
            })}
          </Select.Option>
        ))}
      </Select>
    </div>
  );
};
