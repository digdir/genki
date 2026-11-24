import {
  Alert,
  Button,
  Divider,
  ErrorSummary,
  Field,
  Heading,
  Label,
  Paragraph,
  Table,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useId, useRef, useState, type ComponentRef, type MouseEvent, type ReactNode } from 'react';
import { ApiCallLink, type ApiCallPreview } from '../../components/ApiCall';
import { BackLink } from '../../components/BackLink';
import { reasonProblem } from '../../components/ReasonField';
import { useT } from '../../i18n';
import './first-publish.css';

/** Something that stops the first publish, and where it is put right. */
export interface Left {
  key: string;
  text: string;
  /** An address in the portal; a part of this page uses `on`. */
  href?: string;
  on?: 'risk' | 'guards';
}

export const ConfirmedTag = ({ confirmed }: { confirmed: boolean }) => {
  const t = useT();
  return (
    <Tag data-size="sm" data-color={confirmed ? 'success' : 'warning'}>
      {confirmed ? t('publish.confirmed') : t('publish.notConfirmed')}
    </Tag>
  );
};

/** The first publish of a new service as a page; Publiser is never locked and says what is left. */
export const FirstPublish = ({
  title,
  intro,
  backHref,
  left,
  facts,
  riskConfirmed,
  riskName,
  risk,
  guards,
  problems,
  apiCall,
  canPublish,
  onPublish,
}: {
  title: string;
  intro: string;
  backHref: string;
  left: Left[];
  facts: { label: string; value: ReactNode }[];
  riskConfirmed: boolean;
  riskName: string;
  risk: ReactNode;
  guards: ReactNode;
  problems?: ReactNode;
  apiCall: ApiCallPreview;
  canPublish: boolean;
  onPublish: (reason: string) => Promise<void>;
}) => {
  const t = useT();
  const ids = { reason: useId(), risk: useId(), guards: useId() };
  const summary = useRef<ComponentRef<typeof ErrorSummary>>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [tried, setTried] = useState(false);
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const parts = { risk: `${ids.risk}-section`, guards: `${ids.guards}-section` };
  const jump = (event: MouseEvent<HTMLAnchorElement>, item: Left) => {
    if (!item.on) return;
    event.preventDefault();
    const target = document.getElementById(parts[item.on]);
    target?.scrollIntoView?.({ block: 'start' });
    target?.focus({ preventScroll: true });
  };
  const publish = async () => {
    if (state === 'busy') return;
    if (left.length) {
      setTried(true);
      summary.current?.focus();
      return;
    }
    const problem = reasonProblem(reason, t);
    if (problem) {
      setError(problem);
      return;
    }
    setState('busy');
    try {
      await onPublish(reason.trim());
      setState('idle');
    } catch {
      setState('failed');
    }
  };
  return (
    <div className="stack first-publish">
      <div className="stack-sm">
        <BackLink label={t('edition.back')} href={backHref} />
        <Heading level={1} data-size="md">
          {title}
        </Heading>
        <Paragraph>{intro}</Paragraph>
      </div>
      {left.length ? (
        <ErrorSummary ref={summary} data-size="sm">
          <ErrorSummary.Heading>{t('publish.leftHeading')}</ErrorSummary.Heading>
          <ErrorSummary.List>
            {left.map((item) => (
              <ErrorSummary.Item key={item.key}>
                <ErrorSummary.Link href={item.href ?? backHref} onClick={(e) => jump(e, item)}>
                  {item.text}
                </ErrorSummary.Link>
              </ErrorSummary.Item>
            ))}
          </ErrorSummary.List>
        </ErrorSummary>
      ) : null}
      <Alert data-color="info" data-size="sm">
        <Heading level={2} data-size="2xs">
          {t('publish.testsetHeading')}
        </Heading>
        <Paragraph data-size="sm">{t('publish.testsetFirst')}</Paragraph>
      </Alert>
      {problems}
      <Divider />
      <section className="stack-sm" aria-labelledby={`${ids.reason}-edition`}>
        <Heading level={2} data-size="xs" id={`${ids.reason}-edition`}>
          {t('publish.firstVersion', { next: 1 })}
        </Heading>
        <Table data-size="sm" data-color="neutral" border zebra>
          <caption className="visually-hidden">{t('publish.firstVersion', { next: 1 })}</caption>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell scope="col">{t('publish.colWhat')}</Table.HeaderCell>
              <Table.HeaderCell scope="col">
                {t('publish.colVersion', { next: 1 })}
              </Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {facts.map((fact) => (
              <Table.Row key={fact.label}>
                <Table.HeaderCell scope="row">{fact.label}</Table.HeaderCell>
                <Table.Cell>{fact.value}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </section>
      <Divider />
      <section
        id={parts.risk}
        tabIndex={-1}
        className="stack-sm first-publish-part"
        aria-labelledby={ids.risk}
      >
        <div className="stack-xs">
          <span className="tag-row">
            <Heading level={2} data-size="xs" id={ids.risk}>
              {t('setupList.areaRisk')}
            </Heading>
            <ConfirmedTag confirmed={riskConfirmed} />
          </span>
          <Paragraph data-size="sm" className="meta">
            {riskName}
          </Paragraph>
          <Paragraph>{t('setupList.helpRisk')}</Paragraph>
        </div>
        {risk}
      </section>
      <Divider />
      <section
        id={parts.guards}
        tabIndex={-1}
        className="stack-sm first-publish-part"
        aria-labelledby={ids.guards}
      >
        <div className="stack-xs">
          <Heading level={2} data-size="xs" id={ids.guards}>
            {t('setupList.areaGuards')}
          </Heading>
          <Paragraph>{t('setupList.helpGuards')}</Paragraph>
        </div>
        {guards}
      </section>
      <Divider />
      <Field className="reason-field">
        <Label htmlFor={ids.reason}>{t('publish.reasonLabel')}</Label>
        <Field.Description>{t('publish.reasonHelp')}</Field.Description>
        <Textarea
          id={ids.reason}
          rows={2}
          value={reason}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setReason(e.target.value);
            setError('');
          }}
        />
        {error ? <ValidationMessage>{error}</ValidationMessage> : null}
      </Field>
      <div aria-live="polite">
        {tried && left.length ? (
          <Alert data-color="danger" data-size="sm">
            {t('publish.cannotYet')}
          </Alert>
        ) : state === 'failed' ? (
          <Alert data-color="danger" data-size="sm">
            {t('publish.failed')}
          </Alert>
        ) : null}
      </div>
      <div className="actions">
        {canPublish ? (
          <Button variant="primary" onClick={() => void publish()}>
            {t('publish.publish')}
          </Button>
        ) : (
          <Button variant="primary" aria-disabled title={t('edition.ownersOnly')}>
            {t('publish.publish')}
          </Button>
        )}
        <Button asChild variant="secondary">
          <a href={backHref}>{t('common.cancel')}</a>
        </Button>
        <ApiCallLink call={apiCall} />
      </div>
    </div>
  );
};
