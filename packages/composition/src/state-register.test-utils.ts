import { crc32, deflateRawSync } from 'node:zlib';
import { accountsMonthUrl } from './state-accounts.js';
import { brregUnitsUrl } from './state-register.js';

/** One file's worth of zip: one deflated entry, as statsregnskapet.dfo.no serves its CSV. */
export const zipOf = (name: string, text: string) => {
  const data = Buffer.from(text, 'latin1');
  const packed = deflateRawSync(data);
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(0, 42);
  const centralAt = local.length + fileName.length + packed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(centralAt, 16);
  return new Uint8Array(Buffer.concat([local, fileName, packed, central, fileName, end]));
};

const brregPage = (units: object[]) =>
  JSON.stringify({
    _embedded: { enheter: units },
    page: { totalElements: units.length, totalPages: 1 },
  });
const unit = (orgnr: string, navn: string, kode: string, parent?: string) => ({
  organisasjonsnummer: orgnr,
  navn,
  organisasjonsform: { kode },
  ...(parent ? { overordnetEnhet: parent } : {}),
});

/** Three ministries, Stortinget and three units under them, as data.brreg.no answers. */
export const registerFixture: Record<string, string> = {
  [brregUnitsUrl('STAT', 0)]: brregPage([
    unit('932384469', 'DIGITALISERINGS- OG FORVALTNINGSDEPARTEMENTET (DFD)', 'STAT'),
    unit('972417807', 'FINANSDEPARTEMENTET', 'STAT'),
    unit('972417858', 'KOMMUNAL- OG DISTRIKTSDEPARTEMENTET', 'STAT'),
    unit('971524960', 'STORTINGET', 'STAT'),
  ]),
  [brregUnitsUrl('ORGL', 0)]: brregPage([
    unit('991825827', 'DIGITALISERINGSDIREKTORATET', 'ORGL', '932384469'),
    unit('974761076', 'SKATTEETATEN', 'ORGL', '972417807'),
    unit('974760223', 'RIKSREVISJONEN', 'ORGL', '971524960'),
  ]),
};

const header =
  '"År";"Periode";"Konto_no";"Fagdepartement_id";"Fagdepartement";"Fagdepartement_Virksomhet_id";"Fagdepartement_Virksomhet";"Virksomhet_id";"Virksomhet";"Beløp"';
export const accountsRow = (
  period: string,
  code: string,
  ministry: string,
  orgnr: string,
  name: string,
) =>
  `"${period.slice(0, 4)}";"${period}";"1";"${code}";"${ministry}";"${code}";"${ministry}";"${orgnr}";"${name}";"100"`;
export const accountsCsv = (rows: string[]) => [header, ...rows].join('\r\n') + '\r\n';

const dfd = ['15', 'Digitaliserings- og forvaltningsdepartementet'] as const;
const fin = ['16', 'Finansdepartementet'] as const;
const kdd = ['05', 'Kommunal- og distriktsdepartementet'] as const;

/** Sept 2026: Riksrevisjonen booked under FIN for the budget; Skatteetaten booked under KDD. */
export const month202609 = accountsCsv([
  accountsRow('202609', ...dfd, '932384469', 'Digitaliserings- og forvaltningsdepartementet'),
  accountsRow('202609', ...dfd, '991825827', 'Digitaliseringsdirektoratet'),
  accountsRow('202609', ...fin, '972417807', 'Finansdepartementet'),
  accountsRow('202609', ...fin, '974760223', 'Riksrevisjonen'),
  accountsRow('202609', ...kdd, '972417858', 'Kommunal- og distriktsdepartementet'),
  accountsRow('202609', ...kdd, '974761076', 'Skatteetaten'),
]);

export const accountsMonthFixture: Record<string, Uint8Array> = {
  [accountsMonthUrl]: zipOf('statsregnskapet_siste_maaned.csv', month202609),
};
