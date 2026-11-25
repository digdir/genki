import { Field, Heading, Label, Paragraph, Select, Tabs, Tag } from '@digdir/designsystemet-react';
import { blockFixtures } from '@genai/contracts/block-fixtures';
import type { BlockDetail, BlockEvent } from '@genai/contracts/blocks';
import { useLocale } from '@genai/i18n/react';
import { useEffect, useId, useMemo, useState } from 'react';
import type { ApiClient } from '../../api';
import { BackLink } from '../../components/BackLink';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import type { ScreenProps } from '../../screen';
import { useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { CodeUpload } from './CodeUpload';
import {
  asBlockDraft,
  bundleOf,
  bundlePath,
  sourcePrefix,
  type BlockDraft,
  type Bundle,
} from './definitions';
import { DesignPreview } from './DesignPreview';
import { editionDates, tierColor, tierKey, titleOf, zoneKey } from './naming';
import { Editions } from './Editions';
import { SaveBar } from './SaveBar';
import { Sharing } from './Sharing';
import { StructureEditor } from './StructureEditor';

type Tab = 'preview' | 'content' | 'editions' | 'sharing';

const tabKey: Record<Tab, PlainKey> = {
  preview: 'design.tabPreview',
  content: 'design.tabContent',
  editions: 'design.tabEditions',
  sharing: 'design.tabSharing',
};

/** The tabs a designelement offers: genki's are read only, and only our own can be shared. */
export const tabsFor = (detail: Pick<BlockDetail, 'tier' | 'origin'>): Tab[] => [
  ...(detail.tier === 'built-in' ? [] : (['preview'] as const)),
  'content',
  'editions',
  ...(detail.origin === 'own' ? (['sharing'] as const) : []),
];

const isTab = (value: string | null): value is Tab =>
  value === 'preview' || value === 'content' || value === 'editions' || value === 'sharing';

export const DesignEditor = ({
  api,
  tenant,
  route,
  publisher,
  id,
}: ScreenProps & { publisher: string; id: string }) => {
  const t = useT();
  const { locale } = useLocale();
  const manage = useRights().has('manage-services');
  const selectId = useId();
  const asked = route.query.get('tab');
  const [tab, setTab] = useState<Tab | undefined>(isTab(asked) ? asked : undefined);
  useEffect(() => {
    if (isTab(asked)) setTab(asked);
  }, [asked]);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [state, retry] = useAsync(
    (signal) => api.design.detail(tenant, publisher, id, version, signal),
    [api, tenant, publisher, id, version],
  );
  const dates = useMemo(
    () => (state.status === 'ready' ? editionDates(state.data.editions, locale, t) : new Map()),
    [state, locale, t],
  );
  if (state.status === 'loading')
    return (
      <div className="design-page">
        <BackLink label={t('design.title')} href="#/design" />
        <Loading label={t('design.loading')} shape="detail" onRetry={retry} />
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="design-page">
        <BackLink label={t('design.title')} href="#/design" />
        <ErrorState error={state.error} onRetry={retry} />
      </div>
    );
  const detail = state.data;
  const tabs = tabsFor(detail);
  const shown: Tab = tab && tabs.includes(tab) ? tab : (tabs[0] ?? 'content');
  const own = detail.origin === 'own' && manage;
  const newest = detail.edition.version === detail.latest.version;

  const saveEdition = async (
    definition: BlockDraft,
    reason: string,
    changed: Record<string, string> = {},
  ) => {
    const carried = await api.design.files(tenant, detail.id, detail.edition.version);
    const kept =
      bundlePath in changed
        ? Object.fromEntries(Object.entries(carried).filter(([p]) => !p.startsWith(sourcePrefix)))
        : carried;
    await api.design.save(
      definition as unknown as Record<string, unknown>,
      { ...kept, ...changed },
      reason,
    );
    setSaved(true);
    setVersion(undefined);
    retry();
  };

  return (
    <div className="design-page">
      <div className="stack-xs">
        <BackLink label={t('design.title')} href="#/design" />
        <div className="design-head">
          <div className="design-title">
            <Heading level={1} data-size="lg">
              {titleOf(detail.title, locale)}
            </Heading>
            <Tag data-color={tierColor[detail.tier]}>{t(tierKey[detail.tier])}</Tag>
          </div>
          <Field>
            <Label htmlFor={selectId} className="visually-hidden">
              {t('design.editionSelect')}
            </Label>
            <Select
              id={selectId}
              value={String(detail.edition.version)}
              onChange={(e) => {
                setSaved(false);
                setVersion(Number(e.target.value));
              }}
            >
              {[...detail.editions].reverse().map((e) => (
                <Select.Option key={e.version} value={String(e.version)}>
                  {t('design.edition', { date: dates.get(e.version) ?? '' })}
                </Select.Option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <Tabs value={shown} onChange={(v) => setTab(v as Tab)}>
        <Tabs.List aria-label={t('design.tabsLabel')}>
          {tabs.map((key) => (
            <Tabs.Tab key={key} value={key}>
              {t(tabKey[key])}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {saved ? (
          <Paragraph role="status" className="design-done">
            {t('design.savedEdition')}
          </Paragraph>
        ) : null}
        <Tabs.Panel value="preview">
          {shown === 'preview' && detail.edition.render ? (
            <DesignPreview payload={detail.edition.render} fixtures={blockFixtures} />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="content">
          {shown === 'content' ? (
            <Content
              key={detail.edition.version}
              api={api}
              tenant={tenant}
              detail={detail}
              editable={own && newest}
              onSave={saveEdition}
            />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="editions">
          {shown === 'editions' ? (
            <Editions
              api={api}
              tenant={tenant}
              detail={detail}
              dates={dates}
              canPin={manage && detail.tier !== 'built-in'}
              onPinned={retry}
            />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="sharing">
          {shown === 'sharing' ? (
            <Sharing
              key={`${detail.edition.version}:${detail.review?.status ?? ''}`}
              api={api}
              tenant={tenant}
              detail={detail}
              readOnly={!own || !newest}
              onSave={saveEdition}
              onRequested={retry}
            />
          ) : null}
        </Tabs.Panel>
      </Tabs>
    </div>
  );
};

const Content = ({
  api,
  tenant,
  detail,
  editable,
  onSave,
}: {
  api: ApiClient;
  tenant: string;
  detail: BlockDetail;
  editable: boolean;
  onSave: (definition: BlockDraft, reason: string, files?: Record<string, string>) => Promise<void>;
}) => {
  const base = asBlockDraft(detail.edition.definition);
  if (detail.tier === 'built-in') return <BuiltInContent base={base} />;
  if (detail.tier === 'code')
    return <CodeContent base={base} editable={editable} onSave={onSave} />;
  return (
    <StructureEditor
      api={api}
      tenant={tenant}
      base={base}
      readOnly={!editable}
      onSave={(definition, reason) => onSave(definition, reason)}
    />
  );
};

const BuiltInContent = ({ base }: { base: BlockDraft }) => {
  const t = useT();
  const settings = Object.entries(base.spec.props?.properties ?? {});
  return (
    <div className="stack design-content">
      <div className="stack-xs">
        <Heading level={2} data-size="2xs">
          {t('design.zonesLegend')}
        </Heading>
        <Paragraph>{base.spec.zones.map((z) => t(zoneKey[z])).join(', ')}</Paragraph>
      </div>
      {settings.length > 0 ? (
        <div className="stack-xs">
          <Heading level={2} data-size="2xs">
            {t('design.settings')}
          </Heading>
          <ul className="design-settings">
            {settings.map(([key, prop]) => (
              <li key={key}>{prop.title ?? key}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Paragraph className="meta">{t('design.changedByGenki')}</Paragraph>
    </div>
  );
};

const CodeContent = ({
  base,
  editable,
  onSave,
}: {
  base: BlockDraft;
  editable: boolean;
  onSave: (definition: BlockDraft, reason: string, files?: Record<string, string>) => Promise<void>;
}) => {
  const code = base.spec.code;
  const [bundle, setBundle] = useState<Bundle | undefined>(
    code ? { text: '', bytes: code.bytes, sha256: code.sha256 } : undefined,
  );
  const [reads, setReads] = useState<string[]>(code?.reads ?? []);
  const [events, setEvents] = useState<BlockEvent[]>(base.spec.events ?? []);
  const [sources, setSources] = useState<Record<string, string>>({});
  const save = async (reason: string) => {
    if (!bundle) return;
    const text = bundle.text || undefined;
    const files: Record<string, string> = {
      ...(text ? { [bundlePath]: text } : {}),
      ...Object.fromEntries(Object.entries(sources).map(([n, v]) => [`${sourcePrefix}${n}`, v])),
    };
    const checked = text ? await bundleOf(text) : bundle;
    await onSave(
      {
        ...base,
        spec: {
          ...base.spec,
          ...(base.spec.sharing === 'everyone' ? { sharing: 'organisation' as const } : {}),
          events,
          code: { ...code, sha256: checked.sha256, bytes: checked.bytes, reads },
        },
      },
      reason,
      files,
    );
  };
  return (
    <div className="stack design-content">
      <fieldset className="design-plain" disabled={!editable}>
        <CodeUpload
          bundle={bundle}
          reads={reads}
          events={events}
          sources={sources}
          onBundle={setBundle}
          onReads={setReads}
          onEvents={setEvents}
          onSources={setSources}
        />
      </fieldset>
      {editable ? <SaveBar onSave={save} /> : null}
    </div>
  );
};
