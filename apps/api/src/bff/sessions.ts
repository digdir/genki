import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface BffSessionRow {
  hostname: string;
  client: string;
  expiresAt: number;
  payload: string;
}

/** Where the BFF keeps sessions; `PostgresBffSessions` is the shared one. */
export interface BffSessionStore {
  create(tenant: string, idHash: string, row: BffSessionRow): Promise<void>;
  get(tenant: string, idHash: string): Promise<BffSessionRow | undefined>;
  update(
    tenant: string,
    idHash: string,
    change: (row: BffSessionRow) => Promise<BffSessionRow | undefined>,
  ): Promise<BffSessionRow | undefined>;
  delete(tenant: string, idHash: string): Promise<boolean>;
  seal(tenant: string, purpose: string, plaintext: string): Promise<string>;
  open(tenant: string, purpose: string, sealed: string): Promise<string | undefined>;
}

export interface Organisation {
  orgNumber: string;
  name?: string;
}

export interface SessionPayload {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken?: string;
  idToken?: string;
  name?: string;
  organisation?: string;
  organisations: Organisation[];
}

export const newSessionId = () => randomBytes(32).toString('base64url');

export const sessionIdHash = (id: string) => createHash('sha256').update(id).digest('hex');

export const parsePayload = (payload: string): SessionPayload | undefined => {
  try {
    const parsed = JSON.parse(payload) as SessionPayload;
    return typeof parsed.accessToken === 'string' && typeof parsed.accessExpiresAt === 'number'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
};

/** A store for one process, for dev mode and tests. */
export class InMemoryBffSessions implements BffSessionStore {
  readonly #rows = new Map<string, BffSessionRow>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #key = randomBytes(32);

  constructor(private readonly now: () => number = Date.now) {}

  async create(tenant: string, idHash: string, row: BffSessionRow) {
    this.#rows.set(`${tenant}/${idHash}`, { ...row });
  }

  async get(tenant: string, idHash: string) {
    const row = this.#rows.get(`${tenant}/${idHash}`);
    return row && row.expiresAt > this.now() ? { ...row } : undefined;
  }

  async update(
    tenant: string,
    idHash: string,
    change: (row: BffSessionRow) => Promise<BffSessionRow | undefined>,
  ) {
    const id = `${tenant}/${idHash}`;
    const before = this.#locks.get(id) ?? Promise.resolve();
    const run = before.then(async () => {
      const current = await this.get(tenant, idHash);
      if (!current) return undefined;
      const next = await change(current);
      if (!next) {
        this.#rows.delete(id);
        return undefined;
      }
      const kept = { ...next, hostname: current.hostname, client: current.client };
      this.#rows.set(id, kept);
      return { ...kept };
    });
    this.#locks.set(
      id,
      run.catch(() => undefined),
    );
    return run;
  }

  async delete(tenant: string, idHash: string) {
    return this.#rows.delete(`${tenant}/${idHash}`);
  }

  async seal(tenant: string, purpose: string, plaintext: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(`bff:${tenant}:${purpose}`));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  async open(tenant: string, purpose: string, sealed: string) {
    try {
      const raw = Buffer.from(sealed, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(`bff:${tenant}:${purpose}`));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString();
    } catch {
      return undefined;
    }
  }
}
