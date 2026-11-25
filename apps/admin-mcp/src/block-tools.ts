import { extname } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { blockOutline, type OutlinePayload } from './block-outline.js';
import { GenkiError, segment, tenantPath, type GenkiClient } from './client.js';
import {
  fail,
  lines,
  markedReason,
  minimumReason,
  readLocalFile,
  tool,
  untrusted,
  viaAgent,
  type Tool,
  type ToolContext,
  type ToolOutput,
} from './kit.js';

const htmlBytes = 512 * 1024;

export const studioOff =
  'Utforming is not switched on for you in this organisation, so the design element tools are closed. A person turns it on under Nye funksjoner in the portal.';

export const shareRefusal =
  "Not saved: sharing with everyone is a person's choice in Utforming. Save it with sharing: organisation.";

export const notInUse =
  "No service uses it until a person puts it in a service's testutgave in Utforming.";

type Block = {
  kind?: unknown;
  metadata?: { tenant?: unknown; id?: unknown };
  spec?: Record<string, unknown> & { tier?: unknown; sharing?: unknown };
} & Record<string, unknown>;

interface Problem {
  path?: string;
  message: string;
}

interface BlockSummary {
  publisher: string;
  id: string;
  tier: string;
  origin: string;
  title: { nb?: string; en?: string };
  latest: { version: number; publishedAt: string };
  usedBy: number;
}

interface BlockDetail {
  editions: { version: number; publishedAt: string; reason: string; sharing: string }[];
  edition: { version: number; definition: Record<string, unknown> };
  usedIn: { service: string; name: string; draft?: number; test?: number; inUse?: number }[];
}

interface Preview {
  valid: boolean;
  errors?: Problem[];
  render?: OutlinePayload;
  reads: string[];
  fixtures: Record<string, Record<string, unknown>>;
}

interface Proposal {
  tier: string;
  definition: Record<string, unknown>;
  report: { kind: string; code: string; where: string; message: string }[];
}

const day = (iso: string) => iso.slice(0, 10);

const designLink = (client: GenkiClient, publisher: string, id: string) =>
  client.portal
    ? `${client.portal}/#/design/${encodeURIComponent(publisher)}/${encodeURIComponent(id)}`
    : undefined;

const studioOn = async (client: GenkiClient) => {
  const { data } = await client.request<{ data: { key: string; on: boolean }[] }>(
    'GET',
    `${tenantPath(client.tenant)}/me/flags`,
  );
  return data.some((flag) => flag.key === 'blockStudio' && flag.on);
};

/** A design element tool that answers only while blockStudio is on for the person. */
const studioTool = <S extends z.ZodType>(t: {
  name: string;
  title: string;
  description: string;
  kind: 'read' | 'write';
  args: S;
  run(context: ToolContext, args: z.infer<S>): Promise<ToolOutput>;
}): Tool =>
  tool({
    ...t,
    run: async (context, args) =>
      (await studioOn(context.client)) ? t.run(context, args) : fail(studioOff),
  });

const definitionArg = z
  .union([z.string().min(1), z.record(z.string(), z.unknown())])
  .describe('The Block definition, as YAML text or as an object');

/** The definition to send, refused here when it is not this organisation's block. */
const readBlock = (
  client: GenkiClient,
  definition: string | Record<string, unknown>,
): { error: ToolOutput } | { block: Block; id: string } => {
  let block: Block;
  if (typeof definition === 'string') {
    try {
      block = parse(definition) as Block;
    } catch (error) {
      return { error: fail(`The YAML could not be read: ${(error as Error).message}`) };
    }
  } else block = structuredClone(definition) as Block;
  if (!block || typeof block !== 'object' || Array.isArray(block))
    return { error: fail('The definition is not an object.') };
  if (block.kind !== 'Block')
    return {
      error: fail(
        'The design element tools take kind: Block only. Use validate_definition and publish_definition for a service.',
      ),
    };
  if (block.metadata?.tenant !== client.tenant)
    return {
      error: fail(
        `metadata.tenant is ${String(block.metadata?.tenant ?? 'missing')}, but this server works for ${client.tenant} only.`,
      ),
    };
  if (typeof block.metadata.id !== 'string' || block.metadata.id === '')
    return { error: fail('metadata.id is missing.') };
  return { block, id: block.metadata.id };
};

const checked = async (client: GenkiClient, block: Block) => {
  try {
    const result = await client.request<{ warnings?: Problem[] }>('POST', '/definitions/validate', {
      body: { definition: block, files: {} },
    });
    return { valid: true as const, warnings: result.warnings ?? [] };
  } catch (error) {
    if (error instanceof GenkiError && error.status === 422)
      return { valid: false as const, errors: error.problem?.errors ?? [] };
    throw error;
  }
};

const listBlocks = studioTool({
  name: 'list_blocks',
  title: 'List design elements',
  description:
    "List the design elements (kind: Block) this organisation may place in a service: its own, genki's built-in ones and those other organisations share with everyone. One line each: ref, tier, title, origin, newest edition and how many of the organisation's services pin it.",
  kind: 'read',
  args: z.strictObject({
    origin: z
      .enum(['own', 'built-in', 'shared'])
      .optional()
      .describe("Only own design elements, genki's built-in ones, or those shared by others"),
  }),
  run: async ({ client }, { origin }) => {
    const { data } = await client.request<{ data: BlockSummary[] }>(
      'GET',
      `${tenantPath(client.tenant)}/blocks`,
      { query: { origin } },
    );
    if (data.length === 0) return { text: 'No design elements.', data: { blocks: [] } };
    const text = data
      .map(
        (b) =>
          `- ${b.publisher}/${b.id}@${b.latest.version} (${b.tier}, ${b.origin}): ${b.title.nb ?? b.id}, newest edition ${day(b.latest.publishedAt)}, used by ${b.usedBy} service${b.usedBy === 1 ? '' : 's'}`,
      )
      .join('\n');
    return { text: untrusted(text), data: { blocks: data } };
  },
});

const getBlock = studioTool({
  name: 'get_block',
  title: 'Read a design element',
  description:
    "Read one design element as YAML: the newest edition this organisation may use, or the one asked for, its editions with dates, and where the organisation's services pin it. Another organisation's design element is readable only in the editions it shares with everyone.",
  kind: 'read',
  args: z.strictObject({
    publisher: z
      .string()
      .regex(/^\d{9}$/, 'an organisation number')
      .optional()
      .describe('The organisation that published it; this organisation without it'),
    id: z.string().min(1).describe('The id, from list_blocks'),
    version: z.number().int().positive().optional().describe('An edition'),
  }),
  run: async ({ client }, { publisher, id, version }) => {
    const owner = publisher ?? client.tenant;
    let detail: BlockDetail;
    try {
      detail = await client.request<BlockDetail>(
        'GET',
        `${tenantPath(client.tenant)}/blocks/${segment(owner)}/${segment(id)}`,
        { query: { version } },
      );
    } catch (error) {
      if (error instanceof GenkiError && error.status === 404)
        return fail(
          `There is no design element ${owner}/${id} this organisation may use. Use list_blocks.`,
        );
      throw error;
    }
    const editions = detail.editions
      .map((e) => `- ${e.version}, ${day(e.publishedAt)}, ${e.sharing}: ${e.reason}`)
      .join('\n');
    const used = detail.usedIn.length
      ? detail.usedIn
          .map(
            (u) =>
              `- ${u.service} (${u.name}): testutgave ${u.draft ?? '-'}, test ${u.test ?? '-'}, i bruk ${u.inUse ?? '-'}`,
          )
          .join('\n')
      : '- no service of this organisation';
    return {
      text: `Edition ${detail.edition.version} of ${owner}/${id}.\n${untrusted(`${stringify(detail.edition.definition)}\nEditions:\n${editions}\n\nPinned in:\n${used}`)}`,
      data: {
        publisher: owner,
        id,
        version: detail.edition.version,
        definition: detail.edition.definition,
        editions: detail.editions,
        usedIn: detail.usedIn,
      },
    };
  },
});

const validateBlock = studioTool({
  name: 'validate_block',
  title: 'Validate a design element',
  description:
    "Check a design element against genki's rules without saving it: the element set, the fields it may read, its events, states, texts and limits. Errors name the field they are about.",
  kind: 'read',
  args: z.strictObject({ definition: definitionArg }),
  run: async ({ client }, { definition }) => {
    const read = readBlock(client, definition);
    if ('error' in read) return read.error;
    const result = await checked(client, read.block);
    if (!result.valid)
      return fail(`Not valid:\n${untrusted(lines(result.errors))}`, {
        valid: false,
        errors: result.errors,
      });
    return {
      text: result.warnings.length
        ? `Valid, with warnings:\n${untrusted(lines(result.warnings))}`
        : 'Valid.',
      data: { valid: true, warnings: result.warnings },
    };
  },
});

const previewBlock = studioTool({
  name: 'preview_block',
  title: 'Preview a design element',
  description:
    "Show what a host would draw from an unsaved design element with genki's made-up data: the fields it reads and a text outline per state. Saves nothing.",
  kind: 'read',
  args: z.strictObject({
    definition: definitionArg,
    states: z
      .array(z.enum(['empty', 'loading', 'error', 'partial', 'disabled', 'filled']))
      .optional()
      .describe('The states to show; filled and empty without it'),
  }),
  run: async ({ client }, { definition, states }) => {
    const read = readBlock(client, definition);
    if ('error' in read) return read.error;
    const wanted = states ?? ['filled', 'empty'];
    let preview: Preview;
    try {
      preview = await client.request<Preview>(
        'POST',
        `${tenantPath(client.tenant)}/blocks/preview`,
        { body: { definition: read.block, files: {}, states: wanted } },
      );
    } catch (error) {
      if (error instanceof GenkiError && (error.status === 422 || error.status === 400))
        return fail(`Not valid:\n${untrusted(error.message)}`);
      throw error;
    }
    if (!preview.valid)
      return fail(`Not valid:\n${untrusted(lines(preview.errors ?? []))}`, {
        valid: false,
        errors: preview.errors ?? [],
      });
    const outlines = preview.render
      ? wanted.map(
          (state) =>
            `State ${state}:\n${blockOutline(preview.render as OutlinePayload, preview.fixtures[state] ?? {}, state)}`,
        )
      : [];
    const saved = await client
      .request(
        'GET',
        `${tenantPath(client.tenant)}/blocks/${segment(client.tenant)}/${segment(read.id)}`,
      )
      .then(() => designLink(client, client.tenant, read.id))
      .catch(() => undefined);
    return {
      text: `Valid. Reads: ${preview.reads.length ? preview.reads.join(', ') : 'nothing'}.\n${untrusted(outlines.join('\n\n'))}${saved ? `\nSaved editions: ${saved}` : ''}`,
      data: { reads: preview.reads, states: wanted },
    };
  },
});

const saveBlock = studioTool({
  name: 'save_block',
  title: 'Save a design element',
  description:
    "Save a design element as its next edition, shared with this organisation only. Only when the person has asked for it. Needs a reason that says what changed and why; it is marked as made through a coding agent. No service uses the edition until a person puts it in a service's testutgave in Utforming and publishes the service. Sharing with everyone is refused here: a person does that in Utforming.",
  kind: 'write',
  args: z.strictObject({
    definition: definitionArg,
    reason: z.string().describe('What changed and why, at least 10 characters'),
  }),
  run: async ({ client }, { definition, reason }) => {
    if (reason.replaceAll(viaAgent, '').trim().length < minimumReason)
      return fail(
        `A reason of at least ${minimumReason} characters is required: say what changed and why.`,
      );
    const read = readBlock(client, definition);
    if ('error' in read) return read.error;
    const sharing = read.block.spec?.sharing;
    if (sharing === 'everyone') return fail(shareRefusal);
    if (sharing !== undefined && sharing !== 'organisation')
      return fail('Not saved: spec.sharing must be organisation.');
    if (read.block.spec) read.block.spec.sharing = 'organisation';
    if (read.block.spec?.tier === 'built-in')
      return fail(
        "Not saved: built-in design elements are genki's own, and only an operator publishes them.",
      );
    const result = await checked(client, read.block);
    if (!result.valid)
      return fail(
        `Not saved, the design element is not valid:\n${untrusted(lines(result.errors))}`,
        { errors: result.errors },
      );
    const link = designLink(client, client.tenant, read.id);
    try {
      const saved = await client.request<{ id: string; version: number; publishedAt?: string }>(
        'POST',
        '/definitions',
        { body: { definition: read.block, files: {} }, reason: markedReason(reason) },
      );
      return {
        text: `Saved ${saved.id} as edition ${saved.version}${saved.publishedAt ? ` (${day(saved.publishedAt)})` : ''}. ${notInUse}${link ? `\n${link}` : ''}`,
        data: { id: saved.id, version: saved.version },
      };
    } catch (error) {
      if (error instanceof GenkiError)
        return fail(`Not saved:\n${untrusted(error.message)}`, { status: error.status });
      throw error;
    }
  },
});

const importDesign = studioTool({
  name: 'import_design',
  title: 'Turn a design into a design element',
  description:
    "Turn a design's HTML (a Claude artifact or design, or plain HTML) into a proposed design element without code. A design that needs code (a script, canvas, svg, form, media or animation) is refused with the reason. Give the HTML as text or as a .html file under the folder this server started in; never a URL. Nothing is fetched and nothing is saved.",
  kind: 'read',
  args: z.strictObject({
    html: z.string().min(1).optional().describe('The design as HTML text'),
    htmlPath: z
      .string()
      .min(1)
      .optional()
      .describe('A .html file under the folder this server started in'),
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes')
      .describe('The id of the new design element'),
    title: z.string().min(1).max(80).optional().describe("Its name; the design's title without it"),
  }),
  run: async ({ client, documentRoot }, { html, htmlPath, id, title }) => {
    if ((html === undefined) === (htmlPath === undefined))
      return fail('Give either html or htmlPath.');
    let text = html ?? '';
    if (htmlPath) {
      if (extname(htmlPath).toLowerCase() !== '.html')
        return fail('htmlPath must be a .html file.');
      const { real, data } = await readLocalFile(
        htmlPath,
        documentRoot ?? process.cwd(),
        htmlBytes,
        'htmlPath',
        '512 KiB',
      );
      if (extname(real).toLowerCase() !== '.html') return fail('htmlPath must be a .html file.');
      text = data.toString('utf8');
    }
    let proposal: Proposal;
    try {
      proposal = await client.request<Proposal>(
        'POST',
        `${tenantPath(client.tenant)}/blocks/import`,
        { body: { html: text, id, ...(title ? { title } : {}) } },
      );
    } catch (error) {
      if (error instanceof GenkiError && (error.status === 422 || error.status === 413))
        return fail(`Not imported:\n${untrusted(error.message)}`, { status: error.status });
      throw error;
    }
    const report = proposal.report.map((n) => `- ${n.kind}, ${n.where}: ${n.message}`).join('\n');
    return {
      text: `Proposed a design element without code.\n${untrusted(`${stringify(proposal.definition)}\nReport:\n${report}`)}\nNothing is saved. Check it with preview_block, then save it with save_block when the person asks.`,
      data: { tier: proposal.tier, definition: proposal.definition, report: proposal.report },
    };
  },
});

export const blockTools = [
  listBlocks,
  getBlock,
  validateBlock,
  previewBlock,
  saveBlock,
  importDesign,
];
