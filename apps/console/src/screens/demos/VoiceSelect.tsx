import { Fieldset, FieldsetDescription, FieldsetLegend, Radio } from '@digdir/designsystemet-react';
import {
  demoVoiceOf,
  demoVoiceProviders,
  demoVoices,
  silentVoice,
  type DemoVoice,
} from '@genai/contracts';
import { useId, useState } from 'react';
import { useT } from '../../i18n';

const languageKey = {
  'nb-NO': 'demos.voiceNbNo',
  'en-GB': 'demos.voiceEnGb',
  'en-US': 'demos.voiceEnUs',
} as const;

const genderKey = { female: 'demos.voiceFemale', male: 'demos.voiceMale' } as const;

export const VoiceSelect = ({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  value: string;
  onChange: (voice: string, known: DemoVoice | undefined) => void;
}) => {
  const t = useT();
  const name = useId();
  const [first] = useState(value);
  const unlisted = [...new Set([first, value])].filter((v) => v !== silentVoice && !demoVoiceOf(v));
  const pick = (voice: string) => onChange(voice, demoVoiceOf(voice));
  return (
    <Fieldset>
      <FieldsetLegend>{label}</FieldsetLegend>
      {description ? <FieldsetDescription>{description}</FieldsetDescription> : null}
      {unlisted.map((v) => (
        <Radio
          key={v}
          name={name}
          value={v}
          label={v}
          checked={value === v}
          onChange={() => pick(v)}
        />
      ))}
      {demoVoiceProviders.map((provider) =>
        provider.available ? (
          demoVoices
            .filter((v) => v.provider === provider.id)
            .map((v) => (
              <Radio
                key={v.id}
                name={name}
                value={v.id}
                label={v.name}
                description={t('demos.voiceMeta', {
                  gender: t(genderKey[v.gender]),
                  language: t(languageKey[v.language]),
                  provider: provider.name,
                })}
                checked={value === v.id}
                onChange={() => pick(v.id)}
              />
            ))
        ) : (
          <Radio
            key={provider.id}
            name={name}
            value={provider.id}
            label={provider.name}
            description={t('demos.voiceNotYet')}
            checked={false}
            disabled
            readOnly
          />
        ),
      )}
      <Radio
        name={name}
        value={silentVoice}
        label={t('demos.voiceNone')}
        description={t('demos.voiceNoneHelp')}
        checked={value === silentVoice}
        onChange={() => pick(silentVoice)}
      />
    </Fieldset>
  );
};
