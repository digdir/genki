import type {
  CapabilityDescriptor,
  Event,
  EventAudience,
  Input,
  Part,
  Principal,
  Ref,
  ResourceProvenance,
  ServiceProvenance,
  Task,
  Usage,
} from '@genai/contracts';

export const KERNEL_MAJOR = 1;

export type Feature = 'interrupts' | 'checkpoint' | 'artifacts' | 'duplex' | 'subinvoke';

export const supportedFeatures: readonly Feature[] = ['interrupts', 'checkpoint', 'subinvoke'];

export interface Grant {
  port: string;
  ref: Ref;
}

export interface Capability<C = unknown> {
  descriptor: CapabilityDescriptor;
  strategy: { id: string; version: string };
  config: C;
  grants: Grant[];
  budget?: Usage;
  deadlineMs?: number;
}

export type Emitted<D = unknown> = Pick<Event<D>, 'type' | 'data'> &
  Partial<Pick<Event<D>, 'v' | 'fallback' | 'audience' | 'span'>>;

export interface Strategy<C = unknown> {
  id: string;
  version: string;
  requires: { kernel: number; ports: string[]; features: Feature[] };
  run(ctx: InvocationContext, input: Input, config: C): AsyncIterable<Emitted>;
  resume?(
    ctx: InvocationContext,
    checkpoint: unknown,
    response: Input,
    config: C,
  ): AsyncIterable<Emitted>;
}

export type Decision = { allow: true } | { allow: false; reason: string };

export type PolicyAction =
  'invoke' | 'read' | 'read-audit' | 'resume' | 'cancel' | 'annotate' | `use:${string}`;

export interface PolicyDecisionPoint {
  decide(principal: Principal, action: PolicyAction, resource: Ref): Promise<Decision>;
}

export interface PortContext {
  tenant: string;
  principal: Principal;
  task: string;
  signal: AbortSignal;
  meter(usage: Usage, model?: Ref): Promise<void>;
  outputLimit?(): number | undefined;
  provenance?(resource: ResourceProvenance): Promise<void>;
}

export interface PortProvider<P = unknown> {
  open(ref: Ref, ctx: PortContext): P;
}

export type StateScope = 'task' | 'thread' | 'principal';

export interface StateHandle {
  get<T>(scope: StateScope, key: string): Promise<{ v: number; value: T } | undefined>;
  put(scope: StateScope, key: string, value: unknown, expectV?: number): Promise<number>;
  checkpoint(value: unknown): Promise<void>;
}

export interface Budget {
  remaining(): Usage | undefined;
  charge(usage: Usage): Promise<void>;
}

export interface InvocationContext {
  principal: Principal;
  capability: CapabilityDescriptor;
  service: ServiceProvenance;
  responder?: Principal;
  tenant: string;
  task: string;
  thread?: string;
  entryPoint?: string;
  signal: AbortSignal;
  budget: Budget;
  state: StateHandle;
  use<P>(port: string, ref: Ref): Promise<P>;
  invoke(capabilityId: string, input: Input): Promise<Run>;
}

export interface Run {
  task: string;
  events: AsyncIterable<Event>;
  result: Promise<Part[]>;
}

export interface InvokeOptions {
  thread?: string;
  entryPoint?: string;
  deadlineMs?: number;
  budget?: Usage;
  maxOutputTokens?: number;
}

export interface EventsOptions {
  fromSeq?: number;
  audience?: EventAudience;
}

export interface Annotation {
  type: 'kernel.score' | 'kernel.feedback';
  data: unknown;
}

export interface Kernel {
  describe(principal: Principal): Promise<CapabilityDescriptor[]>;
  invoke(
    principal: Principal,
    capabilityId: string,
    input: Input,
    options?: InvokeOptions,
  ): Promise<Run>;
  resume(principal: Principal, task: string, interrupt: string, response: Input): Promise<Run>;
  cancel(principal: Principal, task: string): Promise<void>;
  task(principal: Principal, task: string): Promise<Task>;
  events(
    principal: Principal,
    task: string,
    options?: EventsOptions,
  ): Promise<AsyncIterable<Event>>;
  annotate(principal: Principal, task: string, annotation: Annotation): Promise<void>;
  pending(principal: Principal): Promise<Task[]>;
}

export type KernelErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'budget_exceeded'
  | 'deadline_exceeded'
  | 'limit_exceeded'
  | 'invalid_event'
  | 'invalid_state'
  | 'interrupted'
  | 'cancelled'
  | 'misconfigured';

export class KernelError extends Error {
  constructor(
    readonly code: KernelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KernelError';
  }
}
