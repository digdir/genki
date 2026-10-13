import {
  capabilitiesOrNone,
  checkPromptFiles,
  checkServiceFlowSettings,
  checkServiceFlowTools,
  checkServiceSkills,
  compileStoredServices,
  flowUsesOf,
  publicNamesOf,
  toCapabilities,
  validateDefinition,
  type CompiledCapability,
  type Definition,
  type DefinitionStore,
  type FlowStep,
  type OnInvalidStored,
  type PluginSchemas,
  type PromptFiles,
  type PublishedVersion,
  type PublishResult,
  type ServiceDefinition,
  type SkillDefinition,
  type StepFlowDefinition,
  type FlowFinder,
  type SkillFinder,
  type ValidationError,
} from '@genai/definitions';
import type { Pool, PoolClient } from 'pg';

interface VersionRow {
  kind: Definition['kind'];
  tenant: string;
  id: string;
  version: number;
  definition: Definition;
  files: PromptFiles;
  published_by: string;
  published_at: Date;
  reason: string;
}

const toVersion = (row: VersionRow): PublishedVersion => ({
  version: row.version,
  definition: row.definition,
  publishedBy: row.published_by,
  publishedAt: row.published_at.toISOString(),
  reason: row.reason,
  files: row.files,
});

const subflows = (steps: FlowStep[]): string[] =>
  steps.flatMap((s) => [
    ...(s.subflow ? [s.subflow] : []),
    ...subflows(s.repeat?.steps ?? []),
    ...subflows(s.forEach?.steps ?? []),
    ...(s.cases ?? []).flatMap((c) => subflows(c.steps)),
    ...subflows(s.else ?? []),
  ]);

const latestServices = `select distinct on (tenant, id) * from definition_versions
  where kind = 'Service' order by tenant, id, version desc`;

export class PostgresDefinitionStore implements DefinitionStore {
  constructor(
    private readonly pool: Pool,
    private readonly plugins: PluginSchemas,
    private readonly now: () => Date = () => new Date(),
    private readonly sharedSkill?: SkillFinder,
    private readonly sharedFlow?: FlowFinder,
  ) {}

  async publish(
    input: unknown,
    actor: string,
    reason: string,
    files: PromptFiles = {},
  ): Promise<PublishResult> {
    if (reason.trim().length === 0)
      return { ok: false, errors: [{ path: '', message: 'a reason is required' }] };
    const validated = validateDefinition(input, this.plugins);
    if (!validated.ok) return validated;
    const { definition } = validated;
    const { tenant, id } = definition.metadata;

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select pg_advisory_xact_lock(hashtext('genai-definitions'))`);
      await client.query(`select set_config('app.tenant', $1, true)`, [tenant]);
      const errors = [
        ...checkPromptFiles(definition, files),
        ...(definition.kind === 'Service'
          ? await this.#checkService(client, definition)
          : definition.kind === 'StepFlow'
            ? await this.#missingFlows(
                client,
                tenant,
                subflows(definition.spec.steps),
                'spec.steps',
              )
            : []),
      ];
      if (errors.length > 0) {
        await client.query('rollback');
        return { ok: false, errors };
      }
      const last = await client.query<{ version: number }>(
        'select max(version) as version from definition_versions where kind = $1 and tenant = $2 and id = $3',
        [definition.kind, tenant, id],
      );
      const version = (last.rows[0]?.version ?? 0) + 1;
      const stored = { ...definition, metadata: { ...definition.metadata, version } } as Definition;
      const inserted = await client.query<VersionRow>(
        `insert into definition_versions (kind, tenant, id, version, definition, files, published_by, published_at, reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
        [
          definition.kind,
          tenant,
          id,
          version,
          JSON.stringify(stored),
          JSON.stringify(files),
          actor,
          this.now(),
          reason,
        ],
      );
      await client.query('commit');
      const row = inserted.rows[0] as VersionRow;
      return {
        ok: true,
        version: toVersion(row),
        capabilities: stored.kind === 'Service' ? toCapabilities(stored, version, files) : [],
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async get(kind: Definition['kind'], tenant: string, id: string, version?: number) {
    const found = await this.pool.query<VersionRow>(
      version === undefined
        ? 'select * from definition_versions where kind = $1 and tenant = $2 and id = $3 order by version desc limit 1'
        : 'select * from definition_versions where kind = $1 and tenant = $2 and id = $3 and version = $4',
      version === undefined ? [kind, tenant, id] : [kind, tenant, id, version],
    );
    const row = found.rows[0];
    return row && toVersion(row);
  }

  async versions(kind: Definition['kind'], tenant: string, id: string) {
    const found = await this.pool.query<VersionRow>(
      'select * from definition_versions where kind = $1 and tenant = $2 and id = $3 order by version',
      [kind, tenant, id],
    );
    return found.rows.map(toVersion);
  }

  async list(tenant: string) {
    const found = await this.pool.query<{ kind: Definition['kind']; id: string }>(
      `select distinct kind, id from definition_versions where tenant = $1 order by kind, id`,
      [tenant],
    );
    return found.rows.map((r) => ({ kind: r.kind, id: r.id }));
  }

  async resolve(name: string, version?: number): Promise<CompiledCapability | undefined> {
    const rows =
      version === undefined
        ? (await this.pool.query<VersionRow>(latestServices)).rows
        : (
            await this.pool.query<VersionRow>(
              `select * from definition_versions where kind = 'Service' and version = $1 order by tenant, id`,
              [version],
            )
          ).rows;
    for (const row of rows) {
      const match = capabilitiesOrNone(toVersion(row)).find(
        (c) =>
          c.capability.descriptor.id === name || c.publicName === name || c.aliases.includes(name),
      );
      if (match) return match;
    }
    return undefined;
  }

  async capabilities(onInvalid?: OnInvalidStored) {
    const rows = (await this.pool.query<VersionRow>(latestServices)).rows;
    return compileStoredServices(rows.map(toVersion), this.plugins, onInvalid);
  }

  async #missingFlows(
    client: PoolClient,
    tenant: string,
    refs: string[],
    path: string,
  ): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];
    for (const ref of refs) {
      const at = ref.lastIndexOf('@');
      const version = Number(ref.slice(at + 1));
      const found =
        at > 0 && Number.isInteger(version)
          ? await client.query(
              `select 1 from definition_versions where kind = 'StepFlow' and tenant = $1 and id = $2 and version = $3`,
              [tenant, ref.slice(0, at), version],
            )
          : { rowCount: 0 };
      const shared =
        !found.rowCount && at > 0 && Number.isInteger(version)
          ? await this.sharedFlow?.(tenant, ref.slice(0, at), version)
          : undefined;
      if (!found.rowCount && !shared)
        errors.push({ path, message: `no published step flow ${ref}` });
    }
    return errors;
  }

  async #checkService(
    client: PoolClient,
    definition: ServiceDefinition,
  ): Promise<ValidationError[]> {
    const { tenant, id } = definition.metadata;
    const taken = new Map<string, string>();
    for (const row of (await client.query<VersionRow>(latestServices)).rows) {
      if (row.tenant === tenant && row.id === id) continue;
      const other = row.definition as ServiceDefinition;
      for (const v of other.spec.variants) {
        const { primary, aliases } = publicNamesOf(other, v);
        for (const n of [primary, ...aliases]) taken.set(n, `Service:${row.tenant}/${row.id}`);
      }
    }
    const errors: ValidationError[] = [];
    definition.spec.variants.forEach((v, i) => {
      const { primary, aliases } = publicNamesOf(definition, v);
      for (const n of [primary, ...aliases]) {
        const owner = taken.get(n);
        if (owner)
          errors.push({
            path: `spec.variants[${i}]`,
            message: `public name ${n} is used by ${owner}`,
          });
      }
    });
    for (const { flow, path } of flowUsesOf(definition.spec))
      errors.push(...(await this.#missingFlows(client, tenant, [flow], path)));
    const flowOf = async (owner: string, flow: string, version: number) => {
      const found = await client.query<{ definition: StepFlowDefinition }>(
        `select definition from definition_versions where kind = 'StepFlow' and tenant = $1 and id = $2 and version = $3`,
        [owner, flow, version],
      );
      return found.rows[0]?.definition ?? (await this.sharedFlow?.(owner, flow, version));
    };
    errors.push(
      ...(await checkServiceSkills(definition, async (owner, skill, version) => {
        const found = await client.query<{ definition: SkillDefinition }>(
          `select definition from definition_versions where kind = 'Skill' and tenant = $1 and id = $2 and version = $3`,
          [owner, skill, version],
        );
        return found.rows[0]?.definition ?? (await this.sharedSkill?.(owner, skill, version));
      })),
      ...(await checkServiceFlowTools(definition, flowOf)),
      ...(await checkServiceFlowSettings(definition, flowOf)),
    );
    return errors;
  }
}
