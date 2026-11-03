import { Heading, Paragraph } from '@digdir/designsystemet-react';
import { BlockCard } from '../components/BlockCard';
import { blocksAlphabetical } from '../data/blocks';

/** Overordnede byggeklosser Genki står på, men ikke bygger: fellesløsninger, plattform, modeller og regnekraft. */
const foundation = new Set([
  'autentisering',
  'tilgangsstyring',
  'plattform',
  'sprakmodeller',
  'ki-infrastruktur',
]);

const groups = [
  {
    title: 'Nye byggeklosser',
    blurb:
      'Det Genki tilfører: tjenester, grensesnitt, rammeverk, kunnskap, verktøy, kvalitet og KI-porten.',
    items: blocksAlphabetical.filter((b) => !foundation.has(b.id)),
  },
  {
    title: 'Gjenbrukes',
    blurb:
      'Byggeklosser som finnes fra før: nasjonale fellesløsninger, Digdirs applikasjonsplattform, språkmodellene og regnekraften de kjører på. Genki bruker dem gjennom avtaler og API, og de kan byttes ut.',
    items: blocksAlphabetical.filter((b) => foundation.has(b.id)),
  },
];

/** Alle overordnede byggeklosser i to grupper, alfabetisk innen hver. Byggeklossene ligger under hver av dem. */
export function Blocks() {
  return (
    <div className="stack-lg">
      <div className="stack">
        <Heading level={1} data-size="lg" style={{ margin: 0 }}>
          Byggeklosser
        </Heading>
        <Paragraph className="lede" style={{ margin: 0 }}>
          Alt en virksomhet trenger for å bygge en KI-tjeneste, bygd én gang og delt. Hver
          overordnet byggekloss samler byggeklossene som løser ett behov. Hver byggekloss sitter bak
          en kontrakt, så den kan ha flere implementasjoner og byttes ut, også hvem som leverer den.
        </Paragraph>
      </div>
      {groups.map((g) => (
        <section key={g.title} className="stack">
          <div>
            <Heading level={2} data-size="sm" style={{ margin: 0 }}>
              {g.title}
            </Heading>
            <Paragraph
              data-size="sm"
              style={{ margin: 0, color: 'var(--ds-color-neutral-text-subtle)' }}
            >
              {g.blurb}
            </Paragraph>
          </div>
          <div className="grid">
            {g.items.map((b) => (
              <BlockCard key={b.id} block={b} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
