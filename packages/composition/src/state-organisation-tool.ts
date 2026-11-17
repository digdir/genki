import { errorResult, type BuiltinTool, type ToolResult } from '@genai/port-tools';
import { z } from 'zod';
import type { ConfigEntryStore } from './config-store.js';
import { accountsSource, latestAccounts, ministryOn } from './state-accounts.js';
import { latestRegisterNames, type RegisterNames } from './state-register-names.js';
import {
  latestRegisterSync,
  ministryChain,
  registerSource,
  registerVersions,
  type RegisterUnit,
} from './state-register.js';

/** The platform's tool for the state's organisation, from the synced register (ADR 0058). */

export const stateOrganisationToolRef = 'state-organisation@1';

export interface StateOrganisationDeps {
  configEntries: ConfigEntryStore;
  /** The filter fields the calling service's datasets declare, by the service's capability id. */
  filterFields(capability: string | undefined): Promise<readonly string[]>;
}

/** The org-number fields a search can filter on (issue 620), in the order they are offered. */
export const orgNumberFields = ['owner_orgnr', 'recipient_orgnr'] as const;

const maxFound = 20;
/** A search takes at most 100 values per filter field. */
const maxFilterValues = 100;

const input = z.strictObject({
  action: z
    .enum(['under', 'over', 'find'])
    .describe(
      'under: the units under a unit (or the top units of the state); over: the units above a unit up to its ministry; find: units by name',
    ),
  unit: z
    .string()
    .regex(/^\d{9}$/, 'an org number is nine digits')
    .optional()
    .describe('The org number, for under and over; under without it lists the top units'),
  name: z.string().min(1).max(200).optional().describe('For find: a name or an abbreviation'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(3)
    .optional()
    .describe('For under: how many levels down, 1 (default) to 3'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD')
    .optional()
    .describe('The organisation on this date, YYYY-MM-DD; today when left out'),
});

type Input = z.infer<typeof input>;

interface Credit {
  nb: string;
  en: string;
  licence: string;
  source: string;
}

const licence = 'https://data.norge.no/nlod/no/2.0';
const nlod = (licensorNb: string, licensorEn: string, source: string): Credit => ({
  nb: `Inneholder data under norsk lisens for offentlige data (NLOD) tilgjengeliggjort av ${licensorNb}.`,
  en: `Contains data under the Norwegian licence for Open Government data (NLOD) distributed by ${licensorEn}.`,
  licence,
  source,
});
export const registerCredit = nlod(
  'Brønnøysundregistrene',
  'Brønnøysundregistrene',
  'https://data.brreg.no/enhetsregisteret/oppslag/enheter',
);
export const accountsCredit = nlod(
  'Direktoratet for forvaltning og økonomistyring (DFØ)',
  'the Norwegian Agency for Public and Financial Management (DFØ)',
  'https://statsregnskapet.dfo.no/',
);

const osloDay = (iso: string) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }).format(new Date(iso));
const norwegianDate = (day: string) => day.split('-').reverse().join('.');

/** Lower case, NFKC, and every run of other characters than letters and digits as one space. */
const fold = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const words = (text: string) => fold(text).split(' ').filter(Boolean);

interface Listed {
  orgnr: string;
  name: string;
  display?: string;
  abbreviation?: string;
  level?: number;
  parent?: string;
  units_under?: number;
}

interface View {
  units: RegisterUnit[];
  source: string;
  asOf: string;
  cite: { nb: string; en: string };
  credit: Credit;
}

const registerView = (units: RegisterUnit[], day: string): View => ({
  units,
  source: registerSource,
  asOf: day,
  cite: {
    nb: `Kilde: ${registerSource}, per ${norwegianDate(day)}.`,
    en: `Source: ${registerSource}, as of ${day}.`,
  },
  credit: registerCredit,
});

const accountsCite = (year: string) => ({
  nb: `Kilde: ${accountsSource} (DFØ), ${year}.`,
  en: `Source: ${accountsSource} (DFØ), ${year}.`,
});

class Refusal extends Error {}

export const stateOrganisationTool = (deps: StateOrganisationDeps): BuiltinTool<Input> => {
  /** The register on a date: the version then, or undefined before the first version. */
  const registerOn = async (date: string | undefined): Promise<View | undefined> => {
    const versions = await registerVersions(deps.configEntries);
    const latest = versions.at(-1);
    if (!latest) throw new Refusal('the state register is not synced yet');
    if (!date) {
      const sync = await latestRegisterSync(deps.configEntries);
      return registerView(latest.register.units, osloDay(sync?.lastGood ?? latest.at));
    }
    const end = `${date}T23:59:59.999Z`;
    const current = versions.filter((v) => v.at <= end).at(-1);
    return current ? registerView(current.register.units, osloDay(current.at)) : undefined;
  };

  const listed = (u: RegisterUnit, names: RegisterNames, children: Map<string, RegisterUnit[]>) => {
    const known = names[u.orgnr];
    return {
      orgnr: u.orgnr,
      name: u.name,
      ...(known?.display ? { display: known.display } : {}),
      ...(known?.abbreviation ? { abbreviation: known.abbreviation } : {}),
      ...(u.parent ? { parent: u.parent } : {}),
      units_under: children.get(u.orgnr)?.length ?? 0,
    };
  };

  const childrenOf = (units: RegisterUnit[]) => {
    const children = new Map<string, RegisterUnit[]>();
    for (const u of units)
      if (u.parent) children.set(u.parent, [...(children.get(u.parent) ?? []), u]);
    return children;
  };

  const under = async (args: Input, names: RegisterNames) => {
    const view = await registerOn(args.date);
    if (!view) return underFromAccounts(args, names);
    const children = childrenOf(view.units);
    const byOrgnr = new Map(view.units.map((u) => [u.orgnr, u]));
    const start = args.unit ? byOrgnr.get(args.unit) : undefined;
    if (args.unit && !start)
      throw new Refusal(`no unit ${args.unit} in the state register as of ${view.asOf}`);
    const depth = args.depth ?? 1;
    const units: Listed[] = [];
    let level = start
      ? (children.get(start.orgnr) ?? [])
      : view.units.filter((u) => u.form === 'STAT');
    for (let n = 1; n <= depth && level.length > 0; n += 1) {
      units.push(...level.map((u) => ({ ...listed(u, names, children), level: n })));
      level = level.flatMap((u) => children.get(u.orgnr) ?? []);
    }
    return { view, unit: start && listed(start, names, children), units };
  };

  const underFromAccounts = async (args: Input, names: RegisterNames) => {
    const year = (args.date ?? '').slice(0, 4);
    if (!args.unit)
      throw new Refusal(`the top units are known only from the register's first version on`);
    const accounts = await latestAccounts(deps.configEntries, `year-${year}`);
    if (!accounts) throw new Refusal(`no state register or state accounts for ${year}`);
    const ministries = new Set(Object.values(accounts.ministries));
    if (!ministries.has(args.unit))
      throw new Refusal(
        `${args.unit} is not a ministry in the state accounts for ${year}; before the register, only a ministry's agencies are known`,
      );
    const unit = accounts.agencies.find((a) => a.orgnr === args.unit);
    const units: Listed[] = [];
    for (const a of accounts.agencies) {
      if (a.ministry !== args.unit || a.orgnr === args.unit) continue;
      const known = names[a.orgnr];
      const top = await ministryOn(deps.configEntries, a.orgnr, new Date(`${args.date}T12:00:00Z`));
      if (top?.orgnr !== args.unit) continue;
      units.push({
        orgnr: a.orgnr,
        name: a.name,
        ...(known?.display ? { display: known.display } : {}),
        ...(known?.abbreviation ? { abbreviation: known.abbreviation } : {}),
        level: 1,
        parent: args.unit,
      });
    }
    return {
      view: {
        units: [],
        source: accountsSource,
        asOf: year,
        cite: accountsCite(year),
        credit: accountsCredit,
      } satisfies View,
      unit: { orgnr: args.unit, name: unit?.name ?? args.unit },
      units,
      note: `From the state accounts for ${year}: one level only, the agencies booked to this ministry. Bodies of Stortinget, SMK, the courts and Sametinget are not in them.`,
    };
  };

  const over = async (args: Input, names: RegisterNames) => {
    if (!args.unit) throw new Refusal('over needs the unit org number');
    const view = await registerOn(args.date);
    if (!view) {
      const ministry = await ministryOn(
        deps.configEntries,
        args.unit,
        new Date(`${args.date}T12:00:00Z`),
      );
      if (!ministry) throw new Refusal(`no ministry for ${args.unit} on ${args.date}`);
      const year = ministry.asOf;
      const accounts = await latestAccounts(deps.configEntries, `year-${year}`);
      const nameOf = (orgnr: string) =>
        accounts?.agencies.find((a) => a.orgnr === orgnr)?.name ?? orgnr;
      return {
        view: {
          units: [],
          source: accountsSource,
          asOf: year,
          cite: accountsCite(year),
          credit: accountsCredit,
        } satisfies View,
        unit: { orgnr: args.unit, name: nameOf(args.unit) },
        units: [{ orgnr: ministry.orgnr, name: nameOf(ministry.orgnr), level: 1 }],
        note: `From the state accounts for ${year}: the ministry the agency was booked to, without the levels between.`,
      };
    }
    const chain = ministryChain(view.units, args.unit);
    const [unit, ...above] = chain;
    if (!unit)
      throw new Refusal(`no unit ${args.unit} under the state in the register as of ${view.asOf}`);
    const children = childrenOf(view.units);
    return {
      view,
      unit: listed(unit, names, children),
      units: above.map((u, i) => ({ ...listed(u, names, children), level: i + 1 })),
    };
  };

  const find = async (args: Input, names: RegisterNames) => {
    if (!args.name) throw new Refusal('find needs a name');
    const view = await registerOn(args.date);
    if (!view) throw new Refusal('find works from the register, which starts on its first version');
    const query = fold(args.name);
    const asked = [...new Set(words(args.name))];
    const children = childrenOf(view.units);
    const namesOf = (u: RegisterUnit) =>
      [u.name, names[u.orgnr]?.display, names[u.orgnr]?.abbreviation].filter(
        (n): n is string => typeof n === 'string' && n.length > 0,
      );
    const exact = view.units.filter((u) => namesOf(u).some((n) => fold(n) === query));
    const partial =
      exact.length > 0 || asked.length === 0
        ? []
        : view.units.filter((u) => {
            const own = namesOf(u).flatMap(words);
            return asked.every((w) => own.some((o) => o.startsWith(w)));
          });
    const found = exact.length > 0 ? exact : partial;
    const units = found.slice(0, maxFound).map((u) => ({ ...listed(u, names, children) }));
    const note =
      found.length === 0
        ? 'No unit has this name. Old names are not matched: use the current name, its abbreviation or a shorter part of it.'
        : found.length > maxFound
          ? `${found.length} units match; the first ${maxFound} are listed. Use a longer name.`
          : undefined;
    return { view, units, ...(note ? { note } : {}) };
  };

  return {
    name: 'state-organisation',
    version: '1',
    description:
      "The Norwegian state's organisation from Enhetsregisteret (Brønnøysundregistrene), read every night: which units are under a ministry or agency (under), which units a unit is under up to its ministry (over), and units by name or abbreviation (find), each with its org number. under without a unit lists the state's top units: the ministries, SMK, Stortinget, Domstolene and Sametinget. Give date (YYYY-MM-DD) for the organisation on an earlier date. Find a unit's org number with find before under or over. When the answer has filter_values, pass them to search as filter_by to find the documents those units own. An answer that uses this tool ends with its cite line and its credit line, in the answer's language.",
    input,
    run: async (args, ctx): Promise<ToolResult> => {
      try {
        const names = (await latestRegisterNames(deps.configEntries)) ?? {};
        const result =
          args.action === 'under'
            ? await under(args, names)
            : args.action === 'over'
              ? await over(args, names)
              : await find(args, names);
        const declared = new Set(await deps.filterFields(ctx.capability));
        const values = [...new Set(result.units.map((u) => u.orgnr))].sort();
        const fields = orgNumberFields.filter((f) => declared.has(f));
        const filterValues =
          fields.length > 0 && values.length > 0 && values.length <= maxFilterValues
            ? Object.fromEntries(fields.map((f) => [f, values]))
            : undefined;
        const tooMany =
          fields.length > 0 && values.length > maxFilterValues
            ? `More than ${maxFilterValues} units: too many to filter a search on at once. Ask for a smaller part.`
            : undefined;
        const note = ['note' in result ? result.note : undefined, tooMany]
          .filter(Boolean)
          .join(' ');
        const answer = {
          source: result.view.source,
          as_of: result.view.asOf,
          cite: result.view.cite,
          credit: result.view.credit,
          ...('unit' in result && result.unit ? { unit: result.unit } : {}),
          units: result.units,
          ...(filterValues ? { filter_values: filterValues } : {}),
          ...(note ? { note } : {}),
        };
        return {
          parts: [
            {
              mime: 'application/json',
              body: { kind: 'json', json: answer },
              meta: { untrusted: true },
            },
          ],
        };
      } catch (error) {
        if (error instanceof Refusal) return errorResult(`state-organisation: ${error.message}`);
        throw error;
      }
    },
  };
};
