import type { DefinitionStore } from '@genai/definitions';
import type { ModelDescription } from '@genai/port-model';
import type { ServiceFactsLookup } from '@genai/strategy-agent-loop';

export interface ServiceFactsDeps {
  definitions: () => Pick<DefinitionStore, 'get'> | undefined;
  models: () => ModelDescription[];
  organisationName?: ((tenant: string) => Promise<string | undefined>) | undefined;
  /** A readable name and maker; by default the model's family, never its deployment. */
  modelName?:
    | ((model: ModelDescription) => { name: string; maker?: string | undefined } | undefined)
    | undefined;
}

const unless = <T>(found: Promise<T> | undefined) =>
  found ? found.catch(() => undefined) : Promise.resolve(undefined);

const familyName = (model: ModelDescription) =>
  model.family ? { name: model.family, ...(model.maker ? { maker: model.maker } : {}) } : undefined;

/** A published service's capability id is `<tenant>/<service>/<variant>`; drafts and evals are not. */
const publishedService = (capability: string, tenant: string) => {
  const parts = capability.split('/');
  return parts.length === 3 && parts[0] === tenant && parts[1] ? parts[1] : undefined;
};

/**
 * What service-facts@1 tells about a run that the run does not carry itself (ADR 0068): the owner
 * organisation's name, whether the run is a published version, when it was published, the latest
 * published version and the main model's readable name. Never who published or why, and never the
 * model's endpoint or deployment name.
 */
export const serviceFactsLookup =
  (deps: ServiceFactsDeps): ServiceFactsLookup =>
  async (query) => {
    const service = publishedService(query.capability, query.tenant);
    const store = deps.definitions();
    // A fact that cannot be read is left out, and the tool says it is not recorded.
    const [organisation, used, latest] = await Promise.all([
      unless(deps.organisationName?.(query.tenant)),
      unless(service ? store?.get('Service', query.tenant, service, query.version) : undefined),
      unless(service ? store?.get('Service', query.tenant, service) : undefined),
    ]);
    const model = deps.models().find((m) => m.id === query.model);
    return {
      organisation,
      draft: !service,
      published: used ? used.publishedAt : undefined,
      latest: latest ? latest.version : undefined,
      model: model && (deps.modelName ?? familyName)(model),
    };
  };
