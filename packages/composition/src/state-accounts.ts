import { createInflateRaw, crc32 } from 'node:zlib';
import { appendVersion, platformScope, type ConfigEntryStore } from './config-store.js';
import {
  ministryChain,
  registerSource,
  registerVersions,
  latestRegister,
} from './state-register.js';
import type { GuardedRequest } from './exchange-rates.js';

/**
 * DFØ's state accounts (statsregnskapet, NLOD 2.0) book every state agency to the ministry it
 * belongs to (`Fagdepartement_Virksomhet`). They check the register each month and give the
 * ministry for each year before genki's first sync (ADR 0058).
 */

export interface AccountsAgency {
  orgnr: string;
  name: string;
  /** The org number of the ministry the agency is booked to, when that ministry has its own row. */
  ministry?: string;
}

export interface AccountsEntry {
  /** The last period in the file, such as 202212 for a year or 202609 for the latest month. */
  period: string;
  /** The accounts' ministry code, such as 15, to the ministry's org number. */
  ministries: Record<string, string>;
  agencies: AccountsAgency[];
}

export interface AccountsCheck {
  period: string;
  /** Org numbers of agencies booked to another ministry than the register gives. */
  mismatches: string[];
}

export type ComparisonKind = 'same' | 'mismatch' | 'budget-booking' | 'not-in-register';

export interface ComparisonRow {
  orgnr: string;
  name: string;
  kind: ComparisonKind;
  /** The top unit the register gives: a ministry, or Stortinget, SMK, the courts, Sametinget. */
  registerMinistry?: string;
  accountsMinistry?: string;
}

export const accountsKind = 'state-accounts';
const checkKind = 'state-register-check';
const checkId = 'accounts';
const worker = 'worker';
export const accountsSource = 'Statsregnskapet';

export const accountsHost = { host: 'statsregnskapet.dfo.no', port: 443 };
export const accountsYearUrl = (year: number) =>
  `https://statsregnskapet.dfo.no/nedlasting/statsregnskapet_aar_${year}.zip`;
export const accountsMonthUrl =
  'https://statsregnskapet.dfo.no/nedlasting/statsregnskapet_siste_maaned.zip';
/** The first year DFØ publishes a yearly file for. */
export const firstAccountsYear = 2014;

/** A year's CSV is about 130 MB; anything far larger is not the file we expect. */
const maxUnpackedBytes = 1024 * 1024 * 1024;
const maxPackedBytes = 64 * 1024 * 1024;

/** Where the one entry of a zip lies, read from its central directory. */
const zipEntry = (zip: Uint8Array) => {
  const view = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = view.length - 22; i >= Math.max(0, view.length - 22 - 0xffff); i -= 1)
    if (view.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error('the accounts file is not a zip');
  const central = view.readUInt32LE(end + 16);
  if (central + 46 > view.length || view.readUInt32LE(central) !== 0x02014b50)
    throw new Error('the accounts zip has no central directory');
  const method = view.readUInt16LE(central + 10);
  const crc = view.readUInt32LE(central + 16);
  const packed = view.readUInt32LE(central + 20);
  const local = view.readUInt32LE(central + 42);
  if (local + 30 > view.length || view.readUInt32LE(local) !== 0x04034b50)
    throw new Error('the accounts zip has no file entry');
  const start = local + 30 + view.readUInt16LE(local + 26) + view.readUInt16LE(local + 28);
  if (start + packed > view.length) throw new Error('the accounts zip is cut short');
  if (method !== 8 && method !== 0) throw new Error(`the accounts zip uses compression ${method}`);
  return { method, crc, data: view.subarray(start, start + packed) };
};

/** The zip's one CSV, inflated piece by piece, so a year's 130 MB never sit in memory at once. */
async function* unzippedChunks(zip: Uint8Array): AsyncIterable<Buffer> {
  const entry = zipEntry(zip);
  let size = 0;
  let crc = 0;
  const check = (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxUnpackedBytes) throw new Error('the accounts file is larger than expected');
    crc = crc32(chunk, crc);
    return chunk;
  };
  if (entry.method === 0) yield check(Buffer.from(entry.data));
  else {
    const inflate = createInflateRaw();
    inflate.end(entry.data);
    for await (const chunk of inflate) yield check(chunk as Buffer);
  }
  if (crc >>> 0 !== entry.crc >>> 0) throw new Error('the accounts file failed its checksum');
}

/** One line of the accounts' CSV: `;` between fields, each in quotes, `""` for a quote. */
export const csvFields = (line: string): string[] => {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ';') {
      fields.push(field);
      field = '';
    } else field += c;
  }
  fields.push(field);
  return fields;
};

/**
 * Reads the CSV inside a zip down to each agency's ministry and the last period. A ministry's code
 * maps to the org number of the row named as the code is; a ministry renamed during the year keeps
 * its old name on its own row, so then the code maps to the org number `known` gives it, as the
 * latest month does, when a row under the code has it.
 */
export const readAccountsZip = async (
  zip: Uint8Array,
  known: Record<string, string> = {},
): Promise<AccountsEntry> => {
  const decoder = new TextDecoder('latin1');
  let columns: Record<string, number> | undefined;
  let rest = '';
  let period = '';
  const agencies = new Map<string, { name: string; code: string }>();
  const codeNames = new Map<string, string>();
  const take = (line: string) => {
    if (line.trim() === '') return;
    const fields = csvFields(line);
    if (!columns) {
      columns = Object.fromEntries(fields.map((f, i) => [f.trim(), i]));
      for (const name of [
        'Periode',
        'Fagdepartement_Virksomhet_id',
        'Fagdepartement_Virksomhet',
        'Virksomhet_id',
        'Virksomhet',
      ])
        if (columns[name] === undefined) throw new Error(`the accounts file has no ${name} column`);
      return;
    }
    const at = (name: string) => (fields[columns?.[name] ?? -1] ?? '').trim();
    const orgnr = at('Virksomhet_id');
    const code = at('Fagdepartement_Virksomhet_id');
    if (at('Periode') > period) period = at('Periode');
    if (code) codeNames.set(code, at('Fagdepartement_Virksomhet'));
    if (/^\d{9}$/.test(orgnr) && code) agencies.set(orgnr, { name: at('Virksomhet'), code });
  };
  for await (const chunk of unzippedChunks(zip)) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) take(line);
  }
  take(rest + decoder.decode());
  if (!columns || agencies.size === 0) throw new Error('the accounts file has no agencies');
  // A ministry is booked to itself: its own row gives the org number behind its code.
  const ministries: Record<string, string> = {};
  for (const [orgnr, a] of agencies)
    if (a.name.toLowerCase() === codeNames.get(a.code)?.toLowerCase()) ministries[a.code] = orgnr;
  for (const [code, orgnr] of Object.entries(known))
    if (!ministries[code] && agencies.get(orgnr)?.code === code) ministries[code] = orgnr;
  return {
    period,
    ministries,
    agencies: [...agencies].map(([orgnr, a]) => ({
      orgnr,
      name: a.name,
      ...(ministries[a.code] ? { ministry: ministries[a.code] } : {}),
    })),
  };
};

const fetchZip = async (guard: GuardedRequest, url: string) => {
  const response = await guard.request([accountsHost], url, {
    method: 'GET',
    maxResponseBytes: maxPackedBytes,
    timeoutMs: 120_000,
  });
  if (response.status !== 200 || !response.bytes)
    throw new Error(`statsregnskapet.dfo.no answered HTTP ${response.status} for ${url}`);
  return response.bytes;
};

export const latestAccounts = async (
  configEntries: ConfigEntryStore,
  id: string,
): Promise<AccountsEntry | undefined> => {
  const versions = await configEntries.history(accountsKind, platformScope, id);
  const last = versions.at(-1);
  return last && !last.deleted ? (last.spec as AccountsEntry) : undefined;
};

const saveAccounts = (
  configEntries: ConfigEntryStore,
  id: string,
  entry: AccountsEntry,
  at: Date,
) =>
  appendVersion<AccountsEntry>(configEntries, {
    kind: accountsKind,
    scope: platformScope,
    id,
    spec: entry,
    deleted: false,
    by: worker,
    reason: `state accounts ${entry.period}: ${entry.agencies.length} agencies`,
    at: at.toISOString(),
  });

/** The years a sync reads: every year DFØ publishes a file for, this one included. */
export const accountYears = (now: Date) => {
  const years: number[] = [];
  for (let y = firstAccountsYear; y <= now.getUTCFullYear(); y += 1) years.push(y);
  return years;
};

/**
 * Reads the latest month, then each year not yet stored up to December, so a year read before DFØ
 * closed it is read again until it holds December; the month is kept when its period is new. A
 * file that cannot be read changes nothing that is stored.
 */
export const syncAccounts = async (deps: {
  configEntries: ConfigEntryStore;
  guard: GuardedRequest;
  now: () => Date;
  years?: number[];
}): Promise<{ ok: true; period: string } | { ok: false; error: string }> => {
  try {
    const month = await readAccountsZip(await fetchZip(deps.guard, accountsMonthUrl));
    for (const year of deps.years ?? accountYears(deps.now())) {
      const kept = await latestAccounts(deps.configEntries, `year-${year}`);
      if (kept?.period.endsWith('12')) continue;
      const entry = await readAccountsZip(
        await fetchZip(deps.guard, accountsYearUrl(year)),
        month.ministries,
      );
      if (kept?.period === entry.period) continue;
      await saveAccounts(deps.configEntries, `year-${year}`, entry, deps.now());
    }
    const stored = await latestAccounts(deps.configEntries, 'month');
    if (stored?.period !== month.period)
      await saveAccounts(deps.configEntries, 'month', month, deps.now());
    return { ok: true, period: month.period };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * A unit's ministry on a date: from the register version that was current then, or, before
 * genki's first sync, from that year's state accounts. A body the register places under a top
 * unit that is not one of the accounts' ministries (Stortinget, SMK, the courts, Sametinget) is
 * booked under a ministry for the budget only, so the accounts give no answer for it.
 */
export const ministryOn = async (
  configEntries: ConfigEntryStore,
  orgnr: string,
  date: Date,
): Promise<{ orgnr: string; source: string; asOf: string } | undefined> => {
  const versions = await registerVersions(configEntries);
  const when = date.toISOString();
  const first = versions[0];
  if (first && when >= first.at) {
    const current = versions.filter((v) => v.at <= when).at(-1) ?? first;
    const top = ministryChain(current.register.units, orgnr).at(-1);
    return top ? { orgnr: top.orgnr, source: registerSource, asOf: current.at } : undefined;
  }
  const year = date.getUTCFullYear();
  const accounts = await latestAccounts(configEntries, `year-${year}`);
  const ministry = accounts?.agencies.find((a) => a.orgnr === orgnr)?.ministry;
  if (!accounts || !ministry) return undefined;
  // A ministry then or now: DFD did not exist in 2022, but it is one of today's ministries.
  const ministries = new Set([
    ...Object.values(accounts.ministries),
    ...Object.values((await latestAccounts(configEntries, 'month'))?.ministries ?? {}),
  ]);
  const registerTop = ministryChain(versions.at(-1)?.register.units ?? [], orgnr).at(-1)?.orgnr;
  if (registerTop && !ministries.has(registerTop)) return undefined;
  return { orgnr: ministry, source: accountsSource, asOf: String(year) };
};

/**
 * Each agency in the latest month of the accounts against the register. A body whose register
 * top is not one of the accounts' ministries (Stortinget, SMK, the courts, Sametinget) is booked
 * under a ministry for the budget only.
 */
export const compareWithAccounts = async (
  configEntries: ConfigEntryStore,
): Promise<ComparisonRow[] | undefined> => {
  const register = await latestRegister(configEntries);
  const month = await latestAccounts(configEntries, 'month');
  if (!register || !month) return undefined;
  const ministries = new Set(Object.values(month.ministries));
  return month.agencies
    .filter((a) => !ministries.has(a.orgnr))
    .map((a): ComparisonRow => {
      const top = ministryChain(register.units, a.orgnr).at(-1)?.orgnr;
      const kind: ComparisonKind =
        top === undefined
          ? 'not-in-register'
          : top === a.ministry
            ? 'same'
            : ministries.has(top)
              ? 'mismatch'
              : 'budget-booking';
      return {
        orgnr: a.orgnr,
        name: a.name,
        kind,
        ...(top ? { registerMinistry: top } : {}),
        ...(a.ministry ? { accountsMinistry: a.ministry } : {}),
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name, 'nb'));
};

/** Compares a new month once, and tells of each mismatch only the first month it appears. */
export const checkAgainstAccounts = async (deps: {
  configEntries: ConfigEntryStore;
  now: () => Date;
  onMismatch?: (rows: ComparisonRow[]) => void;
}): Promise<void> => {
  const rows = await compareWithAccounts(deps.configEntries);
  const month = await latestAccounts(deps.configEntries, 'month');
  if (!rows || !month) return;
  const previous = (await deps.configEntries.history(checkKind, platformScope, checkId)).at(-1)
    ?.spec as AccountsCheck | undefined;
  if (previous?.period === month.period) return;
  const mismatches = rows.filter((r) => r.kind === 'mismatch');
  const known = new Set(previous?.mismatches ?? []);
  const fresh = mismatches.filter((r) => !known.has(r.orgnr));
  await appendVersion<AccountsCheck>(deps.configEntries, {
    kind: checkKind,
    scope: platformScope,
    id: checkId,
    spec: { period: month.period, mismatches: mismatches.map((r) => r.orgnr) },
    deleted: false,
    by: worker,
    reason: `checked the register against the state accounts for ${month.period}`,
    at: deps.now().toISOString(),
  });
  if (fresh.length > 0) deps.onMismatch?.(fresh);
};
