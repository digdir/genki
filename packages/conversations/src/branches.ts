export interface BranchNode {
  id: string;
  parentId?: string;
  created: number;
}

export const activeBranch = <T extends BranchNode>(messages: T[]): T[] => {
  if (!messages.some((m) => m.parentId !== undefined)) return messages;
  const byId = new Map(messages.map((m) => [m.id, m]));
  const parents = new Set(messages.flatMap((m) => (m.parentId ? [m.parentId] : [])));
  let leaf: T | undefined;
  for (const m of messages)
    if (!parents.has(m.id) && (!leaf || m.created >= leaf.created)) leaf = m;
  const chain: T[] = [];
  const seen = new Set<string>();
  for (
    let at = leaf;
    at && !seen.has(at.id);
    at = at.parentId ? byId.get(at.parentId) : undefined
  ) {
    seen.add(at.id);
    chain.unshift(at);
  }
  return chain;
};

export const activeLeaf = <T extends BranchNode>(messages: T[]): T | undefined =>
  activeBranch(messages).at(-1);
