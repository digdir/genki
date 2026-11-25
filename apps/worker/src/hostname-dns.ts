import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import {
  lapseAfterMs,
  pendingExpiryMs,
  removeLapsedAfterMs,
  type DnsCheck,
  type HostnameClaim,
  type HostnameClaimStore,
  type HostTarget,
} from '@genai/kernel';

export interface DnsAnswers {
  txt(name: string): Promise<string[]>;
  cname(name: string): Promise<string | undefined>;
  a(name: string): Promise<string[]>;
}

export interface HostnameAudit {
  tenant: string;
  action: string;
  target: string;
  reason: string;
}

export interface HostnameDnsDeps {
  claims: HostnameClaimStore;
  dns: DnsAnswers;
  target: HostTarget;
  audit: (entry: HostnameAudit) => Promise<void>;
  now?: () => Date;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  batch?: number;
}

export const hostnameDnsIntervalMs = 5 * 60_000;
export const activeCheckEveryMs = 24 * 3600_000;

const sameValue = (a: string, b: string) => {
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(a), digest(b));
};

const bare = (name: string) => name.toLowerCase().replace(/\.$/, '');

const seen = async (deps: HostnameDnsDeps, claim: HostnameClaim, at: string): Promise<DnsCheck> => {
  const { hostname } = claim;
  const [challenge, asuid, target] = await Promise.all([
    deps.dns.txt(`_genki-challenge.${hostname}`),
    deps.dns.txt(`asuid.${hostname}`),
    claim.apex ? deps.dns.a(hostname) : deps.dns.cname(hostname),
  ]);
  const verificationId = deps.target.verificationId;
  return {
    at,
    challenge: challenge.some((value) => sameValue(value, claim.token)),
    asuid: verificationId !== undefined && asuid.some((value) => sameValue(value, verificationId)),
    target: claim.apex
      ? Array.isArray(target) && deps.target.staticIp !== undefined
        ? target.includes(deps.target.staticIp)
        : false
      : typeof target === 'string' && deps.target.fqdn !== undefined
        ? bare(target) === deps.target.fqdn
        : false,
  };
};

const next = (claim: HostnameClaim, patch: Partial<HostnameClaim>, at: string): HostnameClaim => {
  const moved: HostnameClaim = { ...claim, ...patch, updatedAt: at, version: claim.version + 1 };
  if (patch.state && patch.state !== claim.state) moved.stateSince = at;
  return moved;
};

const withoutGap = ({ missingSince: _gap, ...claim }: HostnameClaim): HostnameClaim => claim;

export interface DnsRun {
  verified: number;
  notVerified: number;
  expired: number;
  lapsed: number;
  removed: number;
  checked: number;
}

export const checkHostnames = async (deps: HostnameDnsDeps): Promise<DnsRun> => {
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  const run: DnsRun = {
    verified: 0,
    notVerified: 0,
    expired: 0,
    lapsed: 0,
    removed: 0,
    checked: 0,
  };
  const batch = deps.batch ?? 500;
  const audited = async (claim: HostnameClaim, action: string, reason: string) =>
    deps.audit({
      tenant: claim.tenant,
      action,
      target: `hostname:${claim.tenant}/${claim.hostname}`,
      reason,
    });

  for (const claim of await deps.claims.inStates(['pending-dns'], batch)) {
    if (claim.assigned) continue;
    if (now.getTime() - new Date(claim.createdAt).getTime() >= pendingExpiryMs) {
      if (
        (await deps.claims.update(next(claim, { state: 'failed', failure: 'expired' }, at))) ===
        'ok'
      ) {
        run.expired += 1;
        await audited(claim, 'platform.client.hostnames.expire', 'Ikke bekreftet i DNS på 7 dager');
      }
      continue;
    }
    const check = await seen(deps, claim, at);
    run.checked += 1;
    if (!(check.challenge && check.asuid && check.target)) {
      await deps.claims.update(next(claim, { check }, at));
      continue;
    }
    const written = await deps.claims.update(
      next(claim, { state: 'binding', step: 'add', check }, at),
    );
    if (written === 'ok') {
      run.verified += 1;
      await audited(claim, 'platform.client.hostnames.verify', 'DNS-postene er på plass');
    } else if (written === 'taken') {
      const lost = next(claim, { state: 'failed', failure: 'not_verified', check }, at);
      if ((await deps.claims.update(lost)) === 'ok') {
        run.notVerified += 1;
        await audited(claim, 'platform.client.hostnames.verify', 'Ikke bekreftet');
      }
    }
  }

  for (const claim of await deps.claims.inStates(['active'], batch)) {
    if (claim.assigned) continue;
    if (claim.check && now.getTime() - new Date(claim.check.at).getTime() < activeCheckEveryMs)
      continue;
    const check = await seen(deps, claim, at);
    run.checked += 1;
    if (check.challenge && check.target) {
      await deps.claims.update(next(withoutGap(claim), { check }, at));
      continue;
    }
    const missingSince = claim.missingSince ?? at;
    if (now.getTime() - new Date(missingSince).getTime() >= lapseAfterMs) {
      if (
        (await deps.claims.update(next(claim, { state: 'lapsed', check, missingSince }, at))) ===
        'ok'
      ) {
        run.lapsed += 1;
        await audited(
          claim,
          'platform.client.hostnames.lapse',
          'DNS-postene har vært borte i 7 dager',
        );
      }
      continue;
    }
    await deps.claims.update(next(claim, { check, missingSince }, at));
  }

  for (const claim of await deps.claims.inStates(['lapsed'], batch)) {
    if (now.getTime() - new Date(claim.stateSince).getTime() < removeLapsedAfterMs) continue;
    const unbind = await deps.claims.update(next(claim, { state: 'removing', step: 'unbind' }, at));
    const written =
      unbind === 'taken'
        ? await deps.claims.update(next(claim, { state: 'removed', step: 'done' }, at))
        : unbind;
    if (written === 'ok') {
      run.removed += 1;
      await audited(claim, 'platform.client.hostnames.remove', 'Utløpt i 30 dager');
    }
  }
  return run;
};

const nameServersFor = async (system: Resolver, name: string): Promise<string[]> => {
  const labels = name.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    const zone = labels.slice(i).join('.');
    const servers = await system.resolveNs(zone).catch(() => [] as string[]);
    if (servers.length === 0) continue;
    const addresses = (
      await Promise.all(
        servers.slice(0, 4).map((s) => system.resolve4(s).catch(() => [] as string[])),
      )
    ).flat();
    if (addresses.length > 0) return addresses;
  }
  return [];
};

export const authoritativeDns = (timeoutMs = 3000): DnsAnswers => {
  const system = new Resolver({ timeout: timeoutMs, tries: 2 });
  const ask = async <T>(name: string, read: (r: Resolver) => Promise<T>, none: T): Promise<T> => {
    const servers = await nameServersFor(system, name);
    if (servers.length === 0) return none;
    const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
    resolver.setServers(servers.slice(0, 4));
    return read(resolver).catch(() => none);
  };
  return {
    txt: (name) =>
      ask(name, async (r) => (await r.resolveTxt(name)).map((parts) => parts.join('')), []),
    cname: (name) =>
      ask(name, async (r) => (await r.resolveCname(name))[0], undefined as string | undefined),
    a: (name) => ask(name, (r) => r.resolve4(name), [] as string[]),
  };
};

export const scheduleHostnameDns = (
  deps: HostnameDnsDeps & { active?: () => Promise<boolean> },
): { stop(): void } => {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (deps.active && !(await deps.active())) return;
      const run = await checkHostnames(deps);
      if (Object.values(run).some((n) => n > 0)) deps.log('hostname dns checked', { ...run });
    } catch (error) {
      deps.log('hostname dns failed', { error: error instanceof Error ? error.name : 'unknown' });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), hostnameDnsIntervalMs);
  void tick();
  return { stop: () => clearInterval(timer) };
};

export const auditEntry = (entry: HostnameAudit, at: Date) => ({
  task: randomUUID(),
  tenant: entry.tenant,
  action: entry.action,
  actor: 'platform:hostname-dns',
  at: at.toISOString(),
  outcome: 'applied' as const,
  target: entry.target,
  reason: entry.reason,
});
