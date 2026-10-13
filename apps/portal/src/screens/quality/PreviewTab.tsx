import { Button, Chip, Field, Fieldset, Label, Textarea } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../i18n';

const thumb =
  'M7 11v9H4v-9z M7 11l4-7c1.5 0 2.5 1 2.5 2.5V10h5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.3 20H7';
const reasons = [
  ['wrong', 'quality.reasonWrong'],
  ['noSource', 'quality.reasonNoSource'],
  ['outdated', 'quality.reasonOutdated'],
  ['hard', 'quality.reasonHard'],
] as const;

interface ChatState {
  vote: 'up' | 'down' | undefined;
  reasons: string[];
  comment: string;
  sent: boolean;
  status: 'none' | 'sent' | 'up' | 'down';
}

const statusKeys = {
  sent: 'quality.thanksSent',
  up: 'quality.thanksUp',
  down: 'quality.thanksDown',
} as const;

const initial: ChatState = {
  vote: undefined,
  reasons: [],
  comment: '',
  sent: false,
  status: 'none',
};

export const PreviewTab = () => {
  const t = useT();
  const [c, setC] = useState<ChatState>(initial);
  const set = (p: Partial<ChatState>) => setC((s) => ({ ...s, ...p }));
  const vote = (v: 'up' | 'down') => {
    if (!c.sent) set({ vote: v, status: 'none' });
  };
  return (
    <div className="stack-sm preview-tab">
      <p className="lead measure">{t('quality.previewLead')}</p>
      <div className="chat-preview">
        <div className="chat-question">{t('quality.previewQuestion')}</div>
        <div className="chat-answer">
          <div className="chat-answer-text">
            {t('quality.previewAnswer')}
            <ol>
              <li>
                <a href="#/log">{t('quality.previewSource')}</a>
              </li>
            </ol>
          </div>
          <div role="group" aria-labelledby="fb-q" className="stack-sm">
            <div className="row-wrap">
              <span id="fb-q" className="meta">
                {t('quality.helpful')}
              </span>
              <Button
                variant={c.vote === 'up' ? 'primary' : 'secondary'}
                data-size="sm"
                aria-pressed={c.vote === 'up'}
                aria-disabled={c.sent || undefined}
                onClick={() => vote('up')}
              >
                <Icon d={thumb} size={18} />
                {t('quality.yes')}
              </Button>
              <Button
                variant={c.vote === 'down' ? 'primary' : 'secondary'}
                data-size="sm"
                aria-pressed={c.vote === 'down'}
                aria-disabled={c.sent || undefined}
                onClick={() => vote('down')}
              >
                <span className="flip">
                  <Icon d={thumb} size={18} />
                </span>
                {t('quality.no')}
              </Button>
            </div>
            {c.vote && !c.sent ? (
              <div className="feedback-form">
                {c.vote === 'down' ? (
                  <Fieldset data-size="sm">
                    <Fieldset.Legend>{t('quality.whatWrong')}</Fieldset.Legend>
                    <div className="tag-row">
                      {reasons.map(([r, key]) => (
                        <Chip.Checkbox
                          key={r}
                          data-size="sm"
                          checked={c.reasons.includes(r)}
                          onChange={() =>
                            set({
                              reasons: c.reasons.includes(r)
                                ? c.reasons.filter((x) => x !== r)
                                : [...c.reasons, r],
                            })
                          }
                        >
                          {t(key)}
                        </Chip.Checkbox>
                      ))}
                    </div>
                  </Fieldset>
                ) : null}
                <Field data-size="sm">
                  <Label htmlFor="fb-kom">{t('quality.commentOptional')}</Label>
                  <Textarea
                    id="fb-kom"
                    rows={2}
                    maxLength={300}
                    value={c.comment}
                    aria-describedby="fb-kom-hjelp"
                    onChange={(e) => set({ comment: e.target.value })}
                  />
                  <span id="fb-kom-hjelp" className="meta-xs">
                    {t('quality.commentCount', { count: c.comment.length })}
                  </span>
                </Field>
                <div className="actions">
                  <Button
                    variant="primary"
                    data-size="sm"
                    onClick={() => set({ sent: true, status: 'sent' })}
                  >
                    {t('quality.send')}
                  </Button>
                  <Button
                    variant="tertiary"
                    data-size="sm"
                    onClick={() => set({ sent: true, status: c.vote === 'up' ? 'up' : 'down' })}
                  >
                    {t('quality.skip')}
                  </Button>
                </div>
              </div>
            ) : null}
            <p role="status" className="meta">
              {c.status === 'none' ? '' : t(statusKeys[c.status])}
            </p>
          </div>
        </div>
      </div>
      <Button
        variant="tertiary"
        data-size="sm"
        className="align-start"
        onClick={() => setC(initial)}
      >
        {t('quality.resetExample')}
      </Button>
    </div>
  );
};
