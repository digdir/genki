import type { InvocationContext } from '@genai/kernel';
import { untrustedData, type ToolSpec } from '@genai/port-model';

/** The built-in tool that tells the model facts about the service and this run (ADR 0068). */
export const serviceFactsToolRef = 'service-facts@1';

export const isServiceFactsRef = (ref: string) => ref === serviceFactsToolRef;

export interface ServiceFactsQuery {
  /** The organisation that owns the service, from the capability, never from the input. */
  tenant: string;
  capability: string;
  version: number;
  /** The main model's id, for the lookup only; the model never sees it. */
  model: string;
}

/** What only the platform knows. Each field is left out when it is not recorded. */
export interface ServiceFactsFound {
  organisation?: string | undefined;
  /** A readable name and maker, never an endpoint or deployment name. */
  model?: { name: string; maker?: string | undefined } | undefined;
  published?: string | undefined;
  /** The run is not a published version: a draft tried in the playground, the builder or an eval. */
  draft?: boolean | undefined;
  /** The service's latest published version. */
  latest?: number | undefined;
}

export type ServiceFactsLookup = (
  query: ServiceFactsQuery,
  signal: AbortSignal,
) => Promise<ServiceFactsFound>;

export const serviceFactsTool: ToolSpec = {
  name: 'service_facts',
  description:
    'Facts about this service and this run: its name and owner organisation, the version this run uses and when it was published, the environment (such as test or production), the main model, the answer languages, the file types it accepts and its risk class. Use it when the user asks about the service itself, such as which model it uses, which version it is or whether it is the test version.',
  parameters: { type: 'object', properties: {} },
};

const languageNames: Record<string, string> = {
  nb: 'Norwegian bokmål',
  nn: 'Norwegian nynorsk',
  en: 'English',
};

const notRecorded = 'not recorded';

const osloDay = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? notRecorded
    : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }).format(at);
};

const environmentUnnamed = (version: number, latest: number | undefined) =>
  latest === undefined
    ? 'none named'
    : latest === version
      ? 'none named: this run uses the latest published version'
      : `none named: this run uses version ${version}; the latest published version is ${latest}`;

export const runServiceFacts = async (
  ctx: InvocationContext,
  lookup: ServiceFactsLookup,
  main: { model: string; languages: readonly string[] },
): Promise<{ content: string; ok: boolean }> => {
  const version = Number(ctx.capability.version);
  try {
    const found = await lookup(
      { tenant: ctx.capability.tenant, capability: ctx.capability.id, version, model: main.model },
      ctx.signal,
    );
    const report = {
      service: ctx.capability.title,
      organisation: found.organisation ?? notRecorded,
      ...(found.draft
        ? {
            version: 'an unpublished draft',
            published: 'not published',
            environment: 'none: this is a trial run of a draft, not a published version',
          }
        : {
            version,
            published: found.published ? osloDay(found.published) : notRecorded,
            environment: ctx.service.environment ?? environmentUnnamed(version, found.latest),
          }),
      main_model: found.model
        ? { name: found.model.name, ...(found.model.maker ? { maker: found.model.maker } : {}) }
        : notRecorded,
      languages: main.languages.map((l) => languageNames[l] ?? l),
      accepts: ctx.capability.accepts,
      risk_class: ctx.capability.oversight.riskClass,
      human_approval: ctx.capability.oversight.interrupts,
    };
    return {
      content: untrustedData('service-facts', JSON.stringify(report, null, 1)),
      ok: true,
    };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return { content: 'Error executing service_facts: the facts could not be read.', ok: false };
  }
};
