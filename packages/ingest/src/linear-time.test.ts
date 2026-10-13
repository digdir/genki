import { describe, expect, it } from 'vitest';
import { citationPdfUrl } from './kudos.js';
import { extractMainContent, htmlToMarkdown } from './html.js';
import { parseFrontmatter } from './website.js';

const quickly = (run: () => unknown) => {
  const started = performance.now();
  run();
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
});
