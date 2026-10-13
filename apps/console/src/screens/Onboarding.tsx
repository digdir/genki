import {
  Button,
  Details,
  DetailsContent,
  DetailsSummary,
  Dialog,
  Heading,
  Paragraph,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, type ApiClient, type OrganizationLookup } from '../api';
import { useAsync } from '../hooks';
import { useT, type PlainKey, type T } from '../i18n';
import { EmptyState, ErrorState, Loading } from '../states';
import type { AccessRequest, Tenant, ValidationProblem } from '../types';
import { Flash, formatWhen, isMissing, NotDecided, PageHeader, useFlash } from '../ui';
import { formatOrgNumber } from './Tenants';
import { minimumReasonLength, reasonProblem } from '../reason';

const weights = [3, 2, 7, 6, 5, 4, 3, 2];

export const validOrgNumber = (value: string) => {
  if (!/^\d{9}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const sum = weights.reduce((acc, w, i) => acc + w * (digits[i] ?? 0), 0);
  const rest = sum % 11;
  const control = rest === 0 ? 0 : 11 - rest;
  return control !== 10 && control === digits[8];
};

const failure = (error: unknown, t: T) => {
  if (error instanceof ApiError) {
    const problem = error.problem as ValidationProblem | undefined;
    if (problem?.errors?.length) return problem.errors.map((e) => e.message).join('. ');
    if (error.status === 403) return t('onboarding.accessDenied');
  }
  return t('onboarding.somethingWrong');
};

const orgnrError = (digits: string, tenants: Tenant[], t: T) => {
  if (!/^\d{9}$/.test(digits)) return t('onboarding.orgnrDigits');
  if (!validOrgNumber(digits)) return t('onboarding.orgnrControl');
  if (tenants.some((x) => x.orgNumber === digits)) return t('onboarding.orgnrExists');
  return undefined;
};

export const RegisterTenant = ({
  api,
  tenants,
  onDone,
}: {
  api: ApiClient;
  tenants: Tenant[];
  onDone: (name: string) => void;
}) => {
  const t = useT();
  const [org, setOrg] = useState('');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();
  const digits = org.replace(/\s/g, '');
  const errors: Record<string, string> = {};
  const orgError = orgnrError(digits, tenants, t);
  if (orgError) errors.orgnr = orgError;
  if (!name.trim()) errors.navn = t('onboarding.nameMissing');
  const reasonError = reasonProblem(t, reason);
  if (reasonError) errors.begrunnelse = reasonError;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setFailed(undefined);
    try {
      await api.registerTenant(digits, name.trim(), reason.trim());
      onDone(name.trim());
      setOrg('');
      setName('');
      setReason('');
      setTried(false);
    } catch (e) {
      setFailed(failure(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card stack form-card"
      onSubmit={(e) => void submit(e)}
      aria-labelledby="registrer-h"
      noValidate
    >
      <div>
        <Heading level={2} data-size="xs" id="registrer-h">
          {t('onboarding.registerTitle')}
        </Heading>
        <Paragraph data-size="sm">{t('onboarding.registerIntro')}</Paragraph>
      </div>
      {failed ? (
        <Paragraph role="alert" className="row-error">
          {failed}
        </Paragraph>
      ) : null}
      <Textfield
        id="reg-orgnr"
        label={t('onboarding.orgnr')}
        inputMode="numeric"
        value={org}
        onChange={(e) => setOrg(e.target.value)}
        error={tried ? errors.orgnr : undefined}
      />
      <Textfield
        id="reg-navn"
        label={t('onboarding.nameFull')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={tried ? errors.navn : undefined}
      />
      <Textfield
        id="reg-begrunnelse"
        label={t('onboarding.reason')}
        description={t('onboarding.reasonSaved')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={tried ? errors.begrunnelse : undefined}
      />
      <div>
        <Button type="submit" loading={busy}>
          {t('onboarding.register')}
        </Button>
      </div>
    </form>
  );
};

const lateAfterDays = 5;
const dayMs = 86_400_000;

const stepNames: PlainKey[] = [
  'onboarding.stepRegistered',
  'onboarding.stepAltinn',
  'onboarding.stepScopes',
  'onboarding.stepLogin',
  'onboarding.stepService',
];

interface FollowUp {
  org: string;
  name: string;
  contact?: string | undefined;
  registeredBy?: string | undefined;
  registeredAt?: string | undefined;
  services: number;
  manual?: boolean;
}

type StepState = 'done' | 'waiting' | 'late' | 'later';

const stateTag: Record<StepState, [PlainKey, 'success' | 'info' | 'warning' | 'neutral']> = {
  done: ['onboarding.stateDone', 'success'],
  waiting: ['onboarding.stateWaiting', 'info'],
  late: ['onboarding.stateLate', 'warning'],
  later: ['onboarding.stateLater', 'neutral'],
};

const personOf = (actor: string) => actor.replace(/^operator:(entra:)?/, '');

export const followUps = (requests: AccessRequest[], tenants: Tenant[]): FollowUp[] => {
  const servicesOf = (org: string) => tenants.find((t) => t.orgNumber === org)?.services ?? 0;
  const asked = new Set(requests.map((r) => r.org));
  const approved = requests
    .filter((r) => r.status === 'approved')
    .map((r) => ({
      org: r.org,
      name: tenants.find((t) => t.orgNumber === r.org)?.name ?? r.orgName ?? r.org,
      contact: r.contactName ?? r.requestedBy,
      ...(r.decision ? { registeredBy: personOf(r.decision.by) } : {}),
      registeredAt: r.decision?.at,
      services: servicesOf(r.org),
    }));
  const manual = tenants
    .filter((t) => t.status === 'onboarding' && !asked.has(t.orgNumber))
    .map((t) => ({
      org: t.orgNumber,
      name: t.name,
      manual: true,
      services: t.services,
    }));
  return [...approved, ...manual];
};

const daysSince = (iso: string | undefined, now: number) =>
  iso ? Math.floor((now - new Date(iso).getTime()) / dayMs) : 0;

const Card = ({
  item,
  reminded,
  onRemind,
}: {
  item: FollowUp;
  reminded: boolean;
  onRemind: () => Promise<void>;
}) => {
  const t = useT();
  const f = useFormat();
  const [busy, setBusy] = useState(false);
  const live = item.services > 0;
  const waited = daysSince(item.registeredAt, Date.now());
  const late = !live && waited > lateAfterDays;
  const next = live ? -1 : 1;
  const states: StepState[] = stepNames.map((_, i) =>
    i === 0 || live ? 'done' : i === next ? (late ? 'late' : 'waiting') : 'later',
  );
  const done = states.filter((s) => s === 'done').length;
  const [tag, color] = live
    ? ([t('onboarding.tagLive'), 'success'] as const)
    : late
      ? ([t('onboarding.tagFollowUp'), 'warning'] as const)
      : ([t('onboarding.tagStep', { step: done + 1, total: stepNames.length }), 'info'] as const);
  const registeredBy = () => {
    if (item.manual) return t('onboarding.registeredByDigdir');
    if (item.registeredBy === undefined) return t('onboarding.digdir');
    return item.registeredBy.includes(',')
      ? item.registeredBy
      : t('onboarding.byDigdir', { who: item.registeredBy });
  };
  const meta = (i: number) => {
    if (i === 0)
      return [registeredBy(), item.registeredAt ? formatWhen(item.registeredAt, f, t) : '']
        .filter(Boolean)
        .join(' · ');
    if (states[i] === 'done')
      return i === stepNames.length - 1
        ? t('onboarding.servicesPublished', { count: item.services })
        : t('onboarding.timeNotRecorded');
    if (states[i] === 'late')
      return t(reminded ? 'onboarding.noProgressReminded' : 'onboarding.noProgress', {
        days: waited,
      });
    if (i === 2 && states[i] === 'waiting') return t('onboarding.scopesNote');
    return '';
  };
  const id = `onb-${item.org}`;
  return (
    <article className="card onboarding-card" aria-labelledby={id}>
      <div className="card-head">
        <Heading level={2} data-size="xs" id={id}>
          {item.name}
        </Heading>
        <Tag data-size="sm" data-color={color}>
          {tag}
        </Tag>
      </div>
      <span className="meta">
        {item.contact
          ? t('onboarding.orgNoContact', {
              number: formatOrgNumber(item.org),
              contact: item.contact,
            })
          : t('onboarding.orgNo', { number: formatOrgNumber(item.org) })}
      </span>
      <ol className="steps-list">
        {stepNames.map((labelKey, i) => {
          const state = states[i] ?? 'later';
          const text = meta(i);
          return (
            <li key={labelKey} className={state === 'done' ? 'done' : undefined}>
              <span className="step-mark" aria-hidden="true">
                {state === 'done' ? '✓' : String(i + 1)}
              </span>
              <span className="two-line">
                <span className="name-line">
                  <span className="step-label">{t(labelKey)}</span>
                  <Tag data-size="sm" data-color={stateTag[state][1]}>
                    {t(stateTag[state][0])}
                  </Tag>
                  {i === 2 ? <NotDecided /> : null}
                </span>
                {text ? <span className="meta">{text}</span> : null}
                {state === 'late' && !reminded ? (
                  <Button
                    variant="secondary"
                    data-size="sm"
                    className="align-start"
                    loading={busy}
                    onClick={() => {
                      setBusy(true);
                      void onRemind().finally(() => setBusy(false));
                    }}
                  >
                    {t('onboarding.sendReminder')}
                  </Button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </article>
  );
};

const RegisterDialog = ({
  api,
  open,
  tenants,
  onClose,
  onDone,
}: {
  api: ApiClient;
  open: boolean;
  tenants: Tenant[];
  onClose: () => void;
  onDone: (name: string) => void;
}) => {
  const t = useT();
  const [org, setOrg] = useState('');
  const [name, setName] = useState('');
  const [found, setFound] = useState<OrganizationLookup['source'] | undefined>();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();
  const digits = org.replace(/\s/g, '');

  useEffect(() => {
    if (!open) return;
    setOrg('');
    setName('');
    setReason('');
    setTried(false);
    setFailed(undefined);
  }, [open]);

  useEffect(() => {
    if (!validOrgNumber(digits)) {
      setFound(undefined);
      return;
    }
    const controller = new AbortController();
    api.lookupOrganization(digits, controller.signal).then(
      (o) => {
        setName(o.name);
        setFound(o.source);
      },
      () => setFound(undefined),
    );
    return () => controller.abort();
  }, [api, digits]);

  const errors: Record<string, string> = {};
  const orgError = orgnrError(digits, tenants, t);
  if (orgError) errors.orgnr = orgError;
  if (!name.trim()) errors.navn = t('onboarding.nameMissing');
  if (reason.trim().length < minimumReasonLength)
    errors.begrunnelse = t('onboarding.reasonShort', {
      min: minimumReasonLength,
      n: reason.trim().length,
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setFailed(undefined);
    try {
      await api.registerTenant(digits, name.trim(), reason.trim());
      onDone(name.trim());
      onClose();
    } catch (e) {
      setFailed(failure(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      closeButton={t('common.close')}
      aria-labelledby="registrer-h"
      className="reason-dialog"
    >
      {open ? (
        <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
          <Heading level={2} data-size="xs" id="registrer-h">
            {t('onboarding.registerTitle')}
          </Heading>
          <Paragraph>{t('onboarding.dialogIntro')}</Paragraph>
          {failed ? (
            <Paragraph role="alert" className="row-error">
              {failed}
            </Paragraph>
          ) : null}
          <Textfield
            className="narrow"
            id="reg-orgnr"
            label={t('onboarding.orgnr')}
            inputMode="numeric"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            error={tried ? errors.orgnr : undefined}
            description={
              found === 'enhetsregisteret' ? t('onboarding.lookupSource', { name }) : undefined
            }
          />
          <Textfield
            id="reg-navn"
            label={t('onboarding.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={tried ? errors.navn : undefined}
          />
          <Textfield
            id="reg-begrunnelse"
            label={t('onboarding.reason')}
            description={t('onboarding.reasonHint')}
            multiline
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={tried ? errors.begrunnelse : undefined}
          />
          <Details>
            <DetailsSummary>{t('common.showApiCall')}</DetailsSummary>
            <DetailsContent>
              <code className="label-strong">POST /operator/tenants</code>
              <pre className="code" tabIndex={0} aria-label={t('onboarding.callContent')}>
                {JSON.stringify({ orgNumber: digits, name: name.trim() }, null, 2)}
              </pre>
              <Paragraph data-size="sm">{t('onboarding.reasonHeader')}</Paragraph>
            </DetailsContent>
          </Details>
          <div className="actions-row">
            <Button type="submit" loading={busy}>
              {t('onboarding.register')}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
};

export const Onboarding = ({ api }: { api: ApiClient; live?: boolean }) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, retry] = useAsync(
    async (signal) => {
      const tenants = await api.listTenants(signal);
      try {
        return { tenants, requests: await api.accessRequests(signal), live: true };
      } catch (error) {
        if (!isMissing(error)) throw error;
        return { tenants, requests: [], live: false };
      }
    },
    [api],
  );
  const [registering, setRegistering] = useState(false);
  const [reminded, setReminded] = useState<Set<string>>(() => new Set());
  const flash = useFlash();

  const remind = (item: FollowUp) => async () => {
    try {
      await api.remindOnboarding(item.org);
      setReminded((all) => new Set(all).add(item.org));
      flash.show(
        tRef.current('onboarding.reminderSent', {
          contact: item.contact ?? tRef.current('onboarding.contactFallback'),
          name: item.name,
        }),
      );
    } catch {
      flash.show(tRef.current('onboarding.reminderFailed'), 'danger');
    }
  };

  const ready = state.status === 'ready' ? state.data : undefined;
  const list = ready ? followUps(ready.requests, ready.tenants) : [];

  return (
    <>
      <div className="page-top">
        <PageHeader
          eyebrow={t('onboarding.eyebrow')}
          title={t('onboarding.title')}
          intro={
            ready && !ready.live
              ? t('onboarding.introRegisterOnly')
              : t.rich('onboarding.intro', {
                  link: (c) => <a href="#/queue?tab=access">{c}</a>,
                })
          }
        />
        {ready?.live ? (
          <Button variant="secondary" onClick={() => setRegistering(true)}>
            {t('onboarding.registerTitle')}
          </Button>
        ) : null}
      </div>
      <Flash message={flash.message} />
      {state.status === 'loading' ? (
        <Loading label={t('onboarding.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : !state.data.live ? (
        <RegisterTenant
          api={api}
          tenants={state.data.tenants}
          onDone={(name) => {
            flash.show(tRef.current('onboarding.registeredFlash', { name }));
            retry();
          }}
        />
      ) : list.length === 0 ? (
        <EmptyState title={t('onboarding.emptyTitle')}>
          <Paragraph>
            {t.rich('onboarding.emptyText', {
              link: (c) => <a href="#/queue?tab=access">{c}</a>,
            })}
          </Paragraph>
        </EmptyState>
      ) : (
        <div className="card-grid wide">
          {list.map((item) => (
            <Card
              key={item.org}
              item={item}
              reminded={reminded.has(item.org)}
              onRemind={remind(item)}
            />
          ))}
        </div>
      )}
      {ready?.live ? (
        <RegisterDialog
          api={api}
          open={registering}
          tenants={ready.tenants}
          onClose={() => setRegistering(false)}
          onDone={(name) => {
            flash.show(tRef.current('onboarding.registeredLogged', { name }));
            retry();
          }}
        />
      ) : null}
    </>
  );
};
