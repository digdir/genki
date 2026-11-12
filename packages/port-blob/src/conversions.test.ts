import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { settingsHash } from './conversions.js';

describe('settingsHash', () => {
  it('the settings hash is the sha256 of the settings as canonical JSON, whatever their key order', () => {
    const a = settingsHash({
      ocr: 'tesseract',
      lang: 'nor',
      table: { mode: 'accurate', cells: true },
    });
    const b = settingsHash({
      table: { cells: true, mode: 'accurate' },
      lang: 'nor',
      ocr: 'tesseract',
    });
    expect(a).toBe(b);
    expect(a).toBe(
      createHash('sha256')
        .update('{"lang":"nor","ocr":"tesseract","table":{"cells":true,"mode":"accurate"}}')
        .digest('hex'),
    );
    expect(settingsHash({ lang: ['no', 'en'] })).not.toBe(settingsHash({ lang: ['en', 'no'] }));
  });
});
