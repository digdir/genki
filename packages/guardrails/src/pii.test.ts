import { describe, expect, it } from 'vitest';
import {
  createVault,
  findPii,
  isAccountNumber,
  personNumberKind,
  piiCategories,
  redactPii,
} from './pii.js';

describe('Norwegian identifiers', () => {
  const valid = [
    ['15838510075', 'national-id'],
    ['01817010055', 'national-id'],
    ['158385 10075', 'national-id'],
    ['45838510098', 'd-number'],
  ];

  it.each(valid)('accepts %s as a %s by both check digits and the date', (value, kind) => {
    expect(personNumberKind(value)).toBe(kind);
  });

  it.each(valid)('uses only synthetic test numbers with month plus 80, like %s', (value) => {
    expect(Number(value.slice(2, 4))).toBeGreaterThan(80);
  });

  it.each([
    '15838510076',
    '15838510085',
    '15838510004',
    '01017012345',
    '32038511180',
    '15138511003',
    '75038511181',
    '1503851236',
  ])('refuses %s', (value) => {
    expect(personNumberKind(value)).toBeUndefined();
  });

  it('checks account numbers with mod 11', () => {
    expect(isAccountNumber('8601.11.17947')).toBe(true);
    expect(isAccountNumber('1234 56 78903')).toBe(true);
    expect(isAccountNumber('86011117948')).toBe(false);
  });
});

describe('finding personal data in text', () => {
  const text =
    'Hei, jeg heter Kari og har fødselsnummer 15838510075. Ring meg på +47 912 34 567 eller skriv til kari.nordmann@example.no. Lønna går til 8601.11.17947, og diagnosen var F32.1. Saksnummer 2024/12345 og orgnr 991825827 er ikke personopplysninger.';

  it('finds each category it is asked for and nothing else', () => {
    expect(findPii(text, piiCategories).map((m) => [m.category, m.value])).toEqual([
      ['national-id', '15838510075'],
      ['phone', '+47 912 34 567'],
      ['email', 'kari.nordmann@example.no'],
      ['account-number', '8601.11.17947'],
      ['health', 'F32.1'],
    ]);
    expect(findPii(text, ['email']).map((m) => m.category)).toEqual(['email']);
  });

  it('never reports a valid national id as an account number or phone number', () => {
    expect(findPii('15838510075', ['account-number', 'phone'])).toEqual([]);
  });

  it('masks values reversibly with the same token each time', () => {
    const vault = createVault(['national-id', 'email']);
    const masked = vault.mask(`${text} Gjentar: 15838510075.`);

    expect(masked).not.toContain('15838510075');
    expect(masked).not.toContain('kari.nordmann@example.no');
    expect(masked.match(/«NATIONAL_ID_1»/g)).toHaveLength(2);
    expect(vault.unmask('Svar til «NATIONAL_ID_1» på «EMAIL_1».')).toBe(
      'Svar til 15838510075 på kari.nordmann@example.no.',
    );
    expect(vault.unmask('Ukjent «NATIONAL_ID_9»')).toBe('Ukjent «NATIONAL_ID_9»');
  });

  it('redacts deep inside objects and arrays', () => {
    expect(
      redactPii({ input: { parts: [{ text: 'fnr 15838510075' }] }, n: 3 }, ['national-id']),
    ).toEqual({ input: { parts: [{ text: 'fnr [REDACTED:national-id]' }] }, n: 3 });
  });
});
