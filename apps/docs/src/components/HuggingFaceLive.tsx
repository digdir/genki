import { Card, Heading, Link, Paragraph, Spinner } from '@digdir/designsystemet-react';
import { ExternalLinkIcon } from '@navikt/aksel-icons';
import { useEffect, useState } from 'react';

/**
 * Levende modellister fra Hugging Face sitt åpne API, vist på delsidene under Språkmodeller.
 * Hentes direkte fra nettleseren (API-et tillater CORS) og mellomlagres i én time.
 * Hvilke lister en byggekloss får, står i `liveByPart` nederst.
 */

type HfModel = {
  id: string;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
};

type Section = { state: 'loading' } | { state: 'error' } | { state: 'ok'; items: HfModel[] };

const HF = 'https://huggingface.co';
const TTL = 60 * 60 * 1000;

async function getJson(url: string): Promise<HfModel[]> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as HfModel[];
}

/** Henter én eller flere lister, slår dem sammen og mellomlagrer resultatet under én nøkkel. */
async function cached(
  key: string,
  urls: string[],
  merge?: (lists: HfModel[][]) => HfModel[],
): Promise<HfModel[]> {
  const k = `hf:${key}`;
  try {
    const hit = sessionStorage.getItem(k);
    if (hit) {
      const { t, v } = JSON.parse(hit) as { t: number; v: HfModel[] };
      if (Date.now() - t < TTL) return v;
    }
  } catch {
    /* ingen cache tilgjengelig */
  }
  const lists = await Promise.all(urls.map(getJson));
  const v = merge ? merge(lists) : lists.flat();
  try {
    sessionStorage.setItem(k, JSON.stringify({ t: Date.now(), v }));
  } catch {
    /* ignorer */
  }
  return v;
}

function useList(list: LiveList): Section {
  const [s, setS] = useState<Section>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    cached(list.key, list.urls, list.merge)
      .then((items) => alive && setS({ state: 'ok', items }))
      .catch(() => alive && setS({ state: 'error' }));
    return () => {
      alive = false;
    };
  }, [list]);
  return s;
}

const nb = new Intl.NumberFormat('nb-NO', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function ModelList({ list }: { list: LiveList }) {
  const s = useList(list);
  return (
    <Card data-color="neutral" style={{ height: '100%' }}>
      <Card.Block>
        <Heading level={3} data-size="2xs" style={{ margin: 0 }}>
          {list.title}
        </Heading>
        <Paragraph
          data-size="xs"
          style={{ margin: 0, color: 'var(--ds-color-neutral-text-subtle)' }}
        >
          {list.blurb}
        </Paragraph>
      </Card.Block>
      <Card.Block>
        {s.state === 'loading' && <Spinner aria-label="Henter" data-size="sm" />}
        {s.state === 'error' && (
          <Paragraph data-size="sm" style={{ margin: 0 }}>
            Kunne ikke hente data fra Hugging Face akkurat nå.
          </Paragraph>
        )}
        {s.state === 'ok' && (
          <ul className="live-list">
            {s.items.map((m) => (
              <li key={m.id}>
                <Link href={`${HF}/${m.id}`}>
                  {m.id} <ExternalLinkIcon aria-hidden />
                </Link>
                <span className="meta">
                  {m.pipeline_tag ? `${m.pipeline_tag} · ` : ''}
                  {m.downloads != null
                    ? `${nb.format(m.downloads)} nedlastinger siste 30 dager`
                    : ''}
                  {m.likes != null ? ` · ${nb.format(m.likes)} likes` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card.Block>
    </Card>
  );
}

/** Levende lister for én del. Vises under egenskapene på delsiden. */
export function LiveModels({ lists }: { lists: LiveList[] }) {
  return (
    <section className="stack">
      <div>
        <p className="fig-caption">Levende data</p>
        <Heading level={2} data-size="md" style={{ margin: 0 }}>
          Akkurat nå på Hugging Face
        </Heading>
        <Paragraph
          data-size="sm"
          style={{ margin: 0, color: 'var(--ds-color-neutral-text-subtle)' }}
        >
          Hentes direkte fra Hugging Face sitt åpne API når siden åpnes, og mellomlagres i én time i
          nettleseren.
        </Paragraph>
      </div>
      <div className={`grid live-grid${lists.length === 1 ? ' one' : ''}`}>
        {lists.map((l) => (
          <ModelList key={l.key} list={l} />
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- Konfigurasjon per byggekloss */

export type LiveList = {
  key: string;
  title: string;
  blurb: string;
  urls: string[];
  merge?: (lists: HfModel[][]) => HfModel[];
};

const models = (q: string, limit: number) => `${HF}/api/models?${q}&direction=-1&limit=${limit}`;

/** Miljøer i Norge som publiserer modeller på Hugging Face. Utvid listen når flere kommer til. */
const norskeMiljoer: { author: string; name: string }[] = [
  { author: 'NbAiLab', name: 'Nasjonalbiblioteket' },
  { author: 'ltg', name: 'UiO (LTG)' },
  { author: 'NorwAI', name: 'NorwAI (NTNU)' },
  { author: 'Sprakbanken', name: 'Språkbanken' },
  { author: 'Fremtind', name: 'Fremtind' },
  { author: 'RuterNorway', name: 'Ruter' },
  { author: 'north', name: 'North (NB)' },
];

const byDownloads =
  (n: number) =>
  (lists: HfModel[][]): HfModel[] =>
    lists
      .flat()
      .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
      .slice(0, n);

/** Nøkkelen er byggeklossens id under Språkmodeller. Byggeklosser uten oppføring får ingen liste. */
export const liveByPart: Record<string, LiveList[]> = {
  norske: [
    {
      key: 'norske-v3',
      title: 'Mest brukte modeller fra norske miljøer',
      blurb: `Alle modelltyper, nedlastinger siste 30 dager, på tvers av ${norskeMiljoer.map((m) => m.name).join(', ')}.`,
      urls: norskeMiljoer.map((m) => models(`author=${m.author}&sort=downloads`, 8)),
      merge: byDownloads(10),
    },
  ],
  apne: [
    {
      key: 'apne-trend',
      title: 'Åpne tekstmodeller folk bruker nå',
      blurb: 'Tekstgenerering, sortert etter trend på Hugging Face.',
      urls: [models('pipeline_tag=text-generation&sort=trendingScore', 10)],
    },
  ],
  embeddings: [
    {
      key: 'embeddings',
      title: 'Mest brukte embeddingsmodeller',
      blurb: 'Sentence similarity, nedlastinger siste 30 dager.',
      urls: [models('pipeline_tag=sentence-similarity&sort=downloads', 8)],
    },
    {
      key: 'rerankere',
      title: 'Mest brukte rerankere',
      blurb: 'Text ranking, nedlastinger siste 30 dager.',
      urls: [models('pipeline_tag=text-ranking&sort=downloads', 8)],
    },
  ],
  tale: [
    {
      key: 'tale-til-tekst',
      title: 'Tale til tekst',
      blurb: 'Automatic speech recognition, sortert etter trend.',
      urls: [models('pipeline_tag=automatic-speech-recognition&sort=trendingScore', 6)],
    },
    {
      key: 'tekst-til-tale',
      title: 'Tekst til tale',
      blurb: 'Text to speech, sortert etter trend.',
      urls: [models('pipeline_tag=text-to-speech&sort=trendingScore', 6)],
    },
    {
      key: 'syn',
      title: 'Bilder og dokumenter',
      blurb: 'Image-text-to-text, sortert etter trend.',
      urls: [models('pipeline_tag=image-text-to-text&sort=trendingScore', 6)],
    },
  ],
};
