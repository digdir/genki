import type { ChosenValue } from './FilterStates.js';
import type { FilterField, FilterSelection } from './types.js';

const keysOf = (a: FilterSelection, b: FilterSelection) =>
  new Set([...Object.keys(a), ...Object.keys(b)]);

/** Whether two selections hold the same values, in any order. An absent field is an empty one. */
export const sameSelection = (a: FilterSelection, b: FilterSelection) =>
  [...keysOf(a, b)].every((field) => {
    const left = new Set(a[field] ?? []);
    const right = new Set(b[field] ?? []);
    return left.size === right.size && [...left].every((value) => right.has(value));
  });

/** Whether anything is chosen in any field. */
export const isEmptySelection = (selection: FilterSelection) =>
  Object.values(selection).every((values) => values.length === 0);

/** Every chosen value, in the selection's order, with its label where a field lists it. */
export const chosenValues = (
  selection: FilterSelection,
  fields: readonly FilterField[] | undefined,
): ChosenValue[] =>
  Object.entries(selection).flatMap(([field, values]) => {
    const options = fields?.find((candidate) => candidate.id === field)?.options;
    return values.map((value) => ({
      field,
      value,
      label: options?.find((option) => option.value === value)?.label,
    }));
  });

/** The chosen values no field on screen can show, which a stored filter may still hold. */
export const valuesWithoutField = (
  selection: FilterSelection,
  fields: readonly FilterField[] | undefined,
): ChosenValue[] =>
  chosenValues(selection, fields).filter(
    (chosen) => !fields?.some((field) => field.id === chosen.field),
  );

/** What a question is asked with: a field with every listed value ticked is left out. */
export const narrowing = (
  selection: FilterSelection,
  fields: readonly FilterField[] | undefined,
): FilterSelection => {
  let changed = false;
  const asked: Record<string, readonly string[]> = { ...selection };
  for (const field of fields ?? []) {
    const chosen = selection[field.id] ?? [];
    if (field.options.length === 0 || chosen.length === 0) continue;
    const ticked = new Set(chosen);
    if (field.options.every((option) => ticked.has(option.value))) {
      asked[field.id] = [];
      changed = true;
    }
  }
  return changed ? asked : selection;
};
