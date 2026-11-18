import { Heading, Paragraph } from '@digdir/designsystemet-react';
import { BlockCard } from '../components/BlockCard';
import { blocksAlphabetical } from '@genai/docs-content';
import { useDocumentTitle } from '../document';
import { useT } from '../i18n';

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
    title: 'docsBlocks.newTitle',
    blurb: 'docsBlocks.newBlurb',
    items: blocksAlphabetical.filter((b) => !foundation.has(b.id)),
  },
  {
    title: 'docsBlocks.reusedTitle',
    blurb: 'docsBlocks.reusedBlurb',
    items: blocksAlphabetical.filter((b) => foundation.has(b.id)),
  },
] as const;

/** Alle overordnede byggeklosser i to grupper, alfabetisk innen hver. Byggeklossene ligger under hver av dem. */
export function Blocks() {
  const t = useT();
  useDocumentTitle(t('docsCommon.blocks'));
  return (
    <div className="stack-lg">
      <div className="stack">
        <Heading level={1} data-size="lg" style={{ margin: 0 }}>
          {t('docsCommon.blocks')}
        </Heading>
        <Paragraph className="lede" style={{ margin: 0 }}>
          {t('docsBlocks.lede')}
        </Paragraph>
      </div>
      {groups.map((g) => (
        <section key={g.title} className="stack">
          <div>
            <Heading level={2} data-size="sm" style={{ margin: 0 }}>
              {t(g.title)}
            </Heading>
            <Paragraph
              data-size="sm"
              style={{ margin: 0, color: 'var(--ds-color-neutral-text-subtle)' }}
            >
              {t(g.blurb)}
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
