import type { BlockState, BlockZone } from '@genai/contracts/blocks';
import { AssistantView, HttpError, useAssistant, type AssistantApi } from '@genai/ui-assembly';
import '@genai/ui-assembly/styles.css';
import {
  isBlockId,
  type AssistantLayout,
  type BlockSettings,
  type Look,
  type ModelRow,
  type PlacedBlock,
} from '@genai/ui-blocks/builder';
import '@genai/ui-blocks/styles.css';
import { useEffect, useMemo, useRef, useState } from 'react';

const service = 'forhandsvisning';
const frameWidth = 1280;
const question = 'Hva er klarspråk?';
const answer =
  'Klarspråk betyr at mottakeren finner det hen trenger, forstår det og kan bruke det [1]. Offentlige organ skal bruke klart språk [2].';

const rows: ModelRow[] = [
  {
    id: `${service}__default`,
    _service: service,
    _variant_title: 'Standard',
    _pickable: true,
    _chat: true,
    _documents: {},
    _datasets: [
      { id: 'klarsprak', tenant: service, filters: [{ field: 'type', kinds: ['multiselect'] }] },
    ],
  },
];

const typeField = { id: 'type', label: 'Dokumenttyper', heading: 'Dokumenttype' };
const typeOptions = [
  { value: 'veileder', label: 'Veileder', count: 12 },
  { value: 'lov', label: 'Lov', count: 3 },
];

const sources = [
  {
    index: 1,
    title: 'Klarspråk i staten',
    documentId: 'klarsprak-i-staten',
    excerpts: [
      { chunkId: 'c1', text: 'Klarspråk er korrekt, klar og brukertilpasset kommunikasjon.' },
    ],
  },
  {
    index: 2,
    title: 'Språkloven',
    documentId: 'spraklova',
    excerpts: [{ chunkId: 'c2', text: 'Offentlige organ skal bruke klart språk.' }],
  },
];

const never = (signal: AbortSignal | undefined) =>
  new Promise<never>((_, reject) =>
    signal?.addEventListener('abort', () => reject(new Error('aborted'))),
  );

/** genki's made-up answer for a state: content, a wait that never ends, or a failure. */
export const fixtureApi = (state: BlockState): AssistantApi => ({
  loadModels: async () => rows,
  loadThreads: async () => [],
  loadThread: async () => ({ title: question, turns: [] }),
  loadCorpora: async () => [],
  loadFields: async () => [typeField],
  loadFacets: async () => [{ ...typeField, options: typeOptions }],
  loadAbout: async () => undefined,
  ask: async function* (params) {
    yield { type: 'conversation', conversationId: 'eksempel' };
    yield { type: 'step', step: { tool: 'search' } };
    if (state === 'loading') await never(params.signal);
    if (state === 'error') throw new HttpError(500, 'eksempel');
    yield { type: 'step', step: { tool: 'generate_response' } };
    yield { type: 'text', text: answer };
    yield {
      type: 'done',
      answer: { id: 'a1', text: answer, sources, citations: [], noAnswer: false },
    };
  },
});

/** The layout a built-in block is previewed in: the chat to ask with, and the block in its zone. */
export const previewLayout = (
  block: string,
  zone: BlockZone,
  settings: BlockSettings,
  look: Look,
): AssistantLayout => {
  const placed: PlacedBlock[] = isBlockId(block)
    ? [{ block, ...(Object.keys(settings).length ? { settings } : {}) }]
    : [];
  const zones: Record<BlockZone, PlacedBlock[]> = { primary: [], main: [], secondary: [] };
  if (block !== 'chat') zones.main.push({ block: 'chat' });
  zones[zone].push(...placed);
  return { version: 1, look, zones };
};

const Live = ({ layout, state }: { layout: AssistantLayout; state: BlockState }) => {
  const api = useMemo(() => fixtureApi(state), [state]);
  const assistant = useAssistant({ api, layout, service, tenant: service });
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || state === 'empty') return;
    asked.current = true;
    assistant.send(question);
  }, [assistant, state]);
  return <AssistantView assistant={assistant} frameWidth={frameWidth} host={service} />;
};

/** One of genki's built-in blocks, drawn by the real host with genki's made-up answer. */
export const BuiltInPreview = ({
  block,
  zone,
  settings,
  look,
  state,
}: {
  block: string;
  zone: BlockZone;
  settings: BlockSettings;
  look: Look;
  state: BlockState;
}) => {
  const layout = useMemo(
    () => previewLayout(block, zone, settings, look),
    [block, zone, settings, look],
  );
  const box = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const parent = box.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() =>
      setZoom(Math.min(1, parent.clientWidth / frameWidth)),
    );
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={box} className="design-frame" style={{ width: frameWidth, zoom }}>
      <Live key={state} layout={layout} state={state} />
    </div>
  );
};
