import { Field, Label, Select } from '@digdir/designsystemet-react';
import { useId } from 'react';
import { answerLanguages, type AnswerLanguage } from '../../data/service-languages';
import { useT, type PlainKey } from '../../i18n';

const labels: Record<AnswerLanguage | '', PlainKey> = {
  '': 'playground.answerLanguageAuto',
  nb: 'languageTabs.tabNb',
  nn: 'languageTabs.tabNn',
  en: 'languageTabs.tabEn',
};

export const AnswerLanguagePicker = ({
  value,
  onChange,
}: {
  value: AnswerLanguage | '';
  onChange: (value: AnswerLanguage | '') => void;
}) => {
  const t = useT();
  const id = useId();
  return (
    <Field className="narrow-field" data-size="sm">
      <Label htmlFor={id}>{t('playground.answerLanguage')}</Label>
      <Select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as AnswerLanguage | '')}
      >
        {(['', ...answerLanguages] as const).map((l) => (
          <Select.Option key={l} value={l}>
            {t(labels[l])}
          </Select.Option>
        ))}
      </Select>
    </Field>
  );
};
