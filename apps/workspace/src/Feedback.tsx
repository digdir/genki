import {
  Button,
  Chip,
  Field,
  Fieldset,
  Label,
  Paragraph,
  Textarea,
} from '@digdir/designsystemet-react';
import { useId, useState } from 'react';
import { translator, useT, type PlainKey } from './i18n';
import type { FeedbackInput, Rating } from './types';

const reasonKeys: PlainKey[] = [
  'feedback.reasonWrong',
  'feedback.reasonNoSource',
  'feedback.reasonOutdated',
  'feedback.reasonHard',
];
const stored = translator('nb');
const maxLength = 300;

const Thumb = ({ down = false }: { down?: boolean }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
    style={down ? { transform: 'rotate(180deg)' } : undefined}
  >
    <path d="M7 11v9H4v-9z M7 11l4-7c1.5 0 2.5 1 2.5 2.5V10h5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.3 20H7" />
  </svg>
);

interface Props {
  task?: string | undefined;
  onSend: (input: FeedbackInput) => Promise<void>;
}

export const Feedback = ({ task, onSend }: Props) => {
  const t = useT();
  const [rating, setRating] = useState<Rating>();
  const [picked, setPicked] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const commentId = useId();
  const counterId = useId();

  const choose = (value: Rating) => {
    if (sent) return;
    setRating(value);
    setStatus('');
  };

  const submit = async (withDetails: boolean) => {
    if (!rating || busy) return;
    setBusy(true);
    try {
      await onSend({
        ...(task ? { task } : {}),
        rating,
        reasons: withDetails && rating === 'down' ? picked : [],
        comment: withDetails ? comment : '',
      });
      setSent(true);
      setStatus(withDetails ? t('feedback.thanksDetails') : t('feedback.thanks'));
    } catch {
      setStatus(t('feedback.notSent'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="group" aria-label={t('feedback.label')} className="feedback">
      <div className="feedback-row">
        <span className="subtle-sm">{t('feedback.useful')}</span>
        <Button
          variant={rating === 'up' ? 'primary' : 'secondary'}
          data-size="sm"
          aria-pressed={rating === 'up'}
          aria-disabled={sent || undefined}
          onClick={() => choose('up')}
        >
          <Thumb />
          {t('feedback.yes')}
        </Button>
        <Button
          variant={rating === 'down' ? 'primary' : 'secondary'}
          data-size="sm"
          aria-pressed={rating === 'down'}
          aria-disabled={sent || undefined}
          onClick={() => choose('down')}
        >
          <Thumb down />
          {t('feedback.no')}
        </Button>
      </div>
      {rating && !sent ? (
        <div className="feedback-form">
          {rating === 'down' ? (
            <Fieldset data-size="sm">
              <Fieldset.Legend>{t('feedback.whatWrong')}</Fieldset.Legend>
              <div className="chips">
                {reasonKeys.map((key) => {
                  const reason = stored(key);
                  return (
                    <Chip.Checkbox
                      key={key}
                      data-size="sm"
                      checked={picked.includes(reason)}
                      onChange={() =>
                        setPicked((list) =>
                          list.includes(reason)
                            ? list.filter((r) => r !== reason)
                            : [...list, reason],
                        )
                      }
                    >
                      {t(key)}
                    </Chip.Checkbox>
                  );
                })}
              </div>
            </Fieldset>
          ) : null}
          <Field data-size="sm">
            <Label htmlFor={commentId}>{t('feedback.comment')}</Label>
            <Textarea
              id={commentId}
              rows={2}
              maxLength={maxLength}
              value={comment}
              aria-describedby={counterId}
              onChange={(e) => setComment(e.target.value)}
            />
            <span id={counterId} className="subtle-xs">
              {t('feedback.counter', { length: comment.length, max: maxLength })}
            </span>
          </Field>
          <div className="actions">
            <Button data-size="sm" loading={busy} onClick={() => void submit(true)}>
              {t('feedback.send')}
            </Button>
            <Button variant="tertiary" data-size="sm" onClick={() => void submit(false)}>
              {t('feedback.skip')}
            </Button>
          </div>
        </div>
      ) : null}
      <Paragraph role="status" data-size="sm" className="subtle-sm">
        {status}
      </Paragraph>
    </div>
  );
};
