import {
  BulletListIcon,
  ChatIcon,
  CodeIcon,
  CogIcon,
  ComponentIcon,
  FileSearchIcon,
  FileTextIcon,
  FunnelIcon,
  RobotIcon,
  TasklistIcon,
} from '@navikt/aksel-icons';
import {
  Field,
  Heading,
  Input,
  Label,
  Paragraph,
  Tag,
  ToggleGroup,
} from '@digdir/designsystemet-react';
import type { BlockOrigin, BlockSummary } from '@genai/contracts/blocks';
import { useLocale } from '@genai/i18n/react';
import { useId, useState, type ComponentType } from 'react';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import type { ScreenProps } from '../../screen';
import { ErrorState, Loading } from '../../states';
import { StudioActions } from './StudioActions';
import { designPath, originColor, titleOf, versionName, zoneKey } from './naming';

type Show = 'all' | BlockOrigin;

const icons: Record<string, ComponentType<{ 'aria-hidden'?: boolean }>> = {
  approach: RobotIcon,
  chat: ChatIcon,
  sources: FileSearchIcon,
  'document-view': FileTextIcon,
  filter: FunnelIcon,
  settings: CogIcon,
  threads: TasklistIcon,
};

const iconOf = (block: BlockSummary) =>
  block.tier === 'built-in'
    ? (icons[block.id] ?? BulletListIcon)
    : block.tier === 'code'
      ? CodeIcon
      : ComponentIcon;

/** Block Studio's catalogue: every block the organisation may use, as cards with search and filters. */
export const Catalogue = ({ api, tenant, tenantName }: ScreenProps) => {
  const t = useT();
  const { locale } = useLocale();
  const searchId = useId();
  const [q, setQ] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [state, retry] = useAsync((signal) => api.design.list(tenant, signal), [api, tenant]);
  const originName = (origin: BlockOrigin) =>
    origin === 'built-in'
      ? t('design.fromGenki')
      : origin === 'own'
        ? t('design.ourTag')
        : t('design.shared');
  const head = (
    <div className="design-head">
      <div className="stack-xs">
        <Heading level={1} data-size="lg">
          {t('design.title')}
        </Heading>
        <Paragraph data-size="sm" className="meta">
          {t('design.lead')}
        </Paragraph>
      </div>
      <StudioActions api={api} tenant={tenant} tenantName={tenantName} />
    </div>
  );
  if (state.status !== 'ready')
    return (
      <div className="design-page">
        {head}
        {state.status === 'loading' ? (
          <Loading label={t('design.loading')} shape="list" onRetry={retry} />
        ) : (
          <ErrorState error={state.error} onRetry={retry} />
        )}
      </div>
    );
  const needle = q.trim().toLocaleLowerCase(locale);
  const words = (b: BlockSummary) =>
    [
      titleOf(b.title, locale),
      titleOf(b.summary, locale),
      originName(b.origin),
      b.publisherName,
      ...b.zones.map((z) => t(zoneKey[z])),
    ]
      .join(' ')
      .toLocaleLowerCase(locale);
  const cards = state.data.filter(
    (b) => (show === 'all' || b.origin === show) && (!needle || words(b).includes(needle)),
  );
  return (
    <div className="design-page">
      {head}
      <div className="design-tools">
        <Field className="design-search">
          <Label htmlFor={searchId} className="visually-hidden">
            {t('design.searchLabel')}
          </Label>
          <Input
            id={searchId}
            type="search"
            value={q}
            placeholder={t('design.searchPlaceholder')}
            onChange={(e) => setQ(e.target.value)}
          />
        </Field>
        <ToggleGroup
          data-size="sm"
          variant="secondary"
          aria-label={t('design.show')}
          value={show}
          onChange={(v) => setShow(v as Show)}
        >
          <ToggleGroup.Item value="all">{t('design.showAll')}</ToggleGroup.Item>
          <ToggleGroup.Item value="built-in">{t('design.fromGenki')}</ToggleGroup.Item>
          <ToggleGroup.Item value="own">{t('design.ours')}</ToggleGroup.Item>
          <ToggleGroup.Item value="shared">{t('design.shared')}</ToggleGroup.Item>
        </ToggleGroup>
      </div>
      {cards.length === 0 ? (
        <Paragraph className="design-empty">
          {t('design.noneMatch')} <a href="#/design/import">{t('design.noneMatchLink')}</a>.
        </Paragraph>
      ) : (
        <ul className="design-cards">
          {cards.map((b) => {
            const Icon = iconOf(b);
            const name = titleOf(b.title, locale);
            return (
              <li key={`${b.publisher}/${b.id}`}>
                <a className="design-card" href={`#${designPath(b.publisher, b.id)}`}>
                  <span className="design-thumb">
                    <Icon aria-hidden />
                  </span>
                  <Heading level={2} data-size="2xs">
                    {name}
                  </Heading>
                  {b.summary ? (
                    <Paragraph data-size="sm" className="meta">
                      {titleOf(b.summary, locale)}
                    </Paragraph>
                  ) : null}
                  <span className="design-tags">
                    <Tag data-size="sm" data-color={originColor[b.origin]}>
                      {b.origin === 'shared' ? b.publisherName : originName(b.origin)}
                    </Tag>
                    {b.zones.map((z) => (
                      <Tag key={z} data-size="sm" data-color="neutral">
                        {t(zoneKey[z])}
                      </Tag>
                    ))}
                    <Tag data-size="sm" data-color="neutral">
                      {versionName(t, b.latest.version)}
                    </Tag>
                    {b.latest.fromClaude ? (
                      <Tag data-size="sm" data-color="info">
                        {t('design.fromClaude')}
                      </Tag>
                    ) : null}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
