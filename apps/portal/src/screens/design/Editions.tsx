import {
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Select,
  Table,
} from '@digdir/designsystemet-react';
import type { BlockDetail } from '@genai/contracts/blocks';
import { useLocale } from '@genai/i18n/react';
import { useId, useState } from 'react';
import type { ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { sharingKey, titleOf } from './naming';
import { Problems } from './Problems';

/** «Utgaver»: each edition by its date, and the services that use it, where the one in view can be pinned. */
export const Editions = ({
  api,
  tenant,
  detail,
  dates,
  canPin,
  onPinned,
}: {
  api: ApiClient;
  tenant: string;
  detail: BlockDetail;
  dates: Map<number, string>;
  canPin: boolean;
  onPinned: () => void;
}) => {
  const t = useT();
  const { locale } = useLocale();
  const selectId = useId();
  const [pinned, setPinned] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState<unknown>(undefined);
  const version = detail.edition.version;
  const name = titleOf(detail.title, locale);
  const [services] = useAsync(
    async (signal) => (choosing ? (await api.services(tenant, signal)).data : []),
    [api, tenant, choosing],
  );
  const pin = async (service: string) => {
    setError(undefined);
    try {
      await api.design.pin(
        tenant,
        service,
        { publisher: detail.publisher, id: detail.id },
        { version },
        t('design.pinReason', { name }),
      );
      setPinned(true);
      setChoosing(false);
      onPinned();
    } catch (e) {
      setError(e);
    }
  };
  const dateOf = (v: number | undefined) => (v === undefined ? '' : (dates.get(v) ?? ''));
  const others =
    services.status === 'ready'
      ? services.data.filter((s) => !detail.usedIn.some((u) => u.service === s.id))
      : [];
  return (
    <div className="stack-lg">
      <div className="design-table" role="region" aria-label={t('design.tabEditions')} tabIndex={0}>
        <Table data-size="sm">
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell scope="col">{t('design.colEdition')}</Table.HeaderCell>
              <Table.HeaderCell scope="col">{t('design.colSavedBy')}</Table.HeaderCell>
              <Table.HeaderCell scope="col">{t('design.colWhat')}</Table.HeaderCell>
              <Table.HeaderCell scope="col">{t('design.colSharing')}</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {[...detail.editions].reverse().map((e) => (
              <Table.Row key={e.version}>
                <Table.Cell>{dates.get(e.version)}</Table.Cell>
                <Table.Cell>{e.publishedByName ?? ''}</Table.Cell>
                <Table.Cell>{e.reason}</Table.Cell>
                <Table.Cell>{t(sharingKey(e.sharing))}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
      <section className="stack" aria-labelledby={`${selectId}-used`}>
        <Heading level={2} data-size="sm" id={`${selectId}-used`}>
          {t('design.usedIn')}
        </Heading>
        {detail.usedIn.length > 0 ? (
          <div className="design-table" role="region" aria-label={t('design.usedIn')} tabIndex={0}>
            <Table data-size="sm">
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell scope="col">{t('design.colService')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('design.colTest')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('design.colInUse')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">
                    <span className="visually-hidden">{t('design.colAction')}</span>
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {detail.usedIn.map((use) => {
                  const test = use.draft ?? use.test;
                  return (
                    <Table.Row key={use.service}>
                      <Table.Cell>
                        <a href={`#/services/${encodeURIComponent(use.service)}/interface`}>
                          {use.name}
                        </a>
                      </Table.Cell>
                      <Table.Cell>{dateOf(test)}</Table.Cell>
                      <Table.Cell>{dateOf(use.inUse)}</Table.Cell>
                      <Table.Cell className="design-action">
                        {canPin && test !== version ? (
                          <Button
                            variant="secondary"
                            data-size="sm"
                            onClick={() => void pin(use.service)}
                          >
                            {t('design.pinFor', { service: use.name })}
                          </Button>
                        ) : null}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        ) : null}
        {pinned ? (
          <Paragraph role="status" className="design-done">
            {t('design.pinned')}
          </Paragraph>
        ) : null}
        {canPin && !choosing ? (
          <div>
            <Button variant="tertiary" onClick={() => setChoosing(true)}>
              {t('design.chooseService')}
            </Button>
          </div>
        ) : null}
        {choosing ? (
          <div className="design-choose">
            <Field>
              <Label htmlFor={selectId}>{t('design.service')}</Label>
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
            <Button aria-disabled={!chosen || undefined} onClick={() => chosen && void pin(chosen)}>
              {t('design.pin')}
            </Button>
          </div>
        ) : null}
        {error ? <Problems error={error} /> : null}
      </section>
    </div>
  );
};
