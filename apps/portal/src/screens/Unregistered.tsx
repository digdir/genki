import {
  Alert,
  Button,
  Checkbox,
  ErrorSummary,
  Field,
  Fieldset,
  Heading,
  Label,
  Link,
  Paragraph,
  Spinner,
  Tag,
  Textarea,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { type ComponentRef, type ReactNode, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../api';
import {
  requestsPath,
  type AccessRequest,
  type AccessRequestInput,
  type OrganisationAccessStatus,
} from '../api/onboarding';
import { ApiCallLink } from '../components/ApiCall';
import { useFormat } from '@genai/i18n/react';
import { useAsync } from '../hooks';
import { translator, useT, type T } from '../i18n';
import type { Organisation } from '../types';
import './access.css';

export const tenantNotRegistered = 'urn:genai:problem:tenant-not-registered';

const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const purposeMinimum = 20;
const nbT = translator('nb');
const altinn = 'https://www.altinn.no';

interface Props {
  api: ApiClient;
  organisation: Organisation;
  contactName: string;
  registeredElsewhere?: string[];
  onSwitch?: () => void;
  onLogout?: () => void;
}

const NotDecidedTag = () => {
  const t = useT();
  return (
    <Tag data-color="warning" data-size="sm">
      {t('components.notDecided')}
    </Tag>
  );
};

const StatusAlert = ({
  color,
  title,
  children,
}: {
  color: 'info' | 'success' | 'danger' | 'warning';
  title: string;
  children: ReactNode;
}) => (
  <Alert data-color={color}>
    <Heading level={2} data-size="2xs" className="request-alert-title">
      {title}
    </Heading>
    {children}
  </Alert>
);

const OwnRequest = ({
  request,
  orgName,
  onLogout,
  onNew,
}: {
  request: AccessRequest;
  orgName: string;
  onLogout?: (() => void) | undefined;
  onNew: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const dayOf = (iso: string) => f.date(iso);
  const decidedAt = request.decision?.at ?? request.decidedAt ?? request.requestedAt;
  const reason = request.decision?.reason ?? request.reason;
  if (request.status === 'approved')
    return (
      <StatusAlert color="success" title={t('unregistered.approvedTitle')}>
        <Paragraph className="alert-text">
          {t('unregistered.approvedText', { date: dayOf(decidedAt), org: orgName })}
        </Paragraph>
        {onLogout ? (
          <Button variant="primary" onClick={onLogout}>
            {t('unregistered.loginAgain')}
          </Button>
        ) : null}
      </StatusAlert>
    );
  if (request.status === 'rejected')
    return (
      <StatusAlert color="danger" title={t('unregistered.rejectedTitle')}>
        <Paragraph className="alert-text">
          {t('unregistered.rejectedText', { date: dayOf(decidedAt) })}
        </Paragraph>
        {reason ? (
          <Paragraph className="alert-text">
            <strong>{t('unregistered.rejectedReason')}</strong> {reason}
          </Paragraph>
        ) : null}
        <Button variant="secondary" onClick={onNew}>
          {t('unregistered.sendNew')}
        </Button>
      </StatusAlert>
    );
  return (
    <StatusAlert color="info" title={t('unregistered.waitingTitle')}>
      <Paragraph className="alert-text">
        {t('unregistered.waitingText', { date: dayOf(request.requestedAt) })}
      </Paragraph>
      <Paragraph className="request-inline">
        {t('unregistered.expectedTime')} <NotDecidedTag />
      </Paragraph>
    </StatusAlert>
  );
};

type FieldKey = 'orgName' | 'contactName' | 'contactEmail' | 'purpose' | 'acceptedTerms';

const anchors: Record<FieldKey, string> = {
  orgName: '#f-navn',
  contactName: '#f-kontakt',
  contactEmail: '#f-epost',
  purpose: '#f-bruk',
  acceptedTerms: '#f-vilkar',
};

export const requestProblems = (
  form: {
    orgName: string;
    contactName: string;
    contactEmail: string;
    purpose: string;
    acceptedTerms: boolean;
  },
  t: T = nbT,
): Partial<Record<FieldKey, string>> => {
  const mail = form.contactEmail.trim();
  return {
    ...(form.orgName.trim() ? {} : { orgName: t('unregistered.problemOrgName') }),
    ...(form.contactName.trim() ? {} : { contactName: t('unregistered.problemContactName') }),
    ...(email.test(mail)
      ? {}
      : {
          contactEmail: mail
            ? t('unregistered.problemEmailWrong')
            : t('unregistered.problemEmailMissing'),
        }),
    ...(form.purpose.trim().length >= purposeMinimum
      ? {}
      : {
          purpose: t('unregistered.problemPurpose', { min: purposeMinimum }),
        }),
    ...(form.acceptedTerms
      ? {}
      : {
          acceptedTerms: t('unregistered.problemTerms'),
        }),
  };
};

const RequestForm = ({
  api,
  organisation,
  contactName,
  others,
  onSwitch,
  onSent,
}: {
  api: ApiClient;
  organisation: Organisation;
  contactName: string;
  others: string[];
  onSwitch?: (() => void) | undefined;
  onSent: () => void;
}) => {
  const t = useT();
  const namedByLogin = Boolean(organisation.name) && organisation.name !== organisation.orgNumber;
  const [form, setForm] = useState({
    orgName: organisation.name,
    contactName,
    contactEmail: '',
    purpose: '',
    acceptedTerms: false,
  });
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const summary = useRef<ComponentRef<typeof ErrorSummary>>(null);
  const problems = requestProblems(form, t);
  const shown = tried ? problems : {};
  const listed = Object.entries(shown) as [FieldKey, string][];
  const input: AccessRequestInput = {
    org: organisation.orgNumber,
    orgName: form.orgName.trim(),
    contactName: form.contactName.trim(),
    contactEmail: form.contactEmail.trim(),
    purpose: form.purpose.trim(),
    acceptedTerms: true,
  };

  const send = async () => {
    if (sending) return;
    setTried(true);
    if (Object.keys(problems).length > 0) {
      setTimeout(() => summary.current?.focus(), 0);
      return;
    }
    setSending(true);
    setFailed(false);
    try {
      await api.onboarding.requestAccess(input);
      onSent();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 409 || error.status === 403)) onSent();
      else setFailed(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {failed ? (
        <StatusAlert color="danger" title={t('unregistered.notSentTitle')}>
          <Paragraph className="alert-text">{t('unregistered.notSentText')}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={() => void send()}>
            {t('common.tryAgain')}
          </Button>
        </StatusAlert>
      ) : null}
      {others.length > 0 && onSwitch ? (
        <StatusAlert color="info" title={t('unregistered.manyTitle')}>
          <Paragraph className="alert-text">
            {t('unregistered.manyText', { org: organisation.name, others: others.join(', ') })}
          </Paragraph>
          <Button variant="secondary" data-size="sm" onClick={onSwitch}>
            {t('unregistered.switchOrg')}
          </Button>
        </StatusAlert>
      ) : null}
      <form
        noValidate
        aria-labelledby="request-h"
        className="request-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Heading level={2} data-size="sm" id="request-h">
          {t('unregistered.requestHeading')}
        </Heading>
        {listed.length > 0 ? (
          <ErrorSummary ref={summary} tabIndex={-1}>
            <ErrorSummary.Heading>{t('unregistered.fixThis')}</ErrorSummary.Heading>
            <ErrorSummary.List>
              {listed.map(([key, text]) => (
                <ErrorSummary.Item key={key}>
                  <ErrorSummary.Link href={anchors[key]}>{text}</ErrorSummary.Link>
                </ErrorSummary.Item>
              ))}
            </ErrorSummary.List>
          </ErrorSummary>
        ) : null}
        <Textfield
          id="f-orgnr"
          className="request-narrow"
          label={t('unregistered.orgNumber')}
          description={t('unregistered.orgNumberHelp')}
          value={organisation.orgNumber}
          readOnly
        />
        <Textfield
          id="f-navn"
          className="request-wide"
          label={t('unregistered.orgName')}
          {...(namedByLogin
            ? { description: t('unregistered.orgNumberHelp'), readOnly: true }
            : { onChange: (e) => setForm({ ...form, orgName: e.target.value }) })}
          value={form.orgName}
          error={shown.orgName}
        />
        <Textfield
          id="f-kontakt"
          className="request-wide"
          label={t('unregistered.contact')}
          autoComplete="name"
          value={form.contactName}
          error={shown.contactName}
          onChange={(e) => setForm({ ...form, contactName: e.target.value })}
        />
        <Textfield
          id="f-epost"
          className="request-wide"
          label={t('unregistered.email')}
          type="email"
          autoComplete="email"
          value={form.contactEmail}
          error={shown.contactEmail}
          onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
        />
        <Field>
          <Label htmlFor="f-bruk">{t('unregistered.purposeLabel')}</Label>
          <Paragraph data-size="sm" className="subtle" id="f-bruk-h">
            {t('unregistered.purposeHelp')}
          </Paragraph>
          <Textarea
            id="f-bruk"
            rows={4}
            value={form.purpose}
            aria-invalid={!!shown.purpose}
            aria-describedby="f-bruk-h"
            onChange={(e) => setForm({ ...form, purpose: e.target.value })}
          />
          {shown.purpose ? <ValidationMessage>{shown.purpose}</ValidationMessage> : null}
        </Field>
        <Fieldset>
          <Fieldset.Legend className="request-legend">
            {t('unregistered.termsLegend')} <NotDecidedTag />
          </Fieldset.Legend>
          <Checkbox
            id="f-vilkar"
            label={t('unregistered.termsCheck')}
            checked={form.acceptedTerms}
            error={shown.acceptedTerms}
            onChange={() => setForm({ ...form, acceptedTerms: !form.acceptedTerms })}
          />
        </Fieldset>
        <ApiCallLink
          call={{
            action: t('unregistered.apiAction'),
            method: 'POST',
            path: requestsPath,
            body: { ...input, acceptedTerms: form.acceptedTerms },
            needsReason: false,
            right: t('unregistered.apiRight'),
          }}
        />
        <div className="actions">
          <Button variant="primary" type="submit" aria-disabled={sending || undefined}>
            {sending ? t('unregistered.sending') : t('unregistered.send')}
          </Button>
          {sending ? <Spinner aria-hidden data-size="sm" /> : null}
        </div>
      </form>
    </>
  );
};

const statusOf = async (api: ApiClient, org: string, signal: AbortSignal) => {
  const [requests, status] = await Promise.all([
    api.onboarding.myRequests(signal),
    api.onboarding
      .organisationStatus(org, signal)
      .catch((): OrganisationAccessStatus | undefined => undefined),
  ]);
  const latest = [...requests]
    .filter((r) => r.org === org)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  return { latest, status };
};

export const Unregistered = ({
  api,
  organisation,
  contactName,
  registeredElsewhere = [],
  onSwitch,
  onLogout,
}: Props) => {
  const t = useT();
  const f = useFormat();
  const dayOf = (iso: string) => f.date(iso);
  const [tick, setTick] = useState(0);
  const [writing, setWriting] = useState(false);
  const [state] = useAsync(
    (signal) => statusOf(api, organisation.orgNumber, signal),
    [api, organisation.orgNumber, tick],
  );
  const ready = state.status === 'ready' ? state.data : undefined;
  const own = ready?.latest && !writing ? ready.latest : undefined;
  const otherPending =
    !own && ready?.status?.pendingRequest && !ready.status.pendingRequest.mine
      ? ready.status.pendingRequest
      : undefined;
  const mayNotAsk = !own && !otherPending && ready?.status?.mayRequest === false;

  return (
    <div className="no-access access-request">
      <div className="stack-sm">
        <Heading level={1} data-size="lg">
          {t('unregistered.title')}
        </Heading>
        <Paragraph className="no-access-intro">
          {t('unregistered.intro', { org: organisation.name })}
        </Paragraph>
      </div>
      <div aria-live="polite" className="access-request-status">
        {state.status === 'loading' ? (
          <Spinner aria-label={t('unregistered.loadingRequests')} />
        ) : null}
        {own ? (
          <OwnRequest
            request={own}
            orgName={organisation.name}
            onLogout={onLogout}
            onNew={() => setWriting(true)}
          />
        ) : null}
        {otherPending ? (
          <StatusAlert color="info" title={t('unregistered.sentTitle')}>
            <Paragraph className="alert-text">
              {t('unregistered.sentText', {
                org: organisation.name,
                date: dayOf(otherPending.requestedAt),
              })}
            </Paragraph>
          </StatusAlert>
        ) : null}
        {mayNotAsk ? (
          <StatusAlert color="warning" title={t('unregistered.mayNotTitle')}>
            <Paragraph className="alert-text">
              {t('unregistered.mayNotText', { org: organisation.name })}
            </Paragraph>
            <Link href={altinn} target="_blank" rel="noopener">
              {t('unregistered.seeWho')}
            </Link>
          </StatusAlert>
        ) : null}
      </div>
      {state.status !== 'loading' && !own && !otherPending && !mayNotAsk ? (
        <RequestForm
          api={api}
          organisation={organisation}
          contactName={contactName}
          others={registeredElsewhere}
          onSwitch={onSwitch}
          onSent={() => {
            setWriting(false);
            setTick((n) => n + 1);
          }}
        />
      ) : null}
      <section aria-labelledby="while-h" className="stack-xs">
        <Heading level={2} data-size="xs" id="while-h">
          {t('unregistered.whileWaiting')}
        </Heading>
        <Paragraph>{t('unregistered.readWithout')}</Paragraph>
        <ul className="access-request-links">
          <li>
            <Link href="#/api-reference">{t('unregistered.apiReference')}</Link>
          </li>
          <li>
            <Link href="#/shared-services">{t('unregistered.sharedServices')}</Link>
          </li>
          <li>
            <Link href="#/data-handling">{t('unregistered.howData')}</Link>
          </li>
        </ul>
      </section>
      <Paragraph>
        {t.rich('unregistered.questions', {
          link: (c) => <Link href="#/contact">{c}</Link>,
        })}
      </Paragraph>
    </div>
  );
};
