/** Bounded local runner for frozen multi-turn trials; customer agent code stays in its own runtime. */
import crypto from 'node:crypto';
import { OrloAgentClient, OrloAgentRun } from './index.js';

export interface ScenarioRunnerDefinition {
  version: 1;
  environment: { name:string; version:string; implementation_hash:string };
  simulator: { kind:'scripted'|'model'; version:string; implementation_hash:string; provider?:string; model_id?:string; settings_hash?:string };
  initial_state: Record<string, unknown>;
  interactions: Array<{ after_turn: number; actor: 'user' | 'environment'; content: string }>;
  tools: Array<{ name:string; schema_hash:string; effect:'read'|'write'; resource?: {resource_type:string;operation:string} }>;
  verifiers: ScenarioVerifierDeclaration[];
  budgets: { max_turns: number; max_tool_calls: number; max_duration_ms: number; max_cost_usd: number | null };
}

export interface ScenarioVerifierDeclaration {
  key: string;
  version: string;
  implementation_hash: string;
  dimension: 'outcome' | 'permission' | 'interaction' | 'efficiency';
  evidence_source: 'authoritative_state' | 'permission_receipt' | 'application_report' | 'human_judgment' | 'model_judgment';
  mandatory: boolean;
  specification: Record<string, unknown>;
}

export interface ScenarioVerifierResult {
  version: 1;
  verifier_key: string;
  verifier_version: string;
  implementation_hash: string;
  dimension: ScenarioVerifierDeclaration['dimension'];
  evidence_source: ScenarioVerifierDeclaration['evidence_source'];
  status: 'passed' | 'failed' | 'unknown' | 'error';
  mandatory: boolean;
  evidence_reference: string | null;
  reason: string;
  evidence?: Record<string, unknown>;
}

export interface ScenarioTrialAssignment {
  trial_id: string;
  task_id: string;
  execution_token: string;
  scenario: ScenarioRunnerDefinition;
  candidate: Record<string, unknown>;
  repetition: number;
  attempt: number;
  lease_expires_at: string;
}

export interface ScenarioEnvironment {
  prepare(initialState: Record<string, unknown>, signal: AbortSignal): Promise<void>;
  restore?(checkpointReference: string, signal: AbortSignal): Promise<void>;
  verify?(declarations: ScenarioVerifierDeclaration[], signal: AbortSignal): Promise<ScenarioVerifierResult[]>;
  cleanup(signal: AbortSignal): Promise<{ status: 'succeeded' | 'failed'; detail?: string }>;
}

export interface ScenarioExecutionContext {
  run: OrloAgentRun;
  scenario: ScenarioRunnerDefinition;
  candidate: Record<string, unknown>;
  signal: AbortSignal;
  resumed: boolean;
}

export type ScenarioExecutionResult =
  | { status: 'completed'; metrics?: { turns?: number; tool_calls?: number; cost_usd?: number; [key:string]:unknown } }
  | { status: 'awaiting_approval'; approval_id: string; checkpoint_reference: string; metrics?: Record<string, unknown> };

export interface ScenarioTrialReceipt {
  receipt_id: string;
  session_id: string;
  status: 'completed' | 'failed' | 'invalid' | 'cancelled' | 'awaiting_approval';
  approval_id?: string;
  checkpoint_reference?: string;
  metrics?: Record<string, unknown>;
  failure?: Record<string, unknown>;
  cleanup: { status: 'succeeded' | 'failed'; detail?: string };
  verifier_results?: ScenarioVerifierResult[];
}

export interface ScenarioTrialRunResult {
  trial_id: string;
  session_id: string;
  status: ScenarioTrialReceipt['status'];
  receipt_id: string;
  recorded: boolean;
}

export interface ScenarioRunnerOptions {
  signal?: AbortSignal;
  resume?: { session_id: string; checkpoint_reference: string };
}

export class ScenarioTrialDeliveryError extends Error {
  constructor(readonly receipt: ScenarioTrialReceipt, cause: unknown) {
    super('The scenario ran, but Orlo did not acknowledge its lifecycle receipt.', { cause });
    this.name = 'ScenarioTrialDeliveryError';
  }
}

function pointerValue(value: unknown, pointer: string): { present: boolean; value: unknown } {
  if (pointer === '') return { present: true, value };
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return { present: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { present: true, value: current };
}

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

/** Checks a frozen declaration against state read through the customer's authoritative test adapter. */
export function evaluateAuthoritativeStateVerifier(
  declaration: ScenarioVerifierDeclaration,
  finalState: unknown,
  evidenceReference: string,
): ScenarioVerifierResult {
  if (declaration.evidence_source !== 'authoritative_state') throw new TypeError('The verifier must use authoritative_state evidence.');
  const path = declaration.specification.path;
  if (typeof path !== 'string' || (path !== '' && !path.startsWith('/'))) throw new TypeError('The verifier path must be a JSON pointer.');
  const observed = pointerValue(finalState, path);
  const expectsAbsent = declaration.specification.absent === true;
  const passed = expectsAbsent ? !observed.present : observed.present && canonical(observed.value) === canonical(declaration.specification.equals);
  return { version:1, verifier_key:declaration.key, verifier_version:declaration.version, implementation_hash:declaration.implementation_hash,
    dimension:declaration.dimension, evidence_source:declaration.evidence_source, mandatory:declaration.mandatory, status:passed?'passed':'failed',
    evidence_reference:evidenceReference, reason:passed?`The authoritative state matched ${path || 'the root value'}.`:`The authoritative state did not match ${path || 'the root value'}.`,
    evidence:expectsAbsent?{present:observed.present}:{present:observed.present,observed:observed.value} };
}

function combinedSignal(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(external?.reason);
  if (external?.aborted) controller.abort(external.reason);
  else external?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Scenario deadline exceeded', 'TimeoutError')), timeoutMs);
  return { signal: controller.signal, clear() { clearTimeout(timer); external?.removeEventListener('abort', onAbort); } };
}

function failureOf(error: unknown): Record<string, unknown> {
  return { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) };
}

async function withinSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function budgetFailure(result: ScenarioExecutionResult, definition: ScenarioRunnerDefinition): {message:string;invalid:boolean}|null {
  const metrics = result.metrics ?? {};
  if (typeof metrics.turns !== 'number' || !Number.isFinite(metrics.turns) || metrics.turns < 0) return {message:'The runner did not report a valid turn count.',invalid:true};
  if (typeof metrics.tool_calls !== 'number' || !Number.isFinite(metrics.tool_calls) || metrics.tool_calls < 0) return {message:'The runner did not report a valid tool-call count.',invalid:true};
  if (metrics.turns > definition.budgets.max_turns) return {message:'The agent exceeded the declared turn budget.',invalid:false};
  if (metrics.tool_calls > definition.budgets.max_tool_calls) return {message:'The agent exceeded the declared tool-call budget.',invalid:false};
  const cost=metrics.cost_usd;
  if (definition.budgets.max_cost_usd !== null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) return {message:'The runner did not report a valid cost.',invalid:true};
  if (definition.budgets.max_cost_usd !== null && typeof cost==='number'&&cost > definition.budgets.max_cost_usd) return {message:'The agent exceeded the declared cost budget.',invalid:false};
  return null;
}

export class OrloScenarioRunner {
  constructor(private readonly client: OrloAgentClient) {}

  async run(
    assignment: ScenarioTrialAssignment,
    environment: ScenarioEnvironment,
    execute: (context: ScenarioExecutionContext) => Promise<ScenarioExecutionResult>,
    options: ScenarioRunnerOptions = {},
  ): Promise<ScenarioTrialRunResult> {
    const bounded = combinedSignal(options.signal, assignment.scenario.budgets.max_duration_ms);
    const started = Date.now(); let run: OrloAgentRun | null = null; let cleanupNeeded = false; let execution: ScenarioExecutionResult | null = null;
    let verifierResults: ScenarioVerifierResult[] = []; let thrown: unknown = null;
    try {
      bounded.signal.throwIfAborted();
      if (options.resume) {
        const resumed = await withinSignal(this.client.resumeScenarioTrial(assignment.trial_id, assignment.execution_token), bounded.signal);
        if (resumed.session_id !== options.resume.session_id || resumed.checkpoint_reference !== options.resume.checkpoint_reference) throw new Error('The saved continuation does not match Orlo\'s paused trial.');
        if (!environment.restore) throw new Error('This environment cannot restore a paused scenario.');
        cleanupNeeded = true;
        await withinSignal(environment.restore(options.resume.checkpoint_reference, bounded.signal), bounded.signal);
        run = await withinSignal(OrloAgentRun.resume(this.client, options.resume.session_id), bounded.signal);
      } else {
        cleanupNeeded = true;
        await withinSignal(environment.prepare(assignment.scenario.initial_state, bounded.signal), bounded.signal);
        run = await withinSignal(OrloAgentRun.start(this.client, { task_id: assignment.task_id, framework: 'orlo-scenario-runner',
          test_context: { kind: 'scenario_trial', trial_id: assignment.trial_id, execution_token: assignment.execution_token } }), bounded.signal);
      }
      execution = await withinSignal(execute({ run, scenario: assignment.scenario, candidate:assignment.candidate, signal: bounded.signal, resumed: Boolean(options.resume) }), bounded.signal);
      await withinSignal(run.flush(), bounded.signal);
      if (execution.status === 'completed') {
        const external = assignment.scenario.verifiers.filter(verifier => verifier.evidence_source !== 'permission_receipt');
        verifierResults = environment.verify ? await withinSignal(environment.verify(external, bounded.signal), bounded.signal) : [];
      }
    } catch (error) { thrown = error; }

    let cleanup: ScenarioTrialReceipt['cleanup'] = { status: 'succeeded' };
    if (cleanupNeeded) {
      const cleanupBound = combinedSignal(undefined, Math.min(10_000, assignment.scenario.budgets.max_duration_ms));
      try { cleanup = await withinSignal(environment.cleanup(cleanupBound.signal), cleanupBound.signal); }
      catch (error) { cleanup = { status: 'failed', detail: error instanceof Error ? error.message : String(error) }; }
      finally { cleanupBound.clear(); }
    }
    bounded.clear();

    const budget = execution ? budgetFailure(execution, assignment.scenario) : null;
    let status: ScenarioTrialReceipt['status'];
    if (cleanup.status === 'failed') status = 'invalid';
    else if (thrown) status = options.signal?.aborted ? 'cancelled' : 'failed';
    else if (budget) status = budget.invalid?'invalid':'failed';
    else status = execution!.status;
    const receipt: ScenarioTrialReceipt = {
      receipt_id: crypto.randomUUID(), session_id: run?.sessionId ?? options.resume?.session_id ?? '', status,
      ...(execution?.status === 'awaiting_approval' ? { approval_id: execution.approval_id, checkpoint_reference: execution.checkpoint_reference } : {}),
      metrics: { ...(execution?.metrics ?? {}), duration_ms: Date.now() - started, unsent_steps: run?.unsentSteps ?? 0 },
      ...(status === 'completed' ? { verifier_results: verifierResults } : {}),
      ...((thrown || budget || cleanup.status === 'failed') ? { failure: { ...(thrown ? failureOf(thrown) : {}), ...(budget ? { budget:budget.message } : {}), ...(cleanup.status === 'failed' ? { cleanup: cleanup.detail ?? 'Cleanup failed.' } : {}) } } : {}),
      cleanup,
    };
    if (!receipt.session_id) throw thrown ?? new Error('The scenario session was not created.');
    try {
      const recorded = await this.client.recordScenarioTrialReceipt(assignment.trial_id, assignment.execution_token, receipt);
      return { trial_id: assignment.trial_id, session_id: receipt.session_id, status: recorded.status as ScenarioTrialReceipt['status'], receipt_id: receipt.receipt_id, recorded: recorded.recorded };
    } catch (error) { throw new ScenarioTrialDeliveryError(receipt, error); }
  }
}

/** Runs assignments with a fixed worker count; it never starts an unbounded Promise.all. */
export async function runScenarioTrials(
  assignments: ScenarioTrialAssignment[], concurrency: number,
  run: (assignment: ScenarioTrialAssignment) => Promise<ScenarioTrialRunResult>,
): Promise<PromiseSettledResult<ScenarioTrialRunResult>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new TypeError('concurrency must be an integer from 1 to 32');
  const results: PromiseSettledResult<ScenarioTrialRunResult>[] = new Array(assignments.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, assignments.length) }, async () => {
    while (next < assignments.length) {
      const index = next; next += 1;
      try { results[index] = { status: 'fulfilled', value: await run(assignments[index]!) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }));
  return results;
}
