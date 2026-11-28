import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import {
  demoFields,
  demoSettings,
  demoSpec,
  lineScore,
  soundReport,
  recordingFailure,
  recordingRequest,
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
  401: problem(
    "urn:genai:problem:recorder-key: no valid recorder key in x-recorder-key and no Entra token of the recorder's workload identity",
  ),
} as const;

const recorderKey = z.object({
  'x-recorder-key': z
    .string()
    .optional()
    .openapi({ description: "The recorder's key, or instead an authorization header" }),
  authorization: z.string().optional().openapi({
    description:
      "Bearer and an Entra application token of the recorder's workload identity for GENAI_DEMO_RECORDER_AUDIENCE",
  }),
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
    .describe(
      'demo.mp4, demo.srt, poster.jpg, sample.mp3, step-{n}.png after each step, failed-step-{n}.png, capture.mp4, events.json, edl.json, edl-round-{0-3}.json, review-round-{1-3}.json, voice-{hash}.mp3 or voice-{hash}.words.json',
    ),
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
    requestedBy: z.string().optional().describe('Who asked for it from the console'),
    upTo: z
      .number()
      .int()
      .optional()
      .describe('A trial of the first steps only, kept out of the library'),
    cancelledBy: z.string().optional(),
    editOf: z.string().optional().describe('The recording whose film this one edits'),
    instruction: z.string().optional().describe('The change asked for in an edit'),
    costCapUsd: z
      .number()
      .optional()
      .describe(
        'The most the recorder may spend on models for this recording, approved by the requester',
      ),
    costUsd: z.number().optional().describe('What the recorder spent on models'),
    lines: z
      .array(lineScore)
      .optional()
      .describe(
        'How each voiced line was heard back: takes read, score (0 is clean), missing and extra words, key terms missed and pace',
      ),
    sound: soundReport
      .optional()
      .describe(
        'Integrated loudness in LUFS of the voice, the music and the mix, and the peak in dBFS',
      ),
  })
  .openapi('DemoRecording');

const recorder = z
  .enum(['job', 'scheduled', 'workflow'])
  .describe(
    'job: a recorder job takes a queued recording at once; scheduled: the demo-recorder workflow picks it up within minutes; workflow: recordings come only from the hand-run demos workflow',
  );

const Settings = demoSettings
  .extend({
    version: z.number().int().describe('0 while the defaults are in use'),
    updatedBy: z.string().optional(),
    updatedAt: z.string().optional(),
    recorder,
    sample: z
      .object({ recording: z.string(), file: z.literal('sample.mp3') })
      .optional()
      .describe('A recording file with a sample of the default voice'),
  })
  .openapi('DemoSettings');

const Demo = demoFields
  .extend({
    id: z.string(),
    version: z.number().int(),
    updatedBy: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Demo');

const DemoInLibrary = Demo.extend({
  latest: Recording.optional().describe(
    'The newest full recording that ended, whatever its result',
  ),
  recorded: Recording.optional().describe('The newest full recording that finished'),
  open: Recording.optional().describe('A recording that is queued or running'),
  editions: z
    .number()
    .int()
    .describe('How many full recordings finished as recorded, edits of a film included'),
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
      200: json(z.object({ genkiVersion, recorder, data: z.array(DemoInLibrary) }), 'Demos'),
      ...viewerOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/demos/{id}',
    summary: 'One demo with every recording, newest first',
    request: { params: idParam },
    responses: {
      200: json(
        Demo.extend({ genkiVersion, recorder, recordings: z.array(Recording) }),
        'The demo',
      ),
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
    method: 'post',
    path: '/operator/demos/{id}/recordings',
    summary:
      'Queue a recording of the demo as it is stored now, a silent trial of its first steps, or an edit of a recorded film by an instruction (demo editors, audited as platform.demo.recording.start)',
    request: {
      params: idParam,
      headers: changeReason,
      body: { required: false, content: { 'application/json': { schema: recordingRequest } } },
    },
    responses: {
      202: json(Recording, 'Queued for the recorder'),
      400: problem(
        'Invalid body, upTo past the last step, editOf not a recorded recording of the demo with capture.mp4, events.json and edl.json, no costCapUsd for an edit or a voice read by a model, or missing reason',
      ),
      ...viewerOnly,
      404: problem('No such demo'),
      409: problem('urn:genai:problem:recording-open: the demo has a recording that has not ended'),
      503: problem(
        'urn:genai:problem:recorder-not-set-up: no recorder here; record with the demos workflow',
      ),
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/recordings/{id}/cancel',
    summary:
      'Cancel a queued or running recording (demo editors, audited as platform.demo.recording.finish)',
    request: { params: recordingParam, headers: changeReason },
    responses: {
      200: json(Recording, 'Cancelled'),
      400: problem('Missing reason'),
      ...viewerOnly,
      404: problem('No such recording'),
      409: problem('urn:genai:problem:recording-finished: the recording has ended'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/demo-settings',
    summary: 'The settings for recording demos',
    responses: { 200: json(Settings, 'The settings'), ...viewerOnly },
  }),
  createRoute({
    method: 'put',
    path: '/operator/demo-settings',
    summary: 'Save the settings for recording demos (demo editors, audited as platform.demo.save)',
    request: {
      headers: changeReason.extend({
        'if-match': z
          .string()
          .optional()
          .openapi({ description: 'The version you read; 409 if it moved' }),
      }),
      body: { required: true, content: { 'application/json': { schema: demoSettings } } },
    },
    responses: {
      200: json(Settings, 'Saved'),
      400: problem('Invalid settings or missing reason'),
      ...viewerOnly,
      409: problem('The settings moved past the version in if-match'),
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
          'audio/mpeg': { schema: z.string().openapi({ format: 'binary' }) },
          'application/json': { schema: z.unknown() },
        },
      },
      ...viewerOnly,
      404: problem('No such recording or file'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/recorder/recordings',
    summary: 'The queued recordings, oldest first, by id and demo (the recorder only)',
    request: {
      query: z.object({
        status: z.enum(['queued']).openapi({ param: { name: 'status', in: 'query' } }),
      }),
      headers: recorderKey,
    },
    responses: {
      200: json(
        z.object({
          data: z.array(
            z.object({
              id: z.string(),
              demo: z.string(),
              editOf: z.string().optional(),
              instruction: z.string().optional(),
            }),
          ),
        }),
        'Queued recordings',
      ),
      400: problem('status is not queued'),
      ...recorderOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/recorder/recordings/{id}',
    summary:
      'A recording with the demo version it records and the recording settings (the recorder only)',
    request: { params: recordingParam, headers: recorderKey },
    responses: {
      200: json(
        Recording.extend({
          demoSpec,
          settings: demoSettings.pick({ voice: true, viewport: true, tenant: true, login: true }),
        }),
        'The recording',
      ),
      ...recorderOnly,
      404: problem('No such recording'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/recorder/recordings/{id}/files/{name}',
    summary:
      'One file of a recorded recording that a queued or running edit points at with editOf (the recorder only)',
    request: { params: fileParams, headers: recorderKey },
    responses: {
      200: {
        description: 'The file',
        content: {
          'video/mp4': { schema: z.string().openapi({ format: 'binary' }) },
          'image/png': { schema: z.string().openapi({ format: 'binary' }) },
          'audio/mpeg': { schema: z.string().openapi({ format: 'binary' }) },
          'application/json': { schema: z.unknown() },
        },
      },
      ...recorderOnly,
      404: problem('No such file, or no open edit of the recording'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/recorder/demos/{id}/recordings',
    summary:
      'Start a recording of the demo as it is stored now, or take up a queued one named by recording (the recorder only)',
    request: {
      params: idParam,
      headers: recorderKey,
      body: { required: true, content: { 'application/json': { schema: recordingStart } } },
    },
    responses: {
      201: json(Recording, 'The recording, running'),
      400: problem('Invalid body'),
      ...recorderOnly,
      404: problem('No such demo, or a queued recording of another demo'),
      409: problem(
        'urn:genai:problem:recording-open: another recording of the demo has not ended; urn:genai:problem:recording-finished: the queued recording was cancelled',
      ),
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
      409: problem('urn:genai:problem:recording-finished: the recording has finished'),
      413: problem('urn:genai:problem:file-too-large: the file is too large'),
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
      409: problem('urn:genai:problem:recording-finished: the recording has finished'),
    },
  }),
];

type DocumentedApp = { openAPIRegistry?: { registerPath(route: RouteConfig): void } };

export const documentDemoRoutes = (app: unknown) => {
  const registry = (app as DocumentedApp).openAPIRegistry;
  if (!registry) return;
  for (const route of demoRoutes) registry.registerPath(route);
};
