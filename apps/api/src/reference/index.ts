import { z, type OpenAPIHono } from '@hono/zod-openapi';
import { referencePage, referenceStyles } from './page.js';
import { referenceScript } from './script.js';

const files = [
  {
    path: '/reference',
    media: 'text/html',
    type: 'text/html; charset=utf-8',
    body: referencePage,
    summary: 'Browsable reference for this API, built from /openapi.json. Open to everyone.',
  },
  {
    path: '/reference/app.js',
    media: 'text/javascript',
    type: 'text/javascript; charset=utf-8',
    body: referenceScript,
    summary: 'The ES module the reference page runs. Open to everyone.',
  },
  {
    path: '/reference/app.css',
    media: 'text/css',
    type: 'text/css; charset=utf-8',
    body: referenceStyles,
    summary: 'The stylesheet of the reference page. Open to everyone.',
  },
] as const;

export const registerReference = (app: OpenAPIHono) => {
  for (const file of files) {
    app.openAPIRegistry.registerPath({
      method: 'get',
      path: file.path,
      summary: file.summary,
      security: [],
      responses: {
        200: {
          description: file.path === '/reference' ? 'The reference page' : 'The file',
          content: { [file.media]: { schema: z.string() } },
        },
      },
    });
    app.get(file.path, (c) =>
      c.body(file.body, 200, { 'content-type': file.type, 'cache-control': 'no-cache' }),
    );
  }
};
