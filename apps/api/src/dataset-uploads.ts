import { extname } from 'node:path';
import type { Principal } from '@genai/contracts';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { enterTenant } from './access.js';
import { routeOnlyActions } from './admin.js';
import type { CatalogItem } from './catalog-registry.js';
import { changeReasonOf } from './http.js';
import { t } from './i18n/index.js';
import { uploadPrefix } from './index-ingestion.js';
import type { PlatformModule, PlatformModuleFactory } from './platform-modules.js';

export const uploadTypes: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
};

export const maxUploadBytes = 50 * 1024 * 1024;
export const maxUploadFiles = 20;
export const maxUploadRequestBytes = 100 * 1024 * 1024;

export type UploadSkipReason = 'unsupported_type' | 'too_large' | 'empty' | 'bad_name';

const problem = (c: Context, status: 400 | 401 | 404 | 413 | 500, title: string, detail?: string) =>
  c.json({ type: 'about:blank', title, status, ...(detail ? { detail } : {}) }, status, {
    'content-type': 'application/problem+json',
  });

export const uploadName = (raw: string) => {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const ext = extname(base).toLowerCase();
  const stem = base
    .slice(0, base.length - ext.length)
    .normalize('NFC')
    .replace(/[^A-Za-z0-9æøåÆØÅ._-]+/g, '-')
    .replace(/^[^A-Za-z0-9æøåÆØÅ]+|-+$/g, '')
    .slice(0, 200);
  return stem ? `${stem}${ext}` : undefined;
};

export const createDatasetUploadsModule =
  (
    options: { maxBytes?: number; maxFiles?: number; maxRequestBytes?: number } = {},
  ): PlatformModuleFactory =>
  (deps): PlatformModule => {
    const maxBytes = options.maxBytes ?? maxUploadBytes;
    const maxFiles = options.maxFiles ?? maxUploadFiles;
    const maxRequestBytes = options.maxRequestBytes ?? maxUploadRequestBytes;
    return {
      id: 'dataset-uploads',
      handlers: routeOnlyActions(['platform.dataset.upload', 'platform.dataset.upload.delete']),
      mount: (app, mounted) => {
        const guard = async (
          c: Context,
          right?: 'manage-datasets',
        ): Promise<
          { response: Response } | { principal: Principal; tenant: string; item: CatalogItem }
        > => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return { response: problem(c, 401, 'Unauthorized') };
          const tenant = c.req.param('tenant') ?? '';
          const entered = enterTenant(c, mounted.access, principal, tenant, right);
          if ('response' in entered) return entered;
          const item = deps.catalog.get(
            'dataset',
            deps.catalog.qualify(tenant, c.req.param('id') ?? ''),
          );
          if (!item || item.scope !== tenant) return { response: problem(c, 404, 'Not found') };
          return { principal: entered.principal, tenant, item };
        };
        const inTask = async <T>(
          c: Context,
          g: { principal: Principal; tenant: string; item: CatalogItem },
          action: string,
          work: () => Promise<{ value: T; audit: Record<string, unknown> }>,
        ) => {
          const done = await mounted.admin.within(
            g.principal,
            action,
            { tenant: g.tenant, reason: changeReasonOf(c)?.trim() ?? '' },
            async () => {
              const { value, audit } = await work();
              return { value, target: `dataset:${g.item.id}/uploads`, audit };
            },
          );
          c.header('genai-task', done.task);
          return done.value;
        };
        const base = '/tenants/:tenant/datasets/:id/uploads';

        const tooLarge = (c: Context) =>
          problem(
            c,
            413,
            t('problems.status413'),
            t('problems.uploadRequestTooLarge', {
              size: Math.floor(maxRequestBytes / (1024 * 1024)),
            }),
          );
        const limitBody = bodyLimit({ maxSize: maxRequestBytes, onError: tooLarge });

        const receive = async (
          c: Context,
          g: { principal: Principal; tenant: string; item: CatalogItem },
        ) => {
          const form = await c.req.parseBody({ all: true }).catch(() => undefined);
          if (!form) return problem(c, 400, 'Send the files as multipart/form-data');
          const raw = form.files;
          const files = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(
            (f): f is File => typeof f !== 'string',
          );
          if (files.length === 0) return problem(c, 400, 'No files in the field files');
          if (files.length > maxFiles)
            return problem(
              c,
              413,
              t('problems.status413'),
              t('problems.uploadTooManyFiles', { count: maxFiles }),
            );
          const prefix = uploadPrefix(g.item.id, g.tenant);
          const accepted: { name: string; type: string; file: File }[] = [];
          const skipped: { name: string; reason: UploadSkipReason }[] = [];
          for (const file of files) {
            const name = uploadName(file.name);
            const type = name ? uploadTypes[extname(name).toLowerCase()] : undefined;
            if (!name) skipped.push({ name: file.name, reason: 'bad_name' });
            else if (!type) skipped.push({ name: file.name, reason: 'unsupported_type' });
            else if (file.size > maxBytes) skipped.push({ name: file.name, reason: 'too_large' });
            else if (file.size === 0) skipped.push({ name: file.name, reason: 'empty' });
            else accepted.push({ name, type, file });
          }
          const store = async () => {
            const uploaded: { name: string; size: number; type: string }[] = [];
            for (const { name, type, file } of accepted) {
              const info = await deps.blobs.put(
                { tenant: g.tenant, path: `${prefix}${name}` },
                new Uint8Array(await file.arrayBuffer()),
                type,
              );
              uploaded.push({ name, size: info.size, type });
            }
            return {
              value: { uploaded, skipped },
              audit: { uploaded: uploaded.map((u) => u.name), skipped },
            };
          };
          if (accepted.length === 0) return c.json({ uploaded: [], skipped }, 201);
          return c.json(await inTask(c, g, 'platform.dataset.upload', store), 201);
        };

        app.post(base, async (c) => {
          if (Number(c.req.header('content-length')) > maxRequestBytes) return tooLarge(c);
          const g = await guard(c, 'manage-datasets');
          if ('response' in g) return g.response;
          let answer: Response | undefined;
          const refused = await limitBody(c, async () => {
            answer = await receive(c, g);
          });
          return refused ?? answer ?? problem(c, 500, t('problems.status500'));
        });

        app.get(base, async (c) => {
          const g = await guard(c);
          if ('response' in g) return g.response;
          const prefix = uploadPrefix(g.item.id, g.tenant);
          return c.json({
            data: (await deps.blobs.list(g.tenant, prefix)).map((b) => ({
              name: b.path.slice(prefix.length),
              size: b.size,
              type: b.contentType,
              uploadedAt: b.createdAt,
            })),
          });
        });

        app.delete(`${base}/:name`, async (c) => {
          const g = await guard(c, 'manage-datasets');
          if ('response' in g) return g.response;
          const name = c.req.param('name') ?? '';
          if (uploadName(name) !== name) return problem(c, 404, 'Not found');
          const path = `${uploadPrefix(g.item.id, g.tenant)}${name}`;
          const exists = (await deps.blobs.list(g.tenant, uploadPrefix(g.item.id, g.tenant))).some(
            (b) => b.path === path,
          );
          if (!exists) return problem(c, 404, 'Not found');
          await inTask(c, g, 'platform.dataset.upload.delete', async () => {
            await deps.blobs.delete({ tenant: g.tenant, path });
            return { value: undefined, audit: { removed: name } };
          });
          return c.body(null, 204);
        });
      },
    };
  };

export const datasetUploadsModule = createDatasetUploadsModule();
