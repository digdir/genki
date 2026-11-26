/** A new draft's id, in the shape every new draft in the builder gets. */
export const newDraftId = () => `utkast-${crypto.randomUUID().slice(0, 8)}`;

/** The first of base, base-2, base-3 and so on that no service in the organisation has, archived ones too. */
export const freeServiceId = (base: string, taken: readonly string[]) => {
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
};
