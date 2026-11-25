import { Fieldset, Paragraph, Radio, Tag, Textfield } from '@digdir/designsystemet-react';
import type { BlockDetail, BlockReview } from '@genai/contracts/blocks';
import { useLocale } from '@genai/i18n/react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { BusyButton } from '../../components/BusyButton';
import { reasonProblem } from '../../components/ReasonField';
import { useT, type PlainKey } from '../../i18n';
import { asBlockDraft, type BlockDraft } from './definitions';
import { dayOf } from './naming';
import { Problems } from './Problems';

type Choice = 'organisation' | 'everyone';

const reviewTag: Record<
  BlockReview['status'],
  { key: PlainKey; color: 'warning' | 'success' | 'danger' }
> = {
  pending: { key: 'design.inReview', color: 'warning' },
  approved: { key: 'design.approved', color: 'success' },
  declined: { key: 'design.declined', color: 'danger' },
};

/** «Deling»: our organisation or everyone; a designelement with code goes to an operator's review first. */
export const Sharing = ({
  api,
  tenant,
  detail,
  readOnly,
  onSave,
  onRequested,
}: {
  api: ApiClient;
  tenant: string;
  detail: BlockDetail;
  readOnly: boolean;
  onSave: (definition: BlockDraft, reason: string) => Promise<void>;
  onRequested: () => void;
}) => {
  const t = useT();
  const { locale } = useLocale();
  const current: Choice = detail.sharing === 'everyone' ? 'everyone' : 'organisation';
  const [choice, setChoice] = useState<Choice>(
    detail.review?.status === 'pending' ? 'everyone' : current,
  );
  const [why, setWhy] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const code = detail.tier === 'code';
  const review = detail.review;
  const toReview = code && choice === 'everyone' && current !== 'everyone';
  const pending = review?.status === 'pending';
  const whyProblem = tried && toReview ? reasonProblem(why, t) : undefined;

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    act(async () => {
      const base = asBlockDraft(detail.edition.definition);
      const label = t(
        choice === 'everyone' ? 'design.sharingEveryone' : 'design.sharingOrganisation',
      );
      await onSave(
        { ...base, spec: { ...base.spec, sharing: choice } },
        t('design.sharingReason', { choice: label }),
      );
    });

  const send = () => {
    setTried(true);
    if (reasonProblem(why, t)) return;
    void act(async () => {
      await api.design.requestShare(tenant, detail.id, detail.latest.version, why.trim());
      onRequested();
    });
  };

  return (
    <div className="stack design-sharing">
      <Fieldset>
        <Fieldset.Legend>{t('design.who')}</Fieldset.Legend>
        <Radio
          name="design-sharing"
          label={t('design.sharingOrganisation')}
          value="organisation"
          checked={choice === 'organisation'}
          disabled={readOnly}
          onChange={() => setChoice('organisation')}
        />
        <Radio
          name="design-sharing"
          label={t('design.sharingEveryone')}
          value="everyone"
          checked={choice === 'everyone'}
          disabled={readOnly}
          onChange={() => setChoice('everyone')}
        />
      </Fieldset>
      {toReview && !pending ? (
        <Textfield
          className="design-why"
          label={t('design.whyShare')}
          value={why}
          error={whyProblem}
          onChange={(e) => setWhy(e.target.value)}
        />
      ) : null}
      <div className="design-share-actions">
        {readOnly ? null : toReview ? (
          <BusyButton
            busy={busy}
            busyLabel={t('design.saving')}
            aria-disabled={pending || undefined}
            onClick={() => !pending && send()}
          >
            {t('design.sendToReview')}
          </BusyButton>
        ) : (
          <BusyButton
            busy={busy}
            busyLabel={t('design.saving')}
            aria-disabled={choice === current || undefined}
            onClick={() => choice !== current && void save()}
          >
            {t('design.save')}
          </BusyButton>
        )}
        {code && review ? (
          <span role="status" className="design-review">
            <Tag data-size="sm" data-color={reviewTag[review.status].color}>
              {t(reviewTag[review.status].key)}
            </Tag>
            <Paragraph data-size="sm" asChild>
              <span>{t('design.sentAt', { date: dayOf(review.at, locale) })}</span>
            </Paragraph>
          </span>
        ) : null}
      </div>
      {error ? <Problems error={error} /> : null}
    </div>
  );
};
