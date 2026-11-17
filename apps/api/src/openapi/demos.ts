import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import {
  demoSpec,
  recordingFailure,
  recordingFinish,
  recordingStart,
  recordingStatuses,
} from '../demos.js';
import { changeReason, problemContent } from '../http.js';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const problem = (description: string) => ({ description, content: problemContent });

const viewerOnly = {
  401: problem('Not authenticated'),
  403: problem('Not allowed to see demos'),
} as const;

const recorderOnly = {
  401: problem('No valid recorder key in x-recorder-key'),
} as const;

const recorderKey = z.object({
  'x-recorder-key': z.string().openapi({ description: "The recorder's key" }),
});

const idParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'playground' }),
});
const recordingParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
});
const fileParams = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
  name: z
    .string()
    .openapi({ param: { name: 'name', in: 'path' }, example: 'demo.mp4' })
    .describe('demo.mp4, demo.srt, poster.jpg or failed-step-{n}.png'),
});

const RecordingFile = z.object({
  name: z.string(),
  size: z.number().int(),
  contentType: z.string(),
});

const Recording = z
  .object({
    id: z.string(),
    demo: z.string(),
    demoVersion: z.number().int(),
    genkiVersion: z.string(),
    status: z.enum(recordingStatuses),
    steps: z.number().int(),
    narrated: z.boolean(),
    voice: z.string().optional(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    seconds: z.number().optional(),
    files: z.array(RecordingFile),
    failure: recordingFailure.optional(),
  })
  .openapi('DemoRecording');

const Demo = demoSpec
  .extend({
    id: z.string(),
    version: z.number().int(),
    updatedBy: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Demo');

const DemoInLibrary = Demo.extend({
  latest: Recording.optional().describe('The newest recording, whatever its result'),
  recorded: Recording.optional().describe('The newest recording that finished'),
});

const genkiVersion = z
  .string()
  .nullable()
  .describe('The version this API runs; a recording on another version is out of date');

export const demoRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/operator/demos',
    summary: 'The demo library: every demo with its newest and newest finished recording',
    responses: {
      200: json(z.object({ genkiVersion, data: z.array(DemoInLibrary) }), 'Demos'),
      ...viewerOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/demos/{id}',
    summary: 'One demo with every recording, newest first',
    request: { params: idParam },
    responses: {
      200: json(Demo.extend({ genkiVersion, recordings: z.array(Recording) }), 'The demo'),
      ...viewerOnly,
      404: problem('No such demo'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/operator/demos/{id}',
    summary:
      'Save a new version of a demo, as JSON or as the YAML of demos/*.yaml (demo editors, audited)',
    request: {
      params: idParam,
      headers: changeReason.extend({
        'if-match': z
          .string()
          .optional()
          .openapi({ description: 'The version you read; 409 if it moved' }),
      }),
      body: {
        required: true,
        content: {
          'application/json': { schema: demoSpec },
          'application/yaml': { schema: z.string() },
        },
      },
    },
    responses: {
      200: json(Demo, 'Saved as a new version'),
      201: json(Demo, 'Created'),
      400: problem('Invalid demo or missing reason'),
      ...viewerOnly,
      409: problem('The demo moved past the version in if-match'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/recordings/{id}',
    summary: 'One recording of a demo',
    request: { params: recordingParam },
    responses: {
      200: json(Recording, 'The recording'),
      ...viewerOnly,
      404: problem('No such recording'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/recordings/{id}/files/{name}',
    summary:
      "One file of a recording: the video, its subtitles, a still, or a failed step's screenshot",
    request: { params: fileParams },
    responses: {
      200: {
        description: 'The file',
        content: {
          'video/mp4': { schema: z.string().openapi({ format: 'binary' }) },
          'application/x-subrip': { schema: z.string() },
          'image/jpeg': { schema: z.string().openapi({ format: 'binary' }) },
          'image/png': { schema: z.string().openapi({ format: 'binary' }) },
        },
      },
      ...viewerOnly,
      404: problem('No such recording or file'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/recorder/demos/{id}/recordings',
    summary: 'Start a recording of the demo as it is stored now (the recorder only)',
    request: {
      params: idParam,
      headers: recorderKey,
      body: { required: true, content: { 'application/json': { schema: recordingStart } } },
    },
    responses: {
      201: json(Recording, 'The recording, running'),
      400: problem('Invalid body'),
      ...recorderOnly,
      404: problem('No such demo'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/recorder/recordings/{id}/files/{name}',
    summary: 'Upload one file of a running recording (the recorder only)',
    request: {
      params: fileParams,
      headers: recorderKey,
      body: {
        required: true,
        content: {
          'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) },
        },
      },
    },
    responses: {
      200: json(RecordingFile, 'Stored'),
      400: problem('Empty file'),
      ...recorderOnly,
      404: problem('No such recording, or a file name the recording does not take'),
      409: problem('The recording has finished'),
      413: problem('The file is too large'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/recorder/recordings/{id}/finish',
    summary: 'Finish a running recording as recorded or failed (the recorder only)',
    request: {
      params: recordingParam,
      headers: recorderKey,
      body: { required: true, content: { 'application/json': { schema: recordingFinish } } },
    },
    responses: {
      200: json(Recording, 'The finished recording'),
      400: problem('Invalid body, no demo.mp4 for a recorded one, or no failure for a failed one'),
      ...recorderOnly,
      404: problem('No such recording'),
      409: problem('The recording has finished'),
    },
  }),
];

type DocumentedApp = { openAPIRegistry?: { registerPath(route: RouteConfig): void } };

export const documentDemoRoutes = (app: unknown) => {
  const registry = (app as DocumentedApp).openAPIRegistry;
  if (!registry) return;
  for (const route of demoRoutes) registry.registerPath(route);
};
