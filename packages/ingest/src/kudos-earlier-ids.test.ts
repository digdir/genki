import { describe, expect, it } from 'vitest';
import { checkEarlierId, earlierIdsByDocument, resolveByFiles } from './kudos-earlier-ids.js';

const live = {
  uuid: 'de77ffc7-1a57-456a-af49-167e699a4e6e',
  files: [
    { uuid: 'f1', url: 'https://kudos.dfo.no/dokument/de77ffc7/filer/f1.pdf', sha256: 'aaa' },
    { uuid: 'f2', url: 'https://kudos.dfo.no/dokument/de77ffc7/filer/f2.pdf', sha256: 'bbb' },
  ],
};

describe('earlier Kudos ids', () => {
  it('the earlier-ids map keeps an id only when a file sha256 matches', () => {
    expect(checkEarlierId({ sha256: ['bbb'] }, live)).toEqual({
      uuid: 'de77ffc7-1a57-456a-af49-167e699a4e6e',
    });
    expect(checkEarlierId({ sha256: ['ccc'] }, live)).toEqual({
      reason: 'no file sha256 in common with de77ffc7-1a57-456a-af49-167e699a4e6e',
    });
    expect(checkEarlierId({ sha256: [] }, live)).toEqual({
      reason: "no file sha256 in today's index",
    });
  });

  it('an earlier id whose redirect fails resolves by its file sha256 when one live document has it', () => {
    const live = [
      { uuid: 'u1', files: [{ url: 'a', sha256: 'aaa' }] },
      { uuid: 'u2', files: [{ url: 'b', sha256: 'bbb' }] },
      { uuid: 'u3', files: [{ url: 'c', sha256: 'bbb' }] },
    ];

    expect(resolveByFiles({ sha256: ['aaa'] }, live)).toEqual({ uuid: 'u1' });
    expect(resolveByFiles({ sha256: ['bbb'] }, live)).toEqual({
      reason: 'its file sha256 is on several live documents: u2, u3',
    });
    expect(resolveByFiles({ sha256: ['ccc'] }, live)).toEqual({
      reason: 'no redirect, and no live document has its file sha256',
    });
  });

  it('lists the earlier ids of each document under its kudos: id', () => {
    const byDocument = earlierIdsByDocument({
      ids: { '377252': 'de77ffc7', '95': 'a2b1' },
      byFile: { '96': 'a2b1', '116': '00701c3b' },
      unresolved: { '23790': 'HTTP 404' },
    });

    expect(byDocument.get('kudos:de77ffc7')).toEqual(['377252']);
    expect(byDocument.get('kudos:a2b1')).toEqual(['95', '96']);
    expect(byDocument.get('kudos:00701c3b')).toEqual(['116']);
    expect(byDocument.size).toBe(3);
  });
});
