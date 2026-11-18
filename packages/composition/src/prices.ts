import {
  isPerThousandPrice,
  perThousandView,
  priceUnits,
  unitNamePattern,
  unitPricesOfPerThousand,
  type ModelPrices,
  type PriceUnit,
  type UsagePrice,
} from '@genai/contracts';
import { operationKindPattern } from '@genai/port-model';
import { z } from 'zod';
import { appendVersion, platformScope, type ConfigEntryStore } from './config-store.js';

export const priceMigrationActor = 'genki';
export const priceMigrationReason =
  'ADR 0048: a price is per model and kind, per unit, in kroner per unit';

const unitPrices = z
  .object(
    Object.fromEntries(priceUnits.map((u) => [u, z.number().min(0).optional()])) as Record<
      PriceUnit,
      z.ZodOptional<z.ZodNumber>
    >,
  )
  .catchall(z.number().min(0))
  .superRefine((prices, ctx) => {
    for (const unit of Object.keys(prices))
      if (!unitNamePattern.test(unit))
        ctx.addIssue({
          code: 'custom',
          path: [unit],
          message: 'a unit is lowercase letters, digits and hyphens, as its descriptor names it',
        });
  });

/** A model's prices: kroner per unit, per operation kind. */
export const catalogPrice = z
  .record(z.string().regex(operationKindPattern), unitPrices)
  .refine((p) => Object.keys(p).length > 0, 'price at least one operation kind');

const perThousand = z.strictObject({
  inputPerThousand: z.number().min(0),
  outputPerThousand: z.number().min(0),
});

/** A price in the shape before ADR 0048 as unit prices for each of the model's kinds. */
export const pricesForKinds = (price: UsagePrice, kinds: readonly string[]): ModelPrices =>
  Object.fromEntries(
    (kinds.length > 0 ? kinds : ['chat']).map((k) => [k, unitPricesOfPerThousand(price)]),
  );

/** The open units each kind may price besides the built-in ones; a kind it does not list takes built-in units only. */
export type OpenUnits = (kind: string) => readonly string[] | undefined;

export type PriceCheck =
  { ok: true; spec: ModelPrices } | { ok: false; errors: { path: string; message: string }[] };

/** Checks a price, and reads one in the shape before ADR 0048 as prices for the model's kinds. */
export const checkedPrice = (
  spec: unknown,
  kinds: readonly string[],
  openUnits?: OpenUnits,
): PriceCheck => {
  if (isPerThousandPrice(spec)) {
    const legacy = perThousand.safeParse(spec);
    if (!legacy.success)
      return {
        ok: false,
        errors: legacy.error.issues.map((i) => ({
          path: ['spec', ...i.path].join('.'),
          message: i.message,
        })),
      };
    return { ok: true, spec: pricesForKinds(legacy.data, kinds) };
  }
  const parsed = catalogPrice.safeParse(spec);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        path: ['spec', ...i.path].join('.'),
        message: i.message,
      })),
    };
  if (openUnits) {
    const errors = Object.entries(parsed.data as ModelPrices).flatMap(([kind, prices]) => {
      const valid = [...priceUnits, ...(openUnits(kind) ?? [])] as string[];
      return Object.keys(prices)
        .filter((unit) => !valid.includes(unit))
        .map((unit) => ({
          path: ['spec', kind, unit].join('.'),
          message: `${unit} is not a unit that ${kind} reports for this model; valid units are ${valid.join(', ')}`,
        }));
    });
    if (errors.length > 0) return { ok: false, errors };
  }
  return { ok: true, spec: parsed.data as ModelPrices };
};

/** Every model's per-1,000-token price, the view runs and estimates read. */
export const perThousandPrices = (specs: Record<string, unknown>): Record<string, UsagePrice> =>
  Object.fromEntries(
    Object.entries(specs).flatMap(([id, spec]) => {
      const view = perThousandView(spec);
      return view ? [[id, view] as const] : [];
    }),
  );

export interface PriceMigrationInput {
  store: ConfigEntryStore;
  kindsOf: (model: string) => string[];
  now?: () => Date;
}

/** Moves stored per-1,000-token prices to prices per kind and unit; a no-op once done. */
export const migratePrices = async (input: PriceMigrationInput): Promise<number> => {
  const legacy = (await input.store.latest({ kind: 'price' })).filter(
    (e) => !e.deleted && isPerThousandPrice(e.spec),
  );
  const start = (input.now?.() ?? new Date()).getTime();
  let moved = 0;
  for (const entry of legacy) {
    await appendVersion(input.store, {
      kind: 'price',
      scope: entry.scope ?? platformScope,
      id: entry.id,
      spec: pricesForKinds(entry.spec as UsagePrice, input.kindsOf(entry.id)),
      deleted: false,
      by: priceMigrationActor,
      reason: priceMigrationReason,
      at: new Date(start + moved).toISOString(),
    });
    moved += 1;
  }
  return moved;
};
