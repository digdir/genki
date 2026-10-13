import { Field, Heading, Label, Paragraph, Select, Table } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { useT, type T } from '../../i18n';
import type { ApiClient } from '../../api';
import { CopyButton } from '../../components/CopyButton';
import { API_BASE, apiServices, type ApiService } from '../../data/api-reference';
import { useAsync } from '../../hooks';
import type { SharedService } from '../../types';

const J = (o: unknown) => JSON.stringify(o, null, 2);

const fromShared = (s: SharedService, t: T): ApiService => {
  const def = s.variants.find((v) => v.id === 'default') ?? s.variants[0];
  return {
    id: `shared:${s.tenant}:${s.id}`,
    name: s.name,
    publicName: def?.publicName ?? `${s.id}__default`,
    version: s.version ?? 1,
    desc: s.purpose,
    input: [],
    output: [],
    variants: s.variants.map((v) => ({
      name: v.id === 'default' ? t('apiref.variantDefault') : v.id,
      isDefault: v.id === 'default',
      publicName: v.publicName,
      alias: v.aliases.length ? v.aliases.join(', ') : '–',
      overrides: v.id === 'default' ? 'apiref.overrideNone' : undefined,
    })),
  };
};

const SchemaTable = ({ title, rows }: { title: string; rows: ApiService['input'] }) => {
  const t = useT();
  return (
    <section className="stack-sm" aria-labelledby={`sch-${title}`}>
      <Heading level={2} data-size="2xs" id={`sch-${title}`}>
        {title}
      </Heading>
      {rows.length === 0 ? (
        <Paragraph data-size="sm" className="meta">
          {t('apiref.schemaUnavailable')}
        </Paragraph>
      ) : (
        <div tabIndex={0} role="region" aria-label={title} className="table-scroll">
          <Table data-size="sm">
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell scope="col">{t('apiref.colField')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('apiref.colType')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('apiref.colRequired')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('apiref.colDescription')}</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {rows.map(([n, type, r, d]) => (
                <Table.Row key={n}>
                  <Table.HeaderCell scope="row">
                    <code>{n}</code>
                  </Table.HeaderCell>
                  <Table.Cell>{type}</Table.Cell>
                  <Table.Cell>{t(r ? 'apiref.yes' : 'apiref.no')}</Table.Cell>
                  <Table.Cell>{d || '–'}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
    </section>
  );
};

export const ServiceAsApi = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const [shared] = useAsync((signal) => api.sharedServices(signal), [api]);
  const [svcId, setSvcId] = useState('ka');
  const [ver, setVer] = useState('siste');
  const options = [
    ...apiServices,
    ...(shared.status === 'ready' ? shared.data.map((x) => fromShared(x, t)) : []),
  ];
  const s = options.find((o) => o.id === svcId) ?? apiServices[0];
  if (!s) return null;
  const latest = s.version;
  const versions = [latest, latest - 1, latest - 2].filter((v) => v > 0);
  const example =
    ver === 'siste'
      ? t('apiref.exampleLatest', { model: s.publicName })
      : t('apiref.exampleVersion', { version: ver, model: s.publicName });
  const required = s.input.filter((r) => r[2]).map((r) => r[0].split('.')[0] ?? r[0]);
  const inputSchema = {
    type: 'object',
    required: [...new Set(required)],
    properties: Object.fromEntries(
      s.input
        .filter((r) => !r[0].includes('.'))
        .map(([n, t, , d]) => [n, { type: t, description: d }]),
    ),
  };
  const restBody =
    s.id === 'su'
      ? {
          query: 'Hent ut feltene fra søknaden.',
          fil: { navn: 'Søknad.pdf', url: 'https://filer.testetaten.example.no/s/118' },
        }
      : { query: 'Hva sier evalueringene om ventetid?' };
  const blocks: [string, string, string][] = [
    [
      t('apiref.asMcp'),
      t('apiref.asMcpDesc'),
      J({ name: s.publicName, description: s.desc, inputSchema }),
    ],
    [
      t('apiref.asOpenAi'),
      t('apiref.asOpenAiDesc'),
      J({
        object: 'list',
        data: [{ id: s.publicName, object: 'model', owned_by: 'testetaten', created: 1759740000 }],
      }),
    ],
    [
      t('apiref.asRest'),
      t('apiref.asRestDesc'),
      `curl -X POST "${API_BASE}/api/tools/call/${s.publicName}" \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '${J(restBody)}'`,
    ],
  ];

  return (
    <div className="stack-lg">
      <section aria-labelledby="var-h" className="stack-sm">
        <Heading level={2} data-size="xs" id="var-h">
          {t('apiref.variants')}
        </Heading>
        <Paragraph data-size="sm" className="ar-measure">
          {t('apiref.variantsIntro')}
        </Paragraph>
        <div
          tabIndex={0}
          role="region"
          aria-label={t('apiref.variantsTable')}
          className="table-scroll"
        >
          <Table>
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell scope="col">{t('apiref.colVariant')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('apiref.colPublicName')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('apiref.colAlias')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('apiref.colOverrides')}</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {s.variants.map((v) => (
                <Table.Row key={v.publicName}>
                  <Table.HeaderCell scope="row">
                    {v.isDefault ? t('apiref.variantDefault') : v.name}
                  </Table.HeaderCell>
                  <Table.Cell>
                    <code>{v.publicName}</code>
                  </Table.Cell>
                  <Table.Cell>
                    <code>{v.alias}</code>
                  </Table.Cell>
                  <Table.Cell>{v.overrides ? t(v.overrides) : '–'}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
        <div className="ar-version">
          <Field>
            <Label htmlFor="var-ver">{t('apiref.version')}</Label>
            <Field.Description>{t('apiref.versionHint')}</Field.Description>
            <Select id="var-ver" value={ver} onChange={(e) => setVer(e.target.value)}>
              <Select.Option value="siste">{t('apiref.versionLatest', { latest })}</Select.Option>
              {versions.map((v) => (
                <Select.Option key={v} value={String(v)}>
                  {v}
                </Select.Option>
              ))}
            </Select>
          </Field>
          <pre tabIndex={0} aria-label={t('apiref.versionExample')} className="code ar-version-ex">
            {example}
          </pre>
        </div>
      </section>
      <Field className="ar-svc">
        <Label htmlFor="svc">{t('apiref.service')}</Label>
        <Select
          id="svc"
          value={s.id}
          onChange={(e) => {
            setSvcId(e.target.value);
            setVer('siste');
          }}
        >
          {options.map((o) => (
            <Select.Option key={o.id} value={o.id}>
              {o.name} ({o.publicName})
            </Select.Option>
          ))}
        </Select>
      </Field>
      <dl className="facts">
        {[
          [t('apiref.factPublicName'), s.publicName, t('apiref.pointsAt', { version: s.version })],
          [t('apiref.factOpenAi'), s.publicName, t('apiref.onBase', { base: `${API_BASE}/v1` })],
          [t('apiref.factMcp'), s.publicName, t('apiref.onBase', { base: `${API_BASE}/api/mcp` })],
          [t('apiref.factRest'), `POST /api/tools/call/${s.publicName}`, ''],
        ].map(([l, v, sub]) => (
          <div key={l}>
            <dt>{l}</dt>
            <dd>
              <code>{v}</code>
            </dd>
            {sub ? <dd className="meta">{sub}</dd> : null}
          </div>
        ))}
      </dl>
      <Paragraph data-size="sm" className="ar-measure">
        {t.rich('apiref.publicNameNote', {
          name: s.publicName,
          strong: (c) => <strong>{c}</strong>,
          code: (c) => <code>{c}</code>,
        })}
      </Paragraph>
      <div className="stack">
        {blocks.map(([title, desc, code], i) => (
          <section key={title} className="stack-sm" aria-labelledby={`blk-${i}`}>
            <Heading level={2} data-size="2xs" id={`blk-${i}`}>
              {title}
            </Heading>
            <span className="meta small">{desc}</span>
            <div className="code-block">
              <div className="code-block-head">
                <span>{title}</span>
                <CopyButton
                  text={code}
                  ariaLabel={t('apiref.copy', { what: title.toLowerCase() })}
                />
              </div>
              <pre tabIndex={0} aria-label={title}>
                <code>{code}</code>
              </pre>
            </div>
          </section>
        ))}
      </div>
      <div className="ar-schemas">
        <SchemaTable title={t('apiref.inputSchema')} rows={s.input} />
        <SchemaTable title={t('apiref.outputSchema')} rows={s.output} />
      </div>
    </div>
  );
};
