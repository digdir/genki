export interface Profile {
  target: 'chunks' | 'phrases' | 'docs';
  mode: 'text' | 'vector' | 'hybrid';
  fields?: string[] | undefined;
}

/** The chunk of `<from>.doc` best matching the query words `<from>.tsv` lacks, else its first chunk. */
export const bestChunk = (query: string, from: string, dataset: string, generation: string) => {
  const ofDocument = `c.dataset = ${dataset} and c.generation = ${generation} and c.doc_id = ${from}.doc`;
  return `select b.id from (select coalesce(
     (select c.id from (select c.id, c.tsv, c.position from kn_chunks c where k.q is not null and ${ofDocument} offset 0) c
       where c.tsv @@ k.q order by ts_rank_cd(c.tsv, k.q) desc, c.position limit 1),
     (select c.id from kn_chunks c where ${ofDocument} order by c.position limit 1)) as id
   from (select replace(plainto_tsquery('simple', nullif(string_agg(w, ' '), ''))::text, ' & ', ' | ')::tsquery as q
     from unnest(tsvector_to_array(to_tsvector('simple', nullif(querytree(${query}), 'T')))) w
     where not w = any(tsvector_to_array(${from}.tsv))) k offset 0) b
   where b.id is not null`;
};

/** The most matches a text search ranks, so a common word does not rank a whole partition. */
export const textRankCap = 5000;

export const fieldsText = (fields: Record<string, unknown>) =>
  Object.values(fields)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .join(' ');
