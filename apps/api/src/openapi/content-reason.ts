import { z, type RouteConfig } from '@hono/zod-openapi';
import {
  contentReasonRequiredType,
  contentRoutes,
  skillDefinitionRoutes,
} from '../content-reason.js';
import { Problem } from '../http.js';

const ContentReasonRequired = Problem.extend({
  type: z.literal(contentReasonRequiredType),
  tenant: z.string(),
}).openapi('ContentReasonRequiredProblem');

const refusal = `${contentReasonRequiredType}: an operator has not given today's content reason for this tenant (POST /operator/tenants/{tenant}/content-reason)`;
const note =
  "An operator needs to have given today's content reason for the tenant; each read is in the tenant's audit log.";

type ResponseConfig = Exclude<RouteConfig['responses'][string], { $ref: string }>;

const isContentRoute = (route: RouteConfig) => {
  const key = `${route.method.toUpperCase()} ${route.path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1')}`;
  return contentRoutes.has(key) || skillDefinitionRoutes.has(key);
};

const refused = (existing: ResponseConfig | undefined): ResponseConfig => {
  const media = existing?.content?.['application/problem+json'];
  const problem = media && 'schema' in media ? media.schema : undefined;
  const schema =
    problem && problem !== Problem
      ? z.union([problem as z.ZodType, ContentReasonRequired])
      : ContentReasonRequired;
  return {
    description: existing?.description ? `${existing.description}; or ${refusal}` : refusal,
    content: { ...existing?.content, 'application/problem+json': { schema } },
  };
};

export const withContentReasons = (routes: RouteConfig[]): RouteConfig[] =>
  routes.map((route) =>
    isContentRoute(route)
      ? {
          ...route,
          description: route.description ? `${route.description} ${note}` : note,
          responses: {
            ...route.responses,
            403: refused(route.responses[403] as ResponseConfig | undefined),
          },
        }
      : route,
  );

export const withContentReason = <R extends RouteConfig>(route: R): R =>
  withContentReasons([route])[0] as R;
