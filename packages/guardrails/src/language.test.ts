import { describe, expect, it } from 'vitest';
import { answerLanguage, detectLanguage, detectWrittenStandard } from './language.js';

describe('language detection', () => {
  it.each([
    [
      'Hva står i tildelingsbrevet til Digitaliseringsdirektoratet for 2025, og hvordan følges det opp?',
      'nb',
    ],
    ['Jeg lurer på hvorfor kommunene ikke har tatt i bruk tjenesten ennå.', 'nb'],
    [
      'Kva står det i tildelingsbrevet til Digitaliseringsdirektoratet, og korleis blir det følgt opp?',
      'nn',
    ],
    ['Eg lurer på kvifor kommunane ikkje har teke i bruk tenesta enno.', 'nn'],
    [
      'What does the allocation letter say about how the agency should work with digital services?',
      'en',
    ],
  ])('reads "%s" as %s', (text, language) => {
    expect(detectLanguage(text).language).toBe(language);
  });

  it('says unknown when there is too little to go on', () => {
    expect(detectLanguage('Digdir 2025').language).toBe('unknown');
    expect(detectLanguage('').language).toBe('unknown');
  });

  it('ignores citation markers', () => {
    expect(
      detectLanguage('Digdir skal ikkje gjere dette [1], men eg meiner det [2].').language,
    ).toBe('nn');
  });
});

describe('written standard', () => {
  it.each([
    ['Kva er fristen for å søkje om tilskot?', 'nynorsk'],
    ['Korleis kan eg klage på vedtaket?', 'nynorsk'],
    ['Kven har ansvaret for tenesta i kommunen?', 'nynorsk'],
    ['Eg har flytta og treng å endre adressa mi. Kva må eg gjere?', 'nynorsk'],
    ['Kor mykje kostar det å søkje om byggjeløyve?', 'nynorsk'],
    ['Hva er fristen for å søke om tilskudd?', 'bokmal'],
    ['Hvordan kan jeg klage på vedtaket?', 'bokmal'],
    ['Hvem har ansvaret for tjenesten i kommunen?', 'bokmal'],
    ['Jeg har flyttet og trenger å endre adressen min. Hva må jeg gjøre?', 'bokmal'],
    ['Hvor mye koster det å søke om byggetillatelse?', 'bokmal'],
  ])('reads "%s" as %s', (text, standard) => {
    expect(detectWrittenStandard(text)).toBe(standard);
  });

  it('gives no standard for English or text without markers', () => {
    expect(detectWrittenStandard('What is the deadline?')).toBeUndefined();
    expect(detectWrittenStandard('Digdir 2025')).toBeUndefined();
  });

  it('follows the question for user and holds a fixed standard otherwise', () => {
    expect(answerLanguage('user', 'Kva er fristen?')).toBe('nn');
    expect(answerLanguage('user', 'Hva er fristen?')).toBe('nb');
    expect(answerLanguage('user', 'Deadline?')).toBeUndefined();
    expect(answerLanguage('nynorsk', 'Hva er fristen?')).toBe('nn');
    expect(answerLanguage('bokmal', 'Kva er fristen?')).toBe('nb');
    expect(answerLanguage(undefined, 'Kva er fristen?')).toBeUndefined();
  });
});
