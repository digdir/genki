import {
  Field,
  Heading,
  Label,
  Paragraph,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useEffect, useRef } from 'react';
import {
  isUnmaskedReasonGiven,
  mediaKind,
  minimumUnmaskedReason,
  unmaskedTypes,
} from '../../data/unmasked-input';
import { useT } from '../../i18n';
import type { UnmaskedInputUse } from '../../types';

interface Props {
  uses: UnmaskedInputUse[];
  reasons: Record<string, string>;
  refused: Record<string, string>;
  onReason: (mediaType: string, reason: string) => void;
}

export const UnmaskedInputConsent = ({ uses, reasons, refused, onReason }: Props) => {
  const t = useT();
  const fields = useRef(new Map<string, HTMLTextAreaElement>());
  const firstRefused = Object.keys(refused)[0];
  useEffect(() => {
    if (firstRefused) fields.current.get(firstRefused)?.focus();
  }, [firstRefused, refused]);
  return (
    <section className="stack-sm" aria-labelledby="unmasked-h">
      <Heading level={3} data-size="xs" id="unmasked-h">
        {t('unmaskedInput.heading')}
      </Heading>
      <Paragraph data-size="sm">{t('unmaskedInput.intro')}</Paragraph>
      {unmaskedTypes(uses).map((mediaType) => {
        const reason = reasons[mediaType] ?? '';
        const error =
          refused[mediaType] ??
          (reason && !isUnmaskedReasonGiven(reason)
            ? t('unmaskedInput.reasonTooShort', { min: minimumUnmaskedReason })
            : undefined);
        const id = `unmasked-${mediaType}`;
        return (
          <Field key={mediaType} className="reason-field">
            <Label htmlFor={id}>{t('unmaskedInput.reasonLabel', { mediaType })}</Label>
            {uses
              .filter((u) => u.mediaType === mediaType)
              .map((u) => (
                <Field.Description key={`${u.flow}-${u.step}`}>
                  {t('unmaskedInput.usedIn', {
                    kind: mediaKind(t, mediaType),
                    mediaType,
                    step: u.stepName ?? u.step,
                    flow: u.flow,
                  })}
                </Field.Description>
              ))}
            <Textarea
              id={id}
              ref={(el) => {
                if (el) fields.current.set(mediaType, el);
                else fields.current.delete(mediaType);
              }}
              rows={2}
              value={reason}
              aria-invalid={error ? true : undefined}
              onChange={(e) => onReason(mediaType, e.target.value)}
            />
            {error ? <ValidationMessage>{error}</ValidationMessage> : null}
          </Field>
        );
      })}
    </section>
  );
};
