import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Field,
  Fieldset,
  Heading,
  Label,
  Paragraph,
  Radio,
  Switch,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { createFormat } from '@genai/i18n';
import { useState } from 'react';
import { Icon } from '../../components/Icon';
import {
  piiText,
  qualityFeedback,
  qualityTags,
  type FeedbackDetail,
  type FeedbackType,
  type SplitLabel,
} from '../../data/quality';
import { formatDate, formatDateTime, usePortalFormat } from '../../format';
import type { Format, PlainKey } from '../../i18n';
import type { FeedbackItem } from '../../types';
import { langOf, type NewCase, type SetFlash } from './shared';

const typeIcon: Record<FeedbackType, string> = {
  'Tommel opp':
    'M7 11v9H4v-9z M7 11l4-7c1.5 0 2.5 1 2.5 2.5V10h5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.3 20H7',
  'Tommel ned':
    'M7 13V4H4v9z M7 13l4 7c1.5 0 2.5-1 2.5-2.5V14h5a2 2 0 0 0 2-2.3l-1.2-6A2 2 0 0 0 17.3 4H7',
  'Endret utkast': 'M4 20h4L19 9l-4-4L4 16z',
  'Avvist godkjenning': 'M6 6l12 12M18 6L6 18',
  Flagget: 'M5 21V4h11l-2 4 2 4H5',
};

const typeColor: Record<FeedbackType, 'success' | 'danger' | 'info' | 'warning'> = {
  'Tommel opp': 'success',
  'Tommel ned': 'danger',
  'Endret utkast': 'info',
  'Avvist godkjenning': 'warning',
  Flagget: 'danger',
};

const replacements = { Navn: '[NAVN]', Telefon: '[TELEFON]' } as const;

const piiKinds = { Navn: 'qualityFeedback.piiName', Telefon: 'qualityFeedback.piiPhone' } as const;

const splitNames = {
  Trening: 'qualityTests.splitTrain',
  Validering: 'qualityTests.splitValidation',
  Låst: 'qualityTests.splitLocked',
} as const;

const splitOptions: [SplitLabel, PlainKey, PlainKey][] = [
  ['Trening', 'qualityTests.splitTrain', 'qualityFeedback.splitTrainHelp'],
  ['Validering', 'qualityTests.splitValidation', 'qualityFeedback.splitValidationHelp'],
  ['Låst', 'qualityTests.splitLocked', 'qualityFeedback.splitLockedHelp'],
];

const typeKeys: Record<FeedbackType, PlainKey> = {
  'Tommel opp': 'qualityFeedback.typeUp',
  'Tommel ned': 'qualityFeedback.typeDown',
  'Endret utkast': 'qualityFeedback.typeEdited',
  'Avvist godkjenning': 'qualityFeedback.typeRejected',
  Flagget: 'qualityFeedback.typeFlagged',
};

export const MIN_CLUSTER = 5;

const proposed = 'forslag';

export const feedbackFrom = (
  items: FeedbackItem[],
  live = false,
  f: Format = createFormat('nb'),
): FeedbackDetail[] =>
  items.map((item, i) => {
    const known = live || !item.task ? undefined : qualityFeedback.find((f) => f.run === item.task);
    if (known) return { ...known, c: item.comment ?? '' };
    const type: FeedbackType = item.rating === 'up' ? 'Tommel opp' : 'Tommel ned';
    return {
      id: `api-${i}`,
      group: type,
      type,
      when: /^\d{4}-\d{2}-\d{2}$/.test(item.at)
        ? formatDate(item.at, f)
        : formatDateTime(item.at, f),
      q: '',
      c: item.comment ?? '',
      ...(item.task ? { run: item.task } : {}),
    };
  });

interface Wizard {
  id: string;
  step: 1 | 2 | 3;
  pii: Record<number, boolean>;
  input: string;
  crit: string;
  tags: string[];
  split: SplitLabel;
  tried: boolean;
}

const splitDiff = (before: string, after: string) => {
  const stem = before.slice(0, -1);
  return after.startsWith(stem)
    ? { same: stem, added: after.slice(stem.length) }
    : { same: after, added: '' };
};

export const FeedbackTab = ({
  feedback,
  added,
  onAdded,
  onAddCase,
  onShowProposal,
  onPropose,
  setFlash,
}: {
  feedback: FeedbackDetail[];
  added: Record<string, string>;
  onAdded: (feedbackId: string, caseId: string) => void;
  onAddCase: (c: NewCase) => string;
  onShowProposal: (id: string) => void;
  onPropose?: (feedback: FeedbackDetail, input: string, expected: string) => Promise<boolean>;
  setFlash: SetFlash;
}) => {
  const { t } = usePortalFormat();
  const [type, setType] = useState<'alle' | FeedbackType>('alle');
  const [grouped, setGrouped] = useState(true);
  const [wiz, setWiz] = useState<Wizard>();
  const filtered = feedback.filter((x) => type === 'alle' || x.type === type);
  const size = (group: string) => feedback.filter((x) => x.group === group).length;
  const wset = (p: Partial<Wizard>) => setWiz((w) => (w ? { ...w, ...p } : w));

  const start = (x: FeedbackDetail) =>
    setWiz({
      id: x.id,
      step: onPropose ? 2 : 1,
      pii: { 1: true, 3: true, 5: true },
      input: x.q,
      crit: x.c
        ? x.type === 'Endret utkast'
          ? t('qualityFeedback.editedCriterion')
          : t('qualityFeedback.answerShould', { text: x.c.replace(/\.$/, '').toLowerCase() })
        : '',
      tags: [],
      split: 'Validering',
      tried: false,
    });

  const renderWizard = (w: Wizard) => {
    const unconfirmed = piiText.filter(([, kind], i) => kind && !w.pii[i]).length;
    const critErr =
      w.tried && w.step === 2 && !w.crit.trim() ? t('qualityFeedback.describeGood') : '';
    const inputErr =
      onPropose && w.tried && !w.input.trim() ? t('qualityFeedback.questionProblem') : '';
    const propose = async () => {
      if (!onPropose) return;
      if (!w.input.trim() || !w.crit.trim()) {
        wset({ tried: true });
        return;
      }
      const item = feedback.find((f) => f.id === w.id);
      if (!item || !(await onPropose(item, w.input.trim(), w.crit.trim()))) return;
      onAdded(w.id, proposed);
      setWiz(undefined);
      setFlash({ text: t('qualityFeedback.proposalSent'), color: 'success' });
    };
    const next = () => {
      if (onPropose) {
        void propose();
        return;
      }
      if (w.step === 2 && !w.crit.trim()) {
        wset({ tried: true });
        return;
      }
      if (w.step < 3) {
        wset({ step: (w.step + 1) as 2 | 3, tried: false });
        return;
      }
      const id = onAddCase({
        input: w.input,
        kind: 'kriterier',
        crit: w.crit,
        tags: w.tags,
        split: w.split,
      });
      onAdded(w.id, id);
      setWiz(undefined);
      setFlash({
        text: t('qualityFeedback.caseAdded', {
          id,
          split: t(splitNames[w.split]).toLowerCase(),
        }),
        color: 'success',
      });
    };
    return (
      <div className="wizard">
        {onPropose ? null : (
          <ol aria-label={t('qualityFeedback.steps')} className="wizard-steps">
            {(
              [
                'qualityFeedback.stepAnonymise',
                'qualityFeedback.stepReview',
                'qualityFeedback.stepSplit',
              ] as const
            ).map((label, i) => {
              const n = i + 1;
              const state = w.step > n ? 'done' : w.step === n ? 'current' : 'todo';
              return (
                <li key={label} aria-current={w.step === n ? 'step' : undefined} className={state}>
                  <span aria-hidden="true" className="step-dot">
                    {n}
                  </span>
                  {t(label)}
                </li>
              );
            })}
          </ol>
        )}
        {w.step === 1 ? (
          <div className="stack-sm">
            <Paragraph data-size="sm">{t('qualityFeedback.piiFound')}</Paragraph>
            <p className="pii-text">
              {piiText.map(([text, kind], i) =>
                kind ? (
                  <mark key={i} className={w.pii[i] ? 'replaced' : undefined}>
                    {w.pii[i] ? replacements[kind] : text}
                    <span className="pii-kind"> ({t(piiKinds[kind])})</span>
                  </mark>
                ) : (
                  <span key={i}>{text}</span>
                ),
              )}
            </p>
            <Fieldset>
              <Fieldset.Legend>{t('qualityFeedback.replace')}</Fieldset.Legend>
              {piiText.map(([text, kind], i) =>
                kind ? (
                  <Checkbox
                    key={i}
                    label={t('qualityFeedback.replaceWith', {
                      text,
                      replacement: replacements[kind],
                    })}
                    checked={Boolean(w.pii[i])}
                    onChange={() => wset({ pii: { ...w.pii, [i]: !w.pii[i] } })}
                  />
                ) : null,
              )}
            </Fieldset>
            {unconfirmed ? (
              <Alert data-color="warning" data-size="sm">
                {t('qualityFeedback.piiRemaining', { count: unconfirmed })}
              </Alert>
            ) : null}
          </div>
        ) : null}
        {w.step === 2 ? (
          <div className="stack-sm">
            <Field>
              <Label htmlFor="wz-in">{t('qualityFeedback.input')}</Label>
              <Textarea
                id="wz-in"
                rows={2}
                value={w.input}
                aria-invalid={inputErr ? true : undefined}
                onChange={(e) => wset({ input: e.target.value })}
              />
              {inputErr ? <ValidationMessage>{inputErr}</ValidationMessage> : null}
            </Field>
            <Field>
              <Label htmlFor="wz-crit">{t('qualityFeedback.goodResult')}</Label>
              <Field.Description>{t('qualityFeedback.suggested')}</Field.Description>
              <Textarea
                id="wz-crit"
                rows={2}
                value={w.crit}
                aria-invalid={critErr ? true : undefined}
                onChange={(e) => wset({ crit: e.target.value })}
              />
              {critErr ? <ValidationMessage>{critErr}</ValidationMessage> : null}
            </Field>
            {onPropose ? null : (
              <Fieldset>
                <Fieldset.Legend>{t('qualityFeedback.topics')}</Fieldset.Legend>
                <div className="tag-row">
                  {qualityTags.map((t) => (
                    <Chip.Checkbox
                      key={t}
                      checked={w.tags.includes(t)}
                      onChange={() =>
                        wset({
                          tags: w.tags.includes(t) ? w.tags.filter((x) => x !== t) : [...w.tags, t],
                        })
                      }
                    >
                      {t}
                    </Chip.Checkbox>
                  ))}
                </div>
              </Fieldset>
            )}
          </div>
        ) : null}
        {w.step === 3 ? (
          <Fieldset>
            <Fieldset.Legend>{t('qualityFeedback.whichPart')}</Fieldset.Legend>
            {splitOptions.map(([id, label, desc]) => (
              <Radio
                key={id}
                name="wz-split"
                label={t(label)}
                description={t(desc)}
                checked={w.split === id}
                onChange={() => wset({ split: id })}
              />
            ))}
          </Fieldset>
        ) : null}
        <div className="actions">
          {w.step > 1 && !onPropose ? (
            <Button
              variant="secondary"
              data-size="sm"
              onClick={() => wset({ step: (w.step - 1) as 1 | 2 })}
            >
              {t('qualityFeedback.previous')}
            </Button>
          ) : null}
          <Button variant="primary" data-size="sm" onClick={next}>
            {t(
              onPropose
                ? 'qualityFeedback.addToSet'
                : w.step === 3
                  ? 'qualityFeedback.addCase'
                  : 'qualityFeedback.next',
            )}
          </Button>
          <Button variant="tertiary" data-size="sm" onClick={() => setWiz(undefined)}>
            {t('qualityFeedback.cancel')}
          </Button>
        </div>
      </div>
    );
  };

  const renderItem = (x: FeedbackDetail) => {
    const isWiz = wiz?.id === x.id;
    const diff = x.before && x.after ? splitDiff(x.before, x.after) : undefined;
    return (
      <li key={x.id} className="feedback-item">
        <div className="row-wrap">
          <Tag data-size="sm" data-color={typeColor[x.type]}>
            <Icon d={typeIcon[x.type]} size={14} strokeWidth={1.8} />
            {t(typeKeys[x.type])}
          </Tag>
          <span className="meta">
            {x.when}
            {x.run ? ` · ${t('qualityFeedback.run', { id: x.run })}` : ''}
          </span>
          {added[x.id] ? (
            <Tag data-size="sm" data-color="success">
              {added[x.id] === proposed
                ? t('qualityFeedback.sentAsProposal')
                : t('qualityFeedback.addedAs', { id: added[x.id] ?? '' })}
            </Tag>
          ) : null}
        </div>
        <span className="feedback-q" lang={langOf(x.q)}>
          {x.q || t('qualityFeedback.noQuestion')}
        </span>
        {x.a && !x.before ? (
          <span className="feedback-a" lang={langOf(x.a)}>
            {x.a}
          </span>
        ) : null}
        {diff && x.before ? (
          <div className="diff-pair">
            <div className="before">
              <span className="diff-label">{t('qualityFeedback.before')}</span>
              <span>{x.before}</span>
            </div>
            <div className="after">
              <span className="diff-label">{t('qualityFeedback.after')}</span>
              <span>
                {diff.same}
                <ins>{diff.added}</ins>
              </span>
              <span className="diff-note">{t('qualityFeedback.underlined')}</span>
            </div>
          </div>
        ) : null}
        {x.c ? (
          <p className="feedback-c">
            <span className="meta-inline">{t('qualityFeedback.comment')} </span>«{x.c}»
          </p>
        ) : null}
        {!added[x.id] && !isWiz ? (
          <Button
            variant="secondary"
            data-size="sm"
            className="align-start"
            onClick={() => start(x)}
          >
            {t('qualityFeedback.makeCase')}
          </Button>
        ) : null}
        {isWiz && wiz ? renderWizard(wiz) : null}
      </li>
    );
  };

  const tooFewNote = (
    <li className="too-few">
      {t.rich('qualityFeedback.tooFew', { strong: (c) => <strong>{c}</strong> })}
    </li>
  );

  const groups = grouped
    ? [...new Set(filtered.map((x) => x.group))].map((name) => {
        const items = filtered.filter((x) => x.group === name);
        const few = size(name) < MIN_CLUSTER;
        return { name, items, few };
      })
    : [];
  const hiddenUngrouped = filtered.filter((x) => size(x.group) < MIN_CLUSTER).length;

  return (
    <div className="stack">
      <Alert data-color="info">
        <Paragraph>
          {t.rich('qualityFeedback.anonymousNote', { strong: (c) => <strong>{c}</strong> })}
        </Paragraph>
      </Alert>
      <div className="filter-row align-end">
        <Fieldset>
          <Fieldset.Legend>{t('qualityFeedback.type')}</Fieldset.Legend>
          <div className="tag-row">
            {(
              [
                'alle',
                'Tommel ned',
                'Tommel opp',
                'Endret utkast',
                'Avvist godkjenning',
                'Flagget',
              ] as const
            ).map((x) => (
              <Chip.Radio key={x} name="fbt" checked={type === x} onChange={() => setType(x)}>
                {x === 'alle' ? t('qualityFeedback.all') : t(typeKeys[x])}
              </Chip.Radio>
            ))}
          </div>
        </Fieldset>
        <Switch
          label={t('qualityFeedback.groupSimilar')}
          checked={grouped}
          onChange={() => setGrouped((g) => !g)}
        />
      </div>
      {feedback.length === 0 ? (
        <div className="state empty">
          <Heading level={2} data-size="2xs">
            {t('qualityFeedback.none')}
          </Heading>
          <Paragraph>{t('qualityFeedback.noneText')}</Paragraph>
        </div>
      ) : grouped ? (
        groups.map((g) => (
          <section
            key={g.name}
            className="stack-sm"
            aria-labelledby={`fb-${g.name.replace(/\W+/g, '-')}`}
          >
            <div className="row-wrap">
              <Heading level={2} data-size="2xs" id={`fb-${g.name.replace(/\W+/g, '-')}`}>
                {g.name}
              </Heading>
              <span className="meta">
                {g.few
                  ? t('qualityFeedback.fewerThan')
                  : t('qualityFeedback.count', { count: g.items.length })}
              </span>
              {g.name === 'Bruker gamle tall' ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onShowProposal('F-12')}
                >
                  {t('qualityFeedback.seeProposal')}
                </button>
              ) : null}
            </div>
            <ul className="feedback-list">{g.few ? tooFewNote : g.items.map(renderItem)}</ul>
          </section>
        ))
      ) : (
        <ul className="feedback-list">
          {hiddenUngrouped > 0 ? tooFewNote : null}
          {filtered.filter((x) => size(x.group) >= MIN_CLUSTER).map(renderItem)}
        </ul>
      )}
    </div>
  );
};
