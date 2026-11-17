import { describe, expect, it } from 'vitest';
import { InMemoryConfigEntryStore } from './config-store.js';
import type { GuardedRequest } from './exchange-rates.js';
import { brregUnitsUrl, syncRegister } from './state-register.js';
import {
  latestRegisterNames,
  syncRegisterNames,
  type KudosActorPages,
} from './state-register-names.js';

const page = (units: object[]) =>
  JSON.stringify({
    _embedded: { enheter: units },
    page: { totalElements: units.length, totalPages: 1 },
  });
const guard: GuardedRequest = {
  request: async (_allow, url) => ({
    status: 200,
    body:
      url === brregUnitsUrl('STAT', 0)
        ? page([
            {
              organisasjonsnummer: '986252932',
              navn: 'FINANSDEPARTEMENTET',
              organisasjonsform: { kode: 'STAT' },
            },
          ])
        : page([
            {
              organisasjonsnummer: '986252931',
              navn: 'DIREKTORATET FOR FORVALTNING OG ØKONOMISTYRING',
              organisasjonsform: { kode: 'ORGL' },
              overordnetEnhet: '986252932',
            },
          ]),
  }),
};

/** Two pages of KUDOS's `/api/v0/actors`, shaped as kudos.dfo.no answers. */
const kudos: KudosActorPages = {
  actors: async (n) =>
    n === 1
      ? {
          data: [
            {
              org_number: 986252931,
              alternative_names: [
                { type: 'official', name: 'DIREKTORATET FOR FORVALTNING OG ØKONOMISTYRING' },
                { type: 'display', name: 'Direktoratet for forvaltning og økonomistyring' },
                { type: 'abbreviation', name: 'DFØ' },
                { type: 'registration_alias', name: 'Difi' },
                { type: 'previous', name: 'Senter for statlig økonomistyring' },
              ],
            },
          ],
          meta: { current_page: 1, last_page: 2 },
        }
      : {
          data: [
            {
              org_number: 994598759,
              alternative_names: [{ type: 'display', name: 'Equinor ASA' }],
            },
          ],
          meta: { current_page: 2, last_page: 2 },
        },
};

describe('the register names', () => {
  it('stores KUDOS display names and abbreviations by org number and leaves old names out', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const now = () => new Date('2026-11-17T01:50:00Z');
    await syncRegister({ configEntries, guard, now });

    await syncRegisterNames({ configEntries, kudos, now });

    expect(await latestRegisterNames(configEntries)).toEqual({
      '986252931': {
        display: 'Direktoratet for forvaltning og økonomistyring',
        abbreviation: 'DFØ',
      },
    });
  });
});
