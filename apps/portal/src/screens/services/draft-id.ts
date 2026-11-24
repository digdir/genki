/** A new draft's id, in the shape every new draft in the builder gets. */
export const newDraftId = () => `utkast-${crypto.randomUUID().slice(0, 8)}`;
