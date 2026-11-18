export type ContentRoute =
  | { page: 'oversikt' }
  | { page: 'malbilde' }
  | { page: 'byggeklosser'; id?: string; sub?: string }
  | { page: 'tjenester'; id?: string; del?: 'bruk' | 'oppsett'; steg?: number }
  | { page: 'sok'; q?: string }
  | { page: 'typer'; id?: string }
  | { page: 'status'; id?: string }
  | { page: 'kom-i-gang' }
  | { page: 'ikke-funnet' };
