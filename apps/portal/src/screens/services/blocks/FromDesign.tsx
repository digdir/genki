import {
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Select,
  Tag,
} from '@digdir/designsystemet-react';
import type { AssistantLayout } from '@genai/ui-blocks/builder';
import type { BlockSummary, BlockZone, RefBlockPayload } from '@genai/contracts/blocks';
import { useLocale } from '@genai/i18n/react';
import { useId, useState } from 'react';
import type { ApiClient } from '../../../api';
import type { PinnedDraft } from '../../../api/design';
import { useAsync } from '../../../hooks';
import { useT } from '../../../i18n';
import { designPath, titleOf, versionName, zoneKey } from '../../design/naming';
import { Problems } from '../../design/Problems';
import type { PinnedRef } from './layoutStore';

const refPattern = /^(\d{9})\/([a-z0-9][a-z0-9-]{0,62})@([1-9]\d{0,8})$/;

/** `<publisher>/<id>@<version>` read apart, or nothing for anything else. */
export const parseRef = (ref: string) => {
  const found = refPattern.exec(ref);
  if (!found) return undefined;
  const [, publisher = '', id = '', version = ''] = found;
  return { publisher, id, version: Number(version) };
};

const keyOf = (target: { publisher: string; id: string }) => `${target.publisher}/${target.id}`;

/** The pinned editions, so the try view draws them as the hosted assistant would. */
export const usePinnedBlocks = (api: ApiClient, tenant: string, pinned: readonly PinnedRef[]) => {
  const refs = pinned.flatMap((p) => (p.placed.ref ? [p.placed.ref] : []));
  const key = refs.join('\n');
  const [state] = useAsync(
    async (signal) => {
      const found = await Promise.all(
        refs.map(async (ref) => {
          const target = parseRef(ref);
          if (!target) return undefined;
          const detail = await api.design
            .detail(tenant, target.publisher, target.id, target.version, signal)
            .catch(() => undefined);
          return detail?.edition.render ? ([ref, detail.edition.render] as const) : undefined;
        }),
      );
      return Object.fromEntries(found.filter((f) => f !== undefined)) as Record<
        string,
        RefBlockPayload
      >;
    },
    [api, tenant, key],
  );
  return state.status === 'ready' ? state.data : undefined;
};

export interface PinActions {
  beforePin: (layout?: AssistantLayout) => Promise<void>;
  onPinned: (draft: PinnedDraft, pinned: boolean) => void;
  done: boolean;
}

/** «Fra Utforming»: the organisation's own and shared design elements, pinned in the testutgave. */
export const FromLibrary = ({
  api,
  tenant,
  service,
  pinned,
  actions,
}: {
  api: ApiClient;
  tenant: string;
  service: string;
  pinned: readonly PinnedRef[];
  actions: PinActions;
}) => {
  const t = useT();
  const headingId = useId();
  const [list] = useAsync((signal) => api.design.list(tenant, signal), [api, tenant]);
  const blocks = list.status === 'ready' ? list.data.filter((b) => b.tier !== 'built-in') : [];
  if (blocks.length === 0) return null;
  return (
    <section className="ref-blocks" aria-labelledby={headingId}>
      <Heading level={2} data-size="2xs" id={headingId}>
        {t('design.fromLibrary')}
      </Heading>
      <div className="ref-blocks-list stack-sm">
        {blocks.map((block) => (
          <RefBlockRow
            key={keyOf(block)}
            api={api}
            tenant={tenant}
            service={service}
            block={block}
            pin={pinned.find((p) => {
              const target = p.placed.ref ? parseRef(p.placed.ref) : undefined;
              return target && keyOf(target) === keyOf(block);
            })}
            actions={actions}
          />
        ))}
      </div>
      {actions.done ? (
        <Paragraph role="status" data-size="sm" className="ref-blocks-done">
          {t('design.pinned')}
        </Paragraph>
      ) : null}
    </section>
  );
};

const RefBlockRow = ({
  api,
  tenant,
  service,
  block,
  pin,
  actions,
}: {
  api: ApiClient;
  tenant: string;
  service: string;
  block: BlockSummary;
  pin: PinnedRef | undefined;
  actions: PinActions;
}) => {
  const t = useT();
  const { locale } = useLocale();
  const ids = useId();
  const [detail] = useAsync(
    (signal) => api.design.detail(tenant, block.publisher, block.id, undefined, signal),
    [api, tenant, block.publisher, block.id, block.latest.version],
  );
  const editions = detail.status === 'ready' ? detail.data.editions : [block.latest];
  const [version, setVersion] = useState(block.latest.version);
  const [zone, setZone] = useState<BlockZone>(block.zones[0] ?? 'main');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const name = titleOf(block.title, locale);
  const target = { publisher: block.publisher, id: block.id };
  const pinnedVersion = pin?.placed.ref ? parseRef(pin.placed.ref)?.version : undefined;
  const newest = block.latest.version;

  const act = async (work: () => Promise<PinnedDraft>, pinned: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await actions.beforePin();
      actions.onPinned(await work(), pinned);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const pinAt = (v: number, z?: BlockZone) =>
    act(
      () =>
        api.design.pin(
          tenant,
          service,
          target,
          { version: v, ...(z ? { zone: z } : {}) },
          t('design.pinReason', { name, version: versionName(t, v) }),
        ),
      true,
    );
  const takeOut = () =>
    act(
      () => api.design.unpin(tenant, service, target, t('design.takeOutReason', { name })),
      false,
    );

  return (
    <div className="ref-block-row">
      <div className="ref-block-name">
        <a href={`#${designPath(block.publisher, block.id)}`}>{name}</a>
        <Tag data-size="sm" data-color="neutral">
          {t(
            block.tier === 'code'
              ? 'design.withCode'
              : block.tier === 'declarative'
                ? 'design.withoutCode'
                : 'design.fromGenki',
          )}
        </Tag>
        {block.origin === 'shared' ? (
          <span className="ref-block-publisher">{block.publisherName}</span>
        ) : null}
      </div>
      {pin && pinnedVersion !== undefined ? (
        <div className="ref-block-actions">
          <span>
            {t('design.pinnedAt', {
              version: versionName(t, pinnedVersion),
              zone: t(zoneKey[pin.zone]),
            })}
          </span>
          {pinnedVersion < newest ? (
            <>
              <span className="ref-block-newer">
                {t('design.newer', { version: versionName(t, newest) })}
              </span>
              <Button
                variant="secondary"
                data-size="sm"
                aria-disabled={busy || undefined}
                aria-label={`${t('design.useIt')}, ${name}`}
                onClick={() => !busy && void pinAt(newest)}
              >
                {t('design.useIt')}
              </Button>
            </>
          ) : null}
          <Button
            variant="tertiary"
            data-size="sm"
            className="ref-block-out"
            aria-disabled={busy || undefined}
            aria-label={`${t('design.takeOut')}, ${name}`}
            onClick={() => !busy && void takeOut()}
          >
            {t('design.takeOut')}
          </Button>
        </div>
      ) : (
        <div className="ref-block-actions">
          <Field data-size="sm">
            <Label htmlFor={`${ids}-edition`}>{t('design.colEdition')}</Label>
            <Select
              id={`${ids}-edition`}
              value={String(version)}
              onChange={(e) => setVersion(Number(e.target.value))}
            >
              {[...editions].reverse().map((e) => (
                <Select.Option key={e.version} value={String(e.version)}>
                  {versionName(t, e.version)}
                </Select.Option>
              ))}
            </Select>
          </Field>
          <Field data-size="sm">
            <Label htmlFor={`${ids}-zone`}>{t('design.zone')}</Label>
            <Select
              id={`${ids}-zone`}
              value={zone}
              onChange={(e) => setZone(e.target.value as BlockZone)}
            >
              {block.zones.map((z) => (
                <Select.Option key={z} value={z}>
                  {t(zoneKey[z])}
                </Select.Option>
              ))}
            </Select>
          </Field>
          <Button
            data-size="sm"
            aria-disabled={busy || undefined}
            aria-label={`${t('design.pin')}, ${name}`}
            onClick={() => !busy && void pinAt(version, zone)}
          >
            {t('design.pin')}
          </Button>
        </div>
      )}
      {error ? <Problems error={error} /> : null}
    </div>
  );
};
