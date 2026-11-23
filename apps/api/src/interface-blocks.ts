import { isRefBlockId, type RefBlockPayload } from '@genai/contracts';
import {
  parseBlockRef,
  templateReads,
  type BlockDefinition,
  type DefinitionStore,
  type PublishedVersion,
  type ServiceInterface,
} from '@genai/definitions';
import type { BlockFrameUrl } from './block-origin.js';

const zones = ['primary', 'main', 'secondary'] as const;

export const blockSpecOf = (version: PublishedVersion) =>
  (version.definition as BlockDefinition).spec;

/** An edition the organisation may use: its own, or one its publisher shared with everyone. */
export const mayUseEdition = (tenant: string, publisher: string, version: PublishedVersion) =>
  publisher === tenant || blockSpecOf(version).sharing === 'everyone';

/** What a host draws a declarative or code edition from; nothing for a built-in one. */
export const refBlockPayload = (
  ref: string,
  publisher: string,
  spec: BlockDefinition['spec'],
  frameUrl?: string,
  publisherName?: string,
): RefBlockPayload | undefined => {
  if (spec.tier === 'built-in') return undefined;
  return {
    ref,
    tier: spec.tier,
    publisher,
    ...(publisherName ? { publisherName } : {}),
    title: spec.title,
    ...(spec.summary ? { summary: spec.summary } : {}),
    zones: spec.zones,
    events: spec.events,
    states: spec.states,
    ...(spec.props ? { props: spec.props } : {}),
    ...(spec.texts ? { texts: spec.texts } : {}),
    reads: spec.tier === 'code' ? (spec.code?.reads ?? []) : templateReads(spec.template),
    ...(spec.template ? { template: spec.template } : {}),
    ...(frameUrl && spec.code
      ? {
          frame: {
            url: frameUrl,
            sha256: spec.code.sha256,
            ...(spec.code.height === undefined ? {} : { height: spec.code.height }),
          },
        }
      : {}),
  };
};

/** The pinned edition of every `block: ref` in a layout, checked again as the organisation reads it. */
export const resolveInterfaceBlocks = async (
  store: Pick<DefinitionStore, 'get'>,
  tenant: string,
  layout: ServiceInterface['layout'],
  frameUrl: BlockFrameUrl,
  publisherName: (publisher: string) => Promise<string | undefined> = async () => undefined,
): Promise<Record<string, RefBlockPayload>> => {
  const blocks: Record<string, RefBlockPayload> = {};
  const refs = zones.flatMap((zone) =>
    (layout?.zones[zone] ?? []).flatMap((placed) =>
      isRefBlockId(placed.block) && placed.ref ? [placed.ref] : [],
    ),
  );
  for (const ref of new Set(refs)) {
    const target = parseBlockRef(ref);
    if (!target) continue;
    const found = await store.get('Block', target.publisher, target.id, target.version);
    if (!found || !mayUseEdition(tenant, target.publisher, found)) continue;
    const spec = blockSpecOf(found);
    const url = spec.code ? frameUrl({ ...target, sha256: spec.code.sha256 }) : undefined;
    const payload = refBlockPayload(
      ref,
      target.publisher,
      spec,
      url,
      await publisherName(target.publisher),
    );
    if (payload) blocks[ref] = payload;
  }
  return blocks;
};
