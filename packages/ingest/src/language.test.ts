import { describe, expect, it } from 'vitest';
import { detectLanguage } from './language.js';

// Excerpts from docs.digdir.no pages.
const bokmal =
  'Ansattporten er en egen innloggingstjeneste med funksjonalitet som er tilpasset bruk som ansatt eller i andre situasjoner der en nettjeneste har behov for å vite hvem brukeren er. Det er ikke lov til å bruke registeret til å kvalitetssikre opplysninger fra andre kilder.';
const nynorsk =
  'Det er mogeleg å motta pålogging gjennom ID-porten også for brukarar som ikkje brukar norske eID, dvs. brukarar som normalt ikkje har norsk personidentifikator. Dei fleste testane må gjennomførast før ein kan ta i bruk tenesta, og kva testar som skal køyrast kjem an på integrasjonen.';
const english =
  'The access token enables the client to access APIs on behalf of the authenticated user. For normal web services it should not be used as a session mechanism, and the client must validate the token before it is used.';

describe('document language detection', () => {
  it('tells bokmål, nynorsk and English apart', () => {
    expect(detectLanguage(bokmal)).toBe('nb');
    expect(detectLanguage(nynorsk)).toBe('nn');
    expect(detectLanguage(english)).toBe('en');
  });

  it('ignores frontmatter, code blocks, inline code and URLs', () => {
    const code =
      '```json\n{"the": "and of to is in that it with as are be this you by not or"}\n```';
    expect(
      detectLanguage(`---\ntitle: The access token and the client\n---\n${bokmal}\n\n${code}`),
    ).toBe('nb');
    expect(
      detectLanguage(`${nynorsk} \`the and of to is\` https://example.com/the/and/of/to`),
    ).toBe('nn');
  });

  it('gives no answer for a page with too few marker words', () => {
    expect(detectLanguage('testside grensesnitt')).toBeUndefined();
    expect(detectLanguage('')).toBeUndefined();
    expect(detectLanguage('| Term | Mottaker |\n| Datatype | string |')).toBeUndefined();
  });

  it('counts Norwegian with no bokmål or nynorsk markers as bokmål, and a tie between them as unknown', () => {
    expect(detectLanguage('Det er på til av med og som er det som er på')).toBe('nb');
    expect(detectLanguage('Det er ikke og ikkje på til av med og som er det')).toBeUndefined();
  });
});
