import { describe, expect, it } from 'vitest';
import { citationPdfUrl } from './kudos.js';
import { extractMainContent, htmlToMarkdown } from './html.js';
import { ingestDocuments, type DocumentLoopOptions } from './pipeline.js';
import { parseFrontmatter, parseSitemapXml } from './website.js';

const quickly = (run: () => unknown) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

const quicklyAsync = async (run: () => Promise<unknown>) => {
  const started = performance.now();
  await run();
  return performance.now() - started;
};

describe('ingestion parsers on adversarial input', () => {
  it('removes comments and scripts in linear time and drops an unclosed script', () => {
    expect(quickly(() => extractMainContent('<!--'.repeat(50_000)))).toBeLessThan(1000);
    expect(quickly(() => extractMainContent('<script'.repeat(50_000)))).toBeLessThan(1000);
    expect(extractMainContent('<p>Hei</p><script>alert(1)')).not.toContain('alert');
  });

  it('strips tags in linear time and leaves no tag rebuilt from the pieces', () => {
    expect(quickly(() => htmlToMarkdown(`<p>${'<'.repeat(100_000)}</p>`))).toBeLessThan(1000);
    expect(htmlToMarkdown('<p><<b>script>alert(1)</p>')).not.toContain('<script>');
  });

  it('reads tags in linear time when a tag name runs on or quotes never close', () => {
    expect(quickly(() => extractMainContent(`<A${'-'.repeat(100_000)}`))).toBeLessThan(1000);
    expect(quickly(() => extractMainContent(`<A"${'"<A"'.repeat(30_000)}`))).toBeLessThan(1000);
    expect(quickly(() => extractMainContent(`<A'${"'<A'".repeat(30_000)}`))).toBeLessThan(1000);
    expect(quickly(() => extractMainContent(`${'<a '.repeat(50_000)}`))).toBeLessThan(1000);
    expect(htmlToMarkdown('<p>Før<br/>etter <a href="/x" title=\'«a»\'>lenke</a></p>')).toContain(
      'lenke',
    );
  });

  it('finds the citation PDF link in linear time', () => {
    expect(quickly(() => citationPdfUrl('citation_pdf_url"'.repeat(20_000)))).toBeLessThan(1000);
    expect(
      citationPdfUrl('<meta name="citation_pdf_url" content="https://example.no/a.pdf">'),
    ).toBe('https://example.no/a.pdf');
  });

  it('reads front matter in linear time', () => {
    expect(quickly(() => parseFrontmatter(`---\n${'\n\t'.repeat(100_000)}`))).toBeLessThan(1000);
    expect(parseFrontmatter('---\ntitle: Hei\n---\nTekst')).toEqual({ title: 'Hei' });
  });

  it('reads sitemap blocks in linear time when they are never closed', () => {
    expect(quickly(() => parseSitemapXml(`<urlset>${'<url><loc>a'.repeat(50_000)}`))).toBeLessThan(
      1000,
    );
    expect(quickly(() => parseSitemapXml(`<urlset>${'<url'.repeat(100_000)}`))).toBeLessThan(1000);
    expect(
      quickly(() => parseSitemapXml(`<sitemapindex>${'<sitemap><loc>a'.repeat(50_000)}`)),
    ).toBeLessThan(1000);
    expect(
      parseSitemapXml('<urlset><url><loc>https://x.no/a.md</loc></url><url><loc>b</url></urlset>'),
    ).toEqual({ kind: 'urlset', entries: [{ loc: 'https://x.no/a.md' }] });
  });

  it('collects skipped documents in linear time', async () => {
    const skipped = Array.from({ length: 100_000 }, (_, i) => ({
      document: `d${i}`,
      reason: 'unsupported_type' as const,
    }));
    const options = {
      source: {
        kind: 'website',
        phraseRows: 'pipeline',
        documents: async function* () {},
        skipped,
      },
      chunking: {},
    } as unknown as DocumentLoopOptions;
    let result: Awaited<ReturnType<typeof ingestDocuments>> | undefined;
    const took = await quicklyAsync(async () => {
      result = await ingestDocuments(options, async () => {});
    });
    expect(took).toBeLessThan(1000);
    expect(result?.skippedDocuments).toHaveLength(100_000);
  });
});
