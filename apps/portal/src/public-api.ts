import { setting } from './runtime-config';
export const publicApiBase = (setting('PUBLIC_API_BASE') ?? 'http://localhost:8080').replace(
  /\/+$/,
  '',
);
