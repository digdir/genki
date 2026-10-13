export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface Target {
  name: string;
  baseUrl: string;
  apiKey?: string;
}

export interface Request {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: JsonValue;
  auth?: boolean;
}

export type SseFrame =
  { kind: 'data'; data: JsonValue | string } | { kind: 'comment'; text: string };

export interface Captured {
  status: number;
  headers: Record<string, string>;
  body?: JsonValue | string;
  frames?: SseFrame[];
}

export interface StepResult {
  request: Request;
  response: Captured;
}

export type Mode = 'exact' | 'shape';

export type Needs = 'llm' | 'dataset' | 'wave3';

export type Side = 'old' | 'new';

export interface Step {
  name: string;
  request: (previous: StepResult[], side: Side) => Request;
  mode: Mode;
  check?: (response: Captured, previous: StepResult[]) => string[];
}

export interface Scenario {
  id: string;
  title: string;
  steps: Step[];
  needs?: Needs[];
  comparedHeaders?: string[];
}

export interface Recording {
  scenario: string;
  recordedAt: string;
  target: string;
  steps: StepResult[];
}
