/** One value a field can take, as the platform's facets give it (`/api/facets`, `options[]`). */
export interface FilterOption {
  /** What the filter holds and sends. */
  value: string;
  /** What the reader sees. The value when absent. */
  label?: string | undefined;
  /** Documents with this value, given the other fields. Not shown when absent: no count beats a
   * wrong one. */
  count?: number | undefined;
}

/** One field: a dataset's filter field (`/api/datasets/{id}`, `filters[]`) with its facet values. */
export interface FilterField {
  /** The dataset's field id, as in `filters[].field`. */
  id: string;
  /** The field's name as a plural noun, «Dokumenttyper». It is lower-cased inside sentences. */
  label: string;
  /** `year` lets `yearPeriods` draw the field as periods. */
  kind?: 'year' | undefined;
  options: readonly FilterOption[];
}

/** What the reader chose, per field id. An empty or absent list is no narrowing on that field,
 * never «nothing». */
export type FilterSelection = Readonly<Record<string, readonly string[]>>;
