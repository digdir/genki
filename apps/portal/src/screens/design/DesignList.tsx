import { PlusIcon } from '@navikt/aksel-icons';
import {
  Field,
  Heading,
  Input,
  Label,
  Paragraph,
  Table,
  Tag,
  ToggleGroup,
} from '@digdir/designsystemet-react';
import type { BlockOrigin, BlockSummary } from '@genai/contracts/blocks';
import { useLocale } from '@genai/i18n/react';
import { useId, useState } from 'react';
import { useAsync } from '../../hooks';
import { Icon } from '../../components/Icon';
import { useT } from '../../i18n';
import type { ScreenProps } from '../../screen';
import { useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { designPath, editionDates, tierColor, tierKey, titleOf } from './naming';

type Show = 'all' | BlockOrigin;

const CreateButton = () => {
  const t = useT();
  return (
    <a className="ds-button" data-variant="primary" href="#/design/new">
      <Icon icon={PlusIcon} />
      {t('design.create')}
    </a>
  );
};

export const DesignList = ({ api, tenant }: ScreenProps) => {
  const t = useT();
  const { locale } = useLocale();
  const canCreate = useRights().has('manage-services');
  const searchId = useId();
  const [q, setQ] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [state, retry] = useAsync((signal) => api.design.list(tenant, signal), [api, tenant]);
  const heading = (
    <div className="design-head">
      <Heading level={1} data-size="lg">
        {t('design.title')}
      </Heading>
      {canCreate ? <CreateButton /> : null}
    </div>
  );
  if (state.status === 'loading')
    return (
      <>
        {heading}
        <Loading label={t('design.loading')} shape="list" onRetry={retry} />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        {heading}
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );
  const all = state.data;
  const needle = q.trim().toLocaleLowerCase(locale);
  const rows = all.filter(
    (b) =>
      (show === 'all' || b.origin === show) &&
      (!needle || titleOf(b.title, locale).toLocaleLowerCase(locale).includes(needle)),
  );
  return (
    <div className="design-page">
      {heading}
      {all.length === 0 ? (
        <Paragraph>{t('design.empty')}</Paragraph>
      ) : (
        <>
          <div className="design-filters">
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
              <ToggleGroup.Item value="own">{t('design.showOwn')}</ToggleGroup.Item>
              <ToggleGroup.Item value="built-in">{t('design.fromGenki')}</ToggleGroup.Item>
              <ToggleGroup.Item value="shared">{t('design.sharedWithEveryone')}</ToggleGroup.Item>
            </ToggleGroup>
          </div>
          {rows.length === 0 ? (
            <Paragraph>{t('design.noneMatch')}</Paragraph>
          ) : (
            <DesignTable rows={rows} />
          )}
        </>
      )}
    </div>
  );
};

const DesignTable = ({ rows }: { rows: BlockSummary[] }) => {
  const t = useT();
  const { locale } = useLocale();
  return (
    <div className="design-table" role="region" aria-label={t('design.listLabel')} tabIndex={0}>
      <Table>
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell scope="col">{t('design.colName')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('design.colType')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('design.colEdition')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('design.usedIn')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">
              <span className="visually-hidden">{t('design.colSharing')}</span>
            </Table.HeaderCell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {rows.map((b) => (
            <Table.Row key={`${b.publisher}/${b.id}`}>
              <Table.Cell>
                <a href={`#${designPath(b.publisher, b.id)}`} className="design-name">
                  {titleOf(b.title, locale)}
                </a>
                {b.origin === 'shared' ? (
                  <span className="design-publisher">{b.publisherName}</span>
                ) : null}
              </Table.Cell>
              <Table.Cell>
                <Tag data-size="sm" data-color={tierColor[b.tier]}>
                  {t(tierKey[b.tier])}
                </Tag>
              </Table.Cell>
              <Table.Cell className="nowrap">
                {editionDates([b.latest], locale, t).get(b.latest.version)}
              </Table.Cell>
              <Table.Cell className="nowrap">
                {b.usedBy === 0 ? t('design.usedNone') : t('design.usedCount', { count: b.usedBy })}
              </Table.Cell>
              <Table.Cell>
                {b.sharing === 'everyone' ? (
                  <Tag data-size="sm" data-color="success">
                    {t('design.sharedWithEveryone')}
                  </Tag>
                ) : null}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
};
