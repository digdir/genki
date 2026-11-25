import {
  importDesign,
  ImportRefused,
  type ImportFinding,
  type ImportProposal,
} from '@genai/block-import';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { enterTenant } from './access.js';
import { blockPublisherProblems } from './admin.js';
import { requireFlag } from './feature-flags.js';
import { problem } from './http.js';
import { t, translate, type ApiKey } from './i18n/index.js';
import type { PlatformModuleFactory } from './platform-modules.js';

export const importBodyBytes = 1024 * 1024;

const slug = /^[a-z0-9][a-z0-9-]{0,62}$/;

const tooLarge = (c: Context) =>
  c.json(
    {
      type: 'about:blank',
      title: t('problems.status413'),
      status: 413,
      detail: t('blockImport.bodyTooLarge', { limit: '1 MiB' }),
    },
    413,
    { 'content-type': 'application/problem+json' },
  );

const worded = (finding: ImportFinding) => ({
  kind: finding.kind,
  code: finding.code,
  where: finding.where,
  message: translate(`blockImport.${finding.code}` as ApiKey, finding.values),
});

/** `POST /tenants/{tenant}/blocks/import`: a design's HTML as a proposed Block; saves nothing. */
export const blockImportModule: PlatformModuleFactory = () => ({
  id: 'block-import',
  mount: (app, mounted) => {
    app.post(
      '/tenants/:tenant/blocks/import',
      requireFlag(mounted, 'blockStudio'),
      bodyLimit({ maxSize: importBodyBytes, onError: tooLarge }),
      async (c) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return problem(c, 401, t('problems.unauthorized'));
        const tenant = c.req.param('tenant') ?? '';
        const entered = enterTenant(c, mounted.access, principal, tenant, 'manage-services');
        if ('response' in entered) return entered.response;
        const body = (await c.req.json().catch(() => undefined)) as
          { html?: unknown; id?: unknown; title?: unknown } | undefined;
        const errors = [
          ...(typeof body?.html === 'string'
            ? []
            : [{ path: 'html', message: t('blockImport.mustBeText') }]),
          ...(typeof body?.id === 'string' && slug.test(body.id)
            ? []
            : [{ path: 'id', message: t('blockImport.mustBeSlug') }]),
          ...(body?.title === undefined || typeof body.title === 'string'
            ? []
            : [{ path: 'title', message: t('blockImport.mustBeText') }]),
        ];
        if (!body || errors.length > 0)
          return problem(c, 422, t('problems.invalidDefinition'), { errors });
        let proposal: ImportProposal;
        try {
          proposal = importDesign(body.html as string, {
            tenant,
            id: body.id as string,
            ...(typeof body.title === 'string' ? { title: body.title } : {}),
          });
        } catch (error) {
          if (!(error instanceof ImportRefused)) throw error;
          const message = translate(`blockImport.${error.code}` as ApiKey, error.values);
          return problem(c, 422, message, { errors: [{ path: 'html', message }] });
        }
        const problems = [
          ...blockPublisherProblems(proposal.definition, entered.principal),
          ...mounted.admin.check(proposal.definition, proposal.files),
        ];
        if (problems.length > 0)
          return problem(c, 422, t('blockImport.invalid'), { errors: problems });
        return c.json({ ...proposal, report: proposal.report.map(worded) });
      },
    );
  },
});
