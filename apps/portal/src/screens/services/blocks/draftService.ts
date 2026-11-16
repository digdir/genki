import type { PlaygroundOptions, PlaygroundSetup } from '../../../api/playground';

/** What the try view runs: a draft, or without one the playground's own first setup. */
export interface DraftSource {
  definition?: Record<string, unknown> | undefined;
  files?: Record<string, string> | undefined;
}

/** The service id the try view names: the draft's own, or the playground's. */
export const draftServiceOf = (source: DraftSource | undefined) => {
  const id = (source?.definition?.metadata as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' && id ? id : 'playground';
};

/** The playground's setup as a definition, so its facts are read as a draft's are. */
export const playgroundDefinition = (
  options: PlaygroundOptions,
  setup: PlaygroundSetup,
  tenant: string,
  name?: string,
): Record<string, unknown> => ({
  metadata: {
    id: draftServiceOf(undefined),
    name: options.services.find((s) => s.id === setup.service?.id)?.name ?? name ?? 'playground',
    tenant,
  },
  spec: {
    output: { kind: setup.output === 'fields' ? 'fields' : 'answer' },
    exposure: { chat: setup.output !== 'fields' },
    knowledge: { datasets: setup.datasets.map((dataset) => ({ dataset })) },
  },
});

/** Why the playground did not run the draft: what it lacks, or the platform's reason. */
export interface RunProblem {
  title: string;
  detail?: string | undefined;
  errors: readonly { path: string; message: string }[];
}
