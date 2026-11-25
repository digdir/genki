import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const steps = ['add', 'certificate', 'enable', 'unbind', 'done'] as const;
export type Step = (typeof steps)[number];

export interface WorkItem {
  id: string;
  hostname: string;
  apex: boolean;
  action: 'bind' | 'remove';
  step: Step;
  zone?: string;
  recordName?: string;
}

export interface StepResult {
  step: Step;
  ok: boolean;
  message?: string;
  certificateId?: string;
}

export interface BinderConfig {
  apiUrl: string;
  subscriptionId: string;
  resourceGroup: string;
  appName: string;
  environmentName: string;
  dnsZone: string;
  reserved: string[];
}

export type TokenSource = (resource: string) => Promise<string>;
type Fetch = typeof fetch;
type Log = (msg: string, extra?: Record<string, unknown>) => void;

export interface BinderDeps {
  config: BinderConfig;
  apiToken: () => Promise<string>;
  armToken: () => Promise<string>;
  fetch?: Fetch;
  log?: Log;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  budgetMs?: number;
}

export const armResource = 'https://management.azure.com/';
const armBase = 'https://management.azure.com';
const appApiVersion = '2025-02-02-preview';
const dnsApiVersion = '2018-05-01';
const recordTtl = 300;
const attempts = 3;
const provisionPolls = 10;
const provisionPollMs = 3000;
const messageMax = 500;
const requestTimeoutMs = 15_000;

const jsonLog: Log = (msg, extra = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));

const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const hostnamePattern = new RegExp(`^(?=.{1,253}$)(?:${label}\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$`);
const recordPattern = new RegExp(`^(${label})\\.apps$`);

class Refused extends Error {}

class ArmFailure extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const certificateName = (hostname: string) =>
  `${hostname.replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${createHash('sha256').update(hostname).digest('hex').slice(0, 8)}`;

export const isWorkItem = (value: unknown): value is WorkItem => {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.hostname === 'string' &&
    typeof item.apex === 'boolean' &&
    (item.action === 'bind' || item.action === 'remove') &&
    steps.includes(item.step as Step) &&
    (item.zone === undefined || typeof item.zone === 'string') &&
    (item.recordName === undefined || typeof item.recordName === 'string')
  );
};

const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, messageMax);

const retryAfterMs = (response: Response) => {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : 2000;
};

const armError = (text: string) => {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
    return { code: parsed.error?.code ?? '', message: parsed.error?.message ?? text };
  } catch {
    return { code: '', message: text };
  }
};

export const reportedMessage = (error: unknown) => {
  if (error instanceof Refused) return messageOf(error);
  if (error instanceof ArmFailure)
    return `Azure answered ${error.status}${error.code ? ` ${error.code}` : ''}`;
  return 'the step could not reach Azure';
};

interface Domain {
  name: string;
  bindingType?: string;
  certificateId?: string | null;
}

interface App {
  location?: string;
  properties: {
    provisioningState?: string;
    configuration: { ingress: { fqdn?: string; customDomains?: Domain[] | null } };
  };
}

interface HostEnvironment {
  properties?: { customDomainConfiguration?: { customDomainVerificationId?: string } };
}

interface RecordSet {
  properties?: { CNAMERecord?: { cname?: string }; TXTRecords?: { value?: string[] }[] };
}

interface Certificate {
  properties?: { provisioningState?: string; subjectName?: string };
}

export const runBinder = async (deps: BinderDeps) => {
  const { config } = deps;
  const send = deps.fetch ?? fetch;
  const log = deps.log ?? jsonLog;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const started = now();
  const budgetMs = deps.budgetMs ?? 45_000;
  const reserved = new Set(config.reserved.map((h) => h.toLowerCase()));
  const group = `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers`;
  const appPath = `${group}/Microsoft.App/containerApps/${config.appName}`;
  const environmentPath = `${group}/Microsoft.App/managedEnvironments/${config.environmentName}`;
  const certificatePath = (hostname: string) =>
    `${environmentPath}/managedCertificates/${certificateName(hostname)}`;
  const childZone = `apps.${config.dnsZone}`;
  const recordPath = (type: 'CNAME' | 'TXT', name: string) =>
    `${group}/Microsoft.Network/dnsZones/${childZone}/${type}/${name}`;

  const arm = async <T>(
    method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    version: string,
    body?: unknown,
  ): Promise<T | undefined> => {
    for (let attempt = 1; ; attempt++) {
      const response = await send(`${armBase}${path}?api-version=${version}`, {
        method,
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: {
          authorization: `Bearer ${await deps.armToken()}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const delay = retryAfterMs(response);
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < attempts && now() - started + delay < budgetMs) {
        await sleep(delay);
        continue;
      }
      if (response.status === 404 && method !== 'PUT') return undefined;
      const text = await response.text();
      if (!response.ok) {
        const failure = armError(text);
        throw new ArmFailure(
          response.status,
          failure.code,
          `${method} ${path} ${response.status} ${failure.code} ${failure.message}`.trim(),
        );
      }
      return (text ? JSON.parse(text) : {}) as T;
    }
  };

  const getApp = async () => {
    const app = await arm<App>('GET', appPath, appApiVersion);
    if (!app) throw new Refused(`the host app ${config.appName} does not exist`);
    return app;
  };

  const settle = async (): Promise<StepResult['ok'] | undefined> => {
    for (let poll = 0; poll < provisionPolls; poll++) {
      if (now() - started > budgetMs) return undefined;
      await sleep(provisionPollMs);
      const state = (await getApp()).properties.provisioningState;
      if (state === 'Succeeded') return true;
      if (state === 'Failed' || state === 'Canceled') return false;
    }
    return undefined;
  };

  const changeDomains = async (
    change: (domains: Domain[]) => Domain[] | undefined,
  ): Promise<'unchanged' | 'busy' | 'pending' | 'written' | 'failed'> => {
    const app = await getApp();
    if (app.properties.provisioningState === 'InProgress') return 'busy';
    const next = change(app.properties.configuration.ingress.customDomains ?? []);
    if (!next) return 'unchanged';
    await arm('PATCH', appPath, appApiVersion, {
      properties: { configuration: { ingress: { customDomains: next } } },
    });
    const settled = await settle();
    return settled === undefined ? 'pending' : settled ? 'written' : 'failed';
  };

  const platformLabel = (item: WorkItem) => {
    const inZone =
      config.dnsZone !== '' &&
      (item.hostname === config.dnsZone || item.hostname.endsWith(`.${config.dnsZone}`));
    if (item.zone === undefined && item.recordName === undefined) {
      if (inZone) throw new Refused(`${item.hostname} is in genki's zone but has no record name`);
      return undefined;
    }
    if (config.dnsZone === '' || item.zone !== config.dnsZone)
      throw new Refused(`zone ${item.zone ?? ''} is not genki's zone`);
    const match = recordPattern.exec(item.recordName ?? '');
    if (!match?.[1] || item.hostname !== `${item.recordName}.${config.dnsZone}`)
      throw new Refused(`${item.hostname} is not one label under apps.${config.dnsZone}`);
    if (item.apex) throw new Refused(`${item.hostname} is not an apex name`);
    return match[1];
  };

  const writeRecords = async (name: string) => {
    const app = await getApp();
    const environment = await arm<HostEnvironment>('GET', environmentPath, appApiVersion);
    const fqdn = app.properties.configuration.ingress.fqdn;
    const verificationId =
      environment?.properties?.customDomainConfiguration?.customDomainVerificationId;
    if (!fqdn || !verificationId) throw new Refused('the host has no FQDN or verification id');
    const cname = await arm<RecordSet>('GET', recordPath('CNAME', name), dnsApiVersion);
    if (cname?.properties?.CNAMERecord?.cname !== fqdn)
      await arm('PUT', recordPath('CNAME', name), dnsApiVersion, {
        properties: { TTL: recordTtl, CNAMERecord: { cname: fqdn } },
      });
    const txt = await arm<RecordSet>('GET', recordPath('TXT', `asuid.${name}`), dnsApiVersion);
    const values = txt?.properties?.TXTRecords?.flatMap((r) => r.value ?? []) ?? [];
    if (values.length !== 1 || values[0] !== verificationId)
      await arm('PUT', recordPath('TXT', `asuid.${name}`), dnsApiVersion, {
        properties: { TTL: recordTtl, TXTRecords: [{ value: [verificationId] }] },
      });
  };

  const deleteRecords = async (name: string) => {
    await arm('DELETE', recordPath('CNAME', name), dnsApiVersion);
    await arm('DELETE', recordPath('TXT', `asuid.${name}`), dnsApiVersion);
  };

  const outcome = (
    step: Step,
    written: Awaited<ReturnType<typeof changeDomains>>,
    certificateId?: string,
  ): StepResult | undefined => {
    if (written === 'busy' || written === 'pending') return undefined;
    if (written === 'failed')
      return { step, ok: false, message: 'the host app did not provision the change' };
    return { step, ok: true, ...(certificateId ? { certificateId } : {}) };
  };

  const addDisabled = (item: WorkItem) =>
    changeDomains((domains) =>
      domains.some((d) => d.name.toLowerCase() === item.hostname)
        ? undefined
        : [...domains, { name: item.hostname, bindingType: 'Disabled' }],
    );

  const certificate = async (item: WorkItem): Promise<StepResult | undefined> => {
    const added = await addDisabled(item);
    if (added !== 'unchanged' && added !== 'written') return outcome(item.step, added);
    const path = certificatePath(item.hostname);
    const current = await arm<Certificate>('GET', path, appApiVersion);
    const state = current?.properties?.provisioningState;
    if (current && current.properties?.subjectName !== item.hostname)
      throw new Refused(`certificate ${certificateName(item.hostname)} is for another name`);
    if (state === 'Succeeded') return { step: item.step, ok: true, certificateId: path };
    if (state === 'Failed' || state === 'Canceled' || state === 'DeleteFailed') {
      await arm('DELETE', path, appApiVersion);
      return { step: item.step, ok: false, message: `the certificate ended ${state}` };
    }
    if (current) return undefined;
    const app = await getApp();
    await arm('PUT', path, appApiVersion, {
      location: app.location,
      properties: {
        subjectName: item.hostname,
        domainControlValidation: item.apex ? 'HTTP' : 'CNAME',
      },
    });
    return undefined;
  };

  const enable = async (item: WorkItem): Promise<StepResult | undefined> => {
    const path = certificatePath(item.hostname);
    const current = await arm<Certificate>('GET', path, appApiVersion);
    if (current?.properties?.provisioningState !== 'Succeeded')
      return { step: item.step, ok: false, message: 'the certificate is not issued' };
    const written = await changeDomains((domains) => {
      const bound = { name: item.hostname, bindingType: 'SniEnabled', certificateId: path };
      const found = domains.find((d) => d.name.toLowerCase() === item.hostname);
      if (found?.bindingType === 'SniEnabled' && found.certificateId === path) return undefined;
      return [...domains.filter((d) => d.name.toLowerCase() !== item.hostname), bound];
    });
    return outcome(item.step, written, path);
  };

  const remove = async (item: WorkItem, record: string | undefined) => {
    const written = await changeDomains((domains) =>
      domains.some((d) => d.name.toLowerCase() === item.hostname)
        ? domains.filter((d) => d.name.toLowerCase() !== item.hostname)
        : undefined,
    );
    if (written !== 'unchanged' && written !== 'written') return outcome(item.step, written);
    await arm('DELETE', certificatePath(item.hostname), appApiVersion);
    if (record) await deleteRecords(record);
    return { step: item.step, ok: true };
  };

  const apply = async (item: WorkItem): Promise<StepResult | undefined> => {
    if (!hostnamePattern.test(item.hostname))
      throw new Refused(`${item.hostname} is not a lowercase hostname`);
    if (reserved.has(item.hostname))
      throw new Refused(`${item.hostname} is bound by the infrastructure template`);
    const record = platformLabel(item);
    if (item.step === 'done') return undefined;
    if (item.action === 'remove') return remove(item, record);
    if (item.step === 'unbind') throw new Refused('unbind is a step of remove');
    if (record) await writeRecords(record);
    if (item.step === 'add') return outcome(item.step, await addDisabled(item));
    if (item.step === 'certificate') return certificate(item);
    return enable(item);
  };

  const api = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const response = await send(`${config.apiUrl.replace(/\/$/, '')}${path}`, {
      method,
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        authorization: `Bearer ${await deps.apiToken()}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}`);
    return response;
  };

  const work = (await (await api('GET', '/internal/hostnames/work')).json()) as {
    items?: unknown;
  };
  const items = Array.isArray(work.items) ? work.items : [];
  const summary = { items: items.length, reported: 0, failed: 0, skipped: 0 };
  for (const raw of items) {
    if (now() - started > budgetMs) {
      summary.skipped++;
      continue;
    }
    if (!isWorkItem(raw)) {
      log('hostname work item malformed', { id: (raw as { id?: unknown } | null)?.id });
      summary.failed++;
      continue;
    }
    let result: StepResult | undefined;
    let detail: string | undefined;
    try {
      result = await apply(raw);
    } catch (error) {
      detail = messageOf(error);
      result = { step: raw.step, ok: false, message: reportedMessage(error) };
    }
    log('hostname step', {
      id: raw.id,
      hostname: raw.hostname,
      action: raw.action,
      step: raw.step,
      ...(result ? { ok: result.ok, message: result.message } : { waiting: true }),
      ...(detail ? { detail } : {}),
    });
    if (!result) continue;
    try {
      await api('POST', `/internal/hostnames/${encodeURIComponent(raw.id)}/result`, result);
      summary.reported++;
    } catch (error) {
      summary.failed++;
      log('hostname result not reported', { id: raw.id, error: messageOf(error) });
    }
  }
  return summary;
};

export const managedIdentityToken = (
  env: Record<string, string | undefined>,
  send: Fetch = fetch,
): TokenSource => {
  const cache = new Map<string, Promise<string>>();
  return (resource) => {
    const cached = cache.get(resource);
    if (cached) return cached;
    const pending = (async () => {
      const endpoint = env.IDENTITY_ENDPOINT;
      const header = env.IDENTITY_HEADER;
      if (!endpoint || !header) throw new Error('no managed identity endpoint');
      const url = new URL(endpoint);
      url.searchParams.set('api-version', '2019-08-01');
      url.searchParams.set('resource', resource);
      if (env.AZURE_CLIENT_ID) url.searchParams.set('client_id', env.AZURE_CLIENT_ID);
      const response = await send(url, {
        headers: { 'x-identity-header': header },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`no token for ${resource}: ${response.status}`);
      const body = (await response.json()) as { access_token?: string };
      if (!body.access_token) throw new Error(`no token for ${resource}`);
      return body.access_token;
    })();
    cache.set(resource, pending);
    pending.catch(() => cache.delete(resource));
    return pending;
  };
};

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const main = async () => {
  const tokens = managedIdentityToken(process.env);
  const audience = required('HOSTNAME_BINDER_AUDIENCE');
  const summary = await runBinder({
    config: {
      apiUrl: required('GENAI_API_URL'),
      subscriptionId: required('AZURE_SUBSCRIPTION_ID'),
      resourceGroup: required('AZURE_RESOURCE_GROUP'),
      appName: required('HOST_APP_NAME'),
      environmentName: required('HOST_ENVIRONMENT_NAME'),
      dnsZone: process.env.DNS_ZONE_NAME ?? '',
      reserved: (process.env.HOSTNAME_BINDER_RESERVED ?? '').split(',').filter(Boolean),
    },
    apiToken: () => tokens(audience),
    armToken: () => tokens(armResource),
  });
  jsonLog('hostname binder run', summary);
  if (summary.failed > 0) process.exitCode = 1;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    jsonLog('hostname binder failed', { error: messageOf(error) });
    process.exitCode = 1;
  });
}
