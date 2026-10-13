export const publicApiBase = (
  (import.meta.env.VITE_PUBLIC_API_BASE as string | undefined) ?? 'http://localhost:8080'
).replace(/\/+$/, '');
