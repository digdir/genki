import {
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Radio,
  Select,
  Table,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import type { BlockDetail, BlockReview, BlockSharing } from '@genai/contracts/blocks';
import { useLocale } from '@genai/i18n/react';
import { useId, useState, type ReactNode } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { BusyButton } from '../../components/BusyButton';
import { reasonProblem } from '../../components/ReasonField';
import { navigate, useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import type { ScreenProps } from '../../screen';
import { useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { asBlockDraft } from './definitions';
import { dayOf, designPath, titleOf, versionName } from './naming';
import { BlockTags, Crumbs, Panel, Toast } from './parts';
import { Problems } from './Problems';

const reviewKey: Record<BlockReview['status'], PlainKey> = {
  pending: 'design.inReview',
  approved: 'design.approved',
  declined: 'design.declined',
};

const useBusy = () => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const run = async (work: () => Promise<void>) => {
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
  return { busy, error, run };
};

/** «Utgaver og deling»: where each service has the block, taking an edition in use, sharing, the log, deleting. */
export const Versions = ({
  api,
  tenant,
  tenantName,
  publisher,
  id,
}: ScreenProps & { publisher: string; id: string }) => {
  const t = useT();
  const { locale } = useLocale();
  const [state, retry] = useAsync(
    (signal) => api.design.detail(tenant, publisher, id, undefined, signal),
    [api, tenant, publisher, id],
    { keepPreviousFor: `${tenant}/${publisher}/${id}` },
  );
  if (state.status !== 'ready')
    return (
      <div className="design-page">
        <Crumbs items={[{ label: t('design.title'), href: '#/design' }]} />
        {state.status === 'loading' ? (
          <Loading label={t('design.loading')} shape="detail" onRetry={retry} />
        ) : (
          <ErrorState error={state.error} onRetry={retry} />
        )}
      </div>
    );
  const detail = state.data;
  const name = titleOf(detail.title, locale);
  const latest = detail.latest.version;
  return (
    <div className="design-page">
      <div className="stack-xs">
        <Crumbs
          items={[
            { label: t('design.title'), href: '#/design' },
            { label: name, href: `#${designPath(detail.publisher, detail.id)}` },
            { label: t('design.seeVersions') },
          ]}
        />
        <div className="design-head">
          <Heading level={1} data-size="lg">
            {t('design.versionsTitle', { name, version: versionName(t, latest) })}
          </Heading>
          <BlockTags detail={detail} brief />
        </div>
      </div>
      <div className="design-grid2">
        <div className="stack">
          <Environments detail={detail} />
          <Promote api={api} tenant={tenant} detail={detail} onDone={retry} />
          <Sharing
            api={api}
            tenant={tenant}
            tenantName={tenantName}
            detail={detail}
            onDone={retry}
          />
          <Archive api={api} tenant={tenant} detail={detail} />
        </div>
        <div className="stack">
          <Receives api={api} tenant={tenant} detail={detail} onDone={retry} />
          <Audit detail={detail} />
        </div>
      </div>
    </div>
  );
};

const Environments = ({ detail }: { detail: BlockDetail }) => {
  const t = useT();
  const { locale } = useLocale();
  const newest = detail.editions.at(-1);
  const prod = detail.usedIn.flatMap((u) => (u.inUse === undefined ? [] : [u.inUse]));
  const top = prod.length ? Math.max(...prod) : undefined;
  return (
    <div className="design-envs">
      <section className="design-env" aria-label={t('design.envTest')}>
        <div className="design-panel-head">
          <Heading level={2} data-size="2xs">
            {t('design.envTest')}
          </Heading>
          <Tag data-size="sm" data-color="success">
            {t('design.newest')}
          </Tag>
        </div>
        <p className="design-env-version">{versionName(t, detail.latest.version)}</p>
        {newest ? (
          <Paragraph data-size="sm" className="meta">
            {newest.publishedByName
              ? t('design.savedBy', {
                  date: dayOf(newest.publishedAt, locale),
                  name: newest.publishedByName,
                })
              : t('design.savedAt', { date: dayOf(newest.publishedAt, locale) })}
          </Paragraph>
        ) : null}
      </section>
      <section className="design-env" aria-label={t('design.envProd')}>
        <div className="design-panel-head">
          <Heading level={2} data-size="2xs">
            {t('design.envProd')}
          </Heading>
          <Tag data-size="sm" data-color="neutral">
            {t('design.pinnedTag')}
          </Tag>
        </div>
        <p className="design-env-version">{top === undefined ? '–' : versionName(t, top)}</p>
        <Paragraph data-size="sm" className="meta">
          {prod.length === 1
            ? t('design.prodInOne')
            : prod.length
              ? t('design.prodIn', { count: prod.length })
              : t('design.prodNone')}
        </Paragraph>
      </section>
    </div>
  );
};

const ReasonInput = ({
  value,
  onChange,
  tried,
  label,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  tried: boolean;
  label: string;
  hint?: string;
}) => {
  const t = useT();
  const problem = tried ? reasonProblem(value, t) : undefined;
  return (
    <Textfield
      multiline
      rows={2}
      label={label}
      {...(hint ? { description: hint } : {})}
      value={value}
      {...(problem ? { error: problem } : {})}
      onChange={(e) => onChange(e.target.value)}
    />
  );
};

const Promote = ({
  api,
  tenant,
  detail,
  onDone,
}: {
  api: ApiClient;
  tenant: string;
  detail: BlockDetail;
  onDone: () => void;
}) => {
  const t = useT();
  const selectId = useId();
  const manage = useRights().has('manage-services');
  const latest = detail.latest.version;
  const ready = detail.usedIn.filter((u) => u.test === latest && u.inUse !== latest);
  const [service, setService] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState<string | undefined>(undefined);
  const { busy, error, run } = useBusy();
  const chosen =
    ready.find((u) => u.service === service) ?? (ready.length === 1 ? ready[0] : undefined);
  if (!manage) return null;
  const promote = () => {
    setTried(true);
    if (!chosen || reasonProblem(reason, t)) return;
    void run(async () => {
      await api.environments.promote(tenant, chosen.service, 'prod', 'test', reason.trim());
      setDone(chosen.name);
      onDone();
    });
  };
  return (
    <Panel title={t('design.promoteTitle', { version: versionName(t, latest) })}>
      {ready.length === 0 && !done ? (
        <Paragraph data-size="sm" className="meta">
          {t('design.promoteNone', { version: versionName(t, latest) })}
        </Paragraph>
      ) : (
        <div className="stack-sm">
          {ready.length > 1 ? (
            <Field data-size="sm">
              <Label htmlFor={selectId}>{t('design.service')}</Label>
              <Select id={selectId} value={service} onChange={(e) => setService(e.target.value)}>
                <Select.Option value="" disabled>
                  {t('design.chooseService')}
                </Select.Option>
                {ready.map((u) => (
                  <Select.Option key={u.service} value={u.service}>
                    {u.name}
                  </Select.Option>
                ))}
              </Select>
            </Field>
          ) : null}
          {ready.length > 0 ? (
            <>
              <ReasonInput
                value={reason}
                onChange={setReason}
                tried={tried}
                label={t('design.reason')}
                hint={t('design.reasonHint')}
              />
              <div>
                <BusyButton
                  busy={busy}
                  busyLabel={t('design.saving')}
                  aria-disabled={!chosen || undefined}
                  onClick={promote}
                >
                  {t('design.promote')}
                </BusyButton>
              </div>
            </>
          ) : null}
          {done ? <Toast>{t('design.promoted', { service: done })}</Toast> : null}
        </div>
      )}
      {error ? <Problems error={error} /> : null}
    </Panel>
  );
};

const Sharing = ({
  api,
  tenant,
  tenantName,
  detail,
  onDone,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  detail: BlockDetail;
  onDone: () => void;
}) => {
  const t = useT();
  const { locale } = useLocale();
  const manage = useRights().has('manage-services');
  const own = detail.origin === 'own' && detail.tier !== 'built-in';
  const name = titleOf(detail.title, locale);
  const review = detail.review;
  const pending = review?.status === 'pending';
  const [choice, setChoice] = useState<BlockSharing>(pending ? 'everyone' : detail.sharing);
  const [why, setWhy] = useState('');
  const [tried, setTried] = useState(false);
  const { busy, error, run } = useBusy();
  const code = detail.tier === 'code';
  const toReview = code && choice === 'everyone' && detail.sharing !== 'everyone';
  const options: { value: BlockSharing; label: PlainKey; help: string }[] = [
    { value: 'private', label: 'design.sharingPrivate', help: t('design.sharingPrivateHelp') },
    {
      value: 'organisation',
      label: 'design.sharingOrganisation',
      help: t('design.sharingOrganisationHelp', { org: tenantName }),
    },
    { value: 'everyone', label: 'design.sharingEveryone', help: t('design.sharingEveryoneHelp') },
  ];
  const save = () =>
    run(async () => {
      const base = asBlockDraft(detail.edition.definition);
      const label = t(
        options.find((o) => o.value === choice)?.label ?? 'design.sharingOrganisation',
      );
      const files = await api.design.files(tenant, detail.id, detail.edition.version);
      await api.design.save(
        { ...base, spec: { ...base.spec, sharing: choice } } as unknown as Record<string, unknown>,
        files,
        t('design.sharingReason', { choice: label }),
      );
      onDone();
    });
  const send = () => {
    setTried(true);
    if (reasonProblem(why, t)) return;
    void run(async () => {
      await api.design.requestShare(tenant, detail.id, detail.latest.version, why.trim());
      onDone();
    });
  };
  const readOnly = !own || !manage;
  return (
    <Panel title={t('design.sharing')}>
      <fieldset className="design-radios" disabled={readOnly}>
        <legend className="visually-hidden">{t('design.sharing')}</legend>
        {options.map((o) => (
          <Radio
            key={o.value}
            name="design-sharing"
            value={o.value}
            label={t(o.label)}
            description={o.help}
            checked={choice === o.value}
            onChange={() => setChoice(o.value)}
          />
        ))}
      </fieldset>
      {detail.origin === 'built-in' ? (
        <Paragraph data-size="sm" className="meta">
          {t('design.sharingGenki', { name })}
        </Paragraph>
      ) : detail.origin === 'shared' ? (
        <Paragraph data-size="sm" className="meta">
          {t('design.sharingOther', { name, org: detail.publisherName })}
        </Paragraph>
      ) : null}
      {!readOnly ? (
        <div className="stack-sm">
          {toReview && !pending ? (
            <ReasonInput value={why} onChange={setWhy} tried={tried} label={t('design.whyShare')} />
          ) : null}
          <div className="design-actions">
            {toReview ? (
              <BusyButton
                data-size="sm"
                busy={busy}
                busyLabel={t('design.saving')}
                aria-disabled={pending || undefined}
                onClick={() => !pending && send()}
              >
                {t('design.sendToReview')}
              </BusyButton>
            ) : (
              <BusyButton
                data-size="sm"
                busy={busy}
                busyLabel={t('design.saving')}
                aria-disabled={choice === detail.sharing || undefined}
                onClick={() => choice !== detail.sharing && void save()}
              >
                {t('design.sharingSave')}
              </BusyButton>
            )}
            {code && review ? (
              <span role="status" className="design-review">
                <Tag
                  data-size="sm"
                  data-color={
                    review.status === 'approved'
                      ? 'success'
                      : review.status === 'declined'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {t(reviewKey[review.status])}
                </Tag>
                <span className="meta">
                  {t('design.sentAt', { date: dayOf(review.at, locale) })}
                </span>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {error ? <Problems error={error} /> : null}
    </Panel>
  );
};

const Receives = ({
  api,
  tenant,
  detail,
  onDone,
}: {
  api: ApiClient;
  tenant: string;
  detail: BlockDetail;
  onDone: () => void;
}) => {
  const t = useT();
  const { locale } = useLocale();
  const selectId = useId();
  const manage = useRights().has('manage-services');
  const latest = detail.latest.version;
  const name = titleOf(detail.title, locale);
  const [chosen, setChosen] = useState('');
  const [pinned, setPinned] = useState(false);
  const { busy, error, run } = useBusy();
  const [services] = useAsync(
    async (signal) => (manage ? (await api.services(tenant, signal)).data : []),
    [api, tenant, manage],
  );
  const others =
    services.status === 'ready'
      ? services.data.filter((s) => !detail.usedIn.some((u) => u.service === s.id))
      : [];
  const pin = (service: string) =>
    run(async () => {
      await api.design.pin(
        tenant,
        service,
        { publisher: detail.publisher, id: detail.id },
        { version: latest },
        t('design.pinReason', { name, version: versionName(t, latest) }),
      );
      setPinned(true);
      setChosen('');
      onDone();
    });
  const cell = (v: number | undefined): ReactNode =>
    v === undefined ? t('design.notInUse') : versionName(t, v);
  return (
    <Panel title={t('design.receives')}>
      {detail.usedIn.length ? (
        <div className="design-table">
          <Table data-size="sm">
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell scope="col">{t('design.colService')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('design.colTest')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('design.colProd')}</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {detail.usedIn.map((u) => {
                const test = u.draft ?? u.test;
                return (
                  <Table.Row key={u.service}>
                    <Table.Cell>
                      <a href={`#/services/${encodeURIComponent(u.service)}/interface`}>{u.name}</a>
                    </Table.Cell>
                    <Table.Cell>
                      {manage && test !== latest ? (
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-disabled={busy || undefined}
                          onClick={() => !busy && void pin(u.service)}
                        >
                          {t('design.putInTest', { version: versionName(t, latest) })}
                        </Button>
                      ) : (
                        cell(test)
                      )}
                    </Table.Cell>
                    <Table.Cell>{cell(u.inUse)}</Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>
      ) : (
        <Paragraph data-size="sm" className="meta">
          {t('design.usedNone')}
        </Paragraph>
      )}
      {manage && others.length ? (
        <div className="design-choose">
          <Field data-size="sm">
            <Label htmlFor={selectId}>{t('design.addService')}</Label>
            <Select id={selectId} value={chosen} onChange={(e) => setChosen(e.target.value)}>
              <Select.Option value="" disabled>
                {t('design.chooseService')}
              </Select.Option>
              {others.map((s) => (
                <Select.Option key={s.id} value={s.id}>
                  {s.name}
                </Select.Option>
              ))}
            </Select>
          </Field>
          <BusyButton
            data-size="sm"
            variant="secondary"
            busy={busy}
            busyLabel={t('design.saving')}
            aria-disabled={!chosen || undefined}
            onClick={() => chosen && void pin(chosen)}
          >
            {t('design.putInTest', { version: versionName(t, latest) })}
          </BusyButton>
        </div>
      ) : null}
      {pinned ? <Toast>{t('design.pinned')}</Toast> : null}
      {error ? <Problems error={error} /> : null}
    </Panel>
  );
};

const Audit = ({ detail }: { detail: BlockDetail }) => {
  const t = useT();
  const { locale } = useLocale();
  return (
    <Panel title={t('design.audit')}>
      <ul className="design-log">
        {detail.review ? (
          <li>
            <time dateTime={detail.review.at}>{dayOf(detail.review.at, locale)}</time>
            {t('design.auditReview', {
              status: t(reviewKey[detail.review.status]).toLocaleLowerCase(locale),
            })}
          </li>
        ) : null}
        {[...detail.editions].reverse().map((e) => (
          <li key={e.version}>
            <time dateTime={e.publishedAt}>{dayOf(e.publishedAt, locale)}</time>
            {t('design.auditSaved', {
              who: e.publishedByName ?? t('design.someone'),
              version: versionName(t, e.version),
              reason: e.reason,
            })}
          </li>
        ))}
      </ul>
    </Panel>
  );
};

const Archive = ({
  api,
  tenant,
  detail,
}: {
  api: ApiClient;
  tenant: string;
  detail: BlockDetail;
}) => {
  const t = useT();
  const manage = useRights().has('manage-services');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const { busy, error, run } = useBusy();
  if (!manage || detail.origin !== 'own' || detail.tier === 'built-in') return null;
  const archive = () => {
    setTried(true);
    if (reasonProblem(reason, t)) return;
    void run(async () => {
      await api.design.archive(tenant, detail.id, reason.trim());
      navigate('/design');
    });
  };
  const inUse = error instanceof ApiError && error.status === 409 ? error.problem : undefined;
  return (
    <div className="design-archive">
      {open ? (
        <div
          className="design-panel design-danger stack-sm"
          role="group"
          aria-label={t('design.archive')}
        >
          <Paragraph data-size="sm">{t('design.archiveHelp')}</Paragraph>
          <ReasonInput
            value={reason}
            onChange={setReason}
            tried={tried}
            label={t('design.reason')}
          />
          <div className="design-actions">
            <BusyButton
              data-size="sm"
              data-color="danger"
              busy={busy}
              busyLabel={t('design.saving')}
              onClick={archive}
            >
              {t('design.archiveConfirm')}
            </BusyButton>
            <Button variant="tertiary" data-size="sm" onClick={() => setOpen(false)}>
              {t('design.archiveCancel')}
            </Button>
          </div>
          {inUse ? (
            <div role="alert" className="design-core">
              <Paragraph data-size="sm">
                <strong>{inUse.title}</strong>
              </Paragraph>
              <ul>
                {(inUse.errors ?? []).map((e) => (
                  <li key={e.message}>{e.message}</li>
                ))}
              </ul>
            </div>
          ) : error ? (
            <Problems error={error} />
          ) : null}
        </div>
      ) : (
        <Button variant="tertiary" data-color="danger" data-size="sm" onClick={() => setOpen(true)}>
          {t('design.archive')}
        </Button>
      )}
    </div>
  );
};
