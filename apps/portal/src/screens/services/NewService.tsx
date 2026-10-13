import { Button, Chip, Field, Heading, Label, Tag, Textarea } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../i18n';
import { jobKeys, templateKeys } from '../../data/service-labels';
import { jobs, templates, type JobId } from '../../data/services';

export const guessJob = (text: string): JobId => {
  const lower = text.toLowerCase();
  if (/hent|felt|uttrekk|søknad|opplysning|extract|invoice|application|details/.test(lower))
    return 'extracts';
  if (/utkast|brev|svarbrev|vedtak|draft|letter|reply|complaint/.test(lower)) return 'drafts';
  if (/klarspråk|nynorsk|omskriv|skriv om|rewrite|plain language/.test(lower)) return 'rewrites';
  if (/oppsum|høring|summar|consultation/.test(lower)) return 'summarises';
  if (/sorter|fordel|post|sort|route|mail/.test(lower)) return 'sorts';
  if (/møte|lyd|transkr|opptak|meeting|audio|transcri|recording/.test(lower)) return 'transcribes';
  if (/steg|forbered|regelverk|prepare|regulation/.test(lower)) return 'prepares';
  return 'answers';
};

export const NewService = ({
  onStart,
  live = false,
}: {
  onStart: (job: JobId, userText: string, name?: string) => void;
  live?: boolean;
}) => {
  const t = useT();
  const [text, setText] = useState('');
  return (
    <div className="new-service">
      <div className="stack-sm">
        <a href="#/services" className="back-link">
          <Icon d="M15 6l-6 6 6 6" size={18} />
          {t('services.back')}
        </a>
        <Heading level={1} data-size="lg">
          {t('services.newTitle')}
        </Heading>
        <p className="lead new-service-lead">{t('services.newLead')}</p>
      </div>
      <section aria-labelledby="lag-med-ki" className="make-with-ai">
        <div className="stack-xs">
          <Heading level={2} data-size="sm" id="lag-med-ki">
            {t('services.makeWithAi')}
          </Heading>
          <p className="body-text">{t('services.makeWithAiHelp')}</p>
        </div>
        <Field>
          <Label htmlFor="beskriv-jobben">{t('services.describeLabel')}</Label>
          <Textarea
            id="beskriv-jobben"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('services.describePlaceholder')}
          />
        </Field>
        <div className="tag-row">
          <span className="meta">{t('services.tryLabel')}</span>
          {[t('services.tryReply'), t('services.tryInvoices'), t('services.tryHearing')].map(
            (label) => (
              <Chip.Button key={label} onClick={() => setText(label)}>
                {label}
              </Chip.Button>
            ),
          )}
        </div>
        <Button
          variant="primary"
          className="align-start"
          onClick={() => {
            const request = text.trim() || t('services.defaultRequest');
            onStart(guessJob(request), request);
          }}
        >
          {t('services.startAssistant')}
        </Button>
        {live ? (
          <p className="meta">
            {t.rich('services.useFormRich', {
              link: (c) => <a href="#/services/new?skjema=1">{c}</a>,
            })}
          </p>
        ) : null}
      </section>
      <section aria-labelledby="velg-jobb" className="stack-sm">
        <Heading level={2} data-size="xs" id="velg-jobb">
          {t('services.pickJob')}
        </Heading>
        <div className="job-grid">
          {jobs.map((j) => (
            <button
              key={j.id}
              type="button"
              className="job-card"
              onClick={() =>
                onStart(
                  j.id,
                  t('services.jobRequest', { job: t(jobKeys[j.id].label).toLowerCase() }),
                )
              }
            >
              <span aria-hidden="true" className="job-icon">
                <Icon d={j.icon} size={26} />
              </span>
              <span className="job-label">{t(jobKeys[j.id].label)}</span>
              <span className="meta job-example">{t(jobKeys[j.id].example)}</span>
            </button>
          ))}
        </div>
      </section>
      <section aria-labelledby="fra-mal" className="stack-sm">
        <Heading level={2} data-size="xs" id="fra-mal">
          {t('services.fromTemplate')}
        </Heading>
        <div className="template-grid">
          {live ? null : (
            <button
              type="button"
              className="template-card"
              onClick={() => onStart('answers', t('services.kaRequest'))}
            >
              <span className="template-name">{t('services.kaName')}</span>
              <Tag data-size="sm" data-color="accent" className="align-start">
                {t(jobKeys.answers.tag)}
              </Tag>
              <span className="meta">{t('services.kaDescription')}</span>
            </button>
          )}
          {templates.map(([id, job, io]) => {
            const keys = templateKeys[id];
            const name = keys ? t(keys.name) : id;
            return (
              <button
                key={id}
                type="button"
                className="template-card"
                onClick={() => onStart(job, t('services.templateRequest', { name }), name)}
              >
                <span className="template-name">{name}</span>
                <Tag data-size="sm" data-color="accent" className="align-start">
                  {t(jobKeys[job].tag)}
                </Tag>
                <span className="meta">{keys ? t(keys.io) : io}</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
};
