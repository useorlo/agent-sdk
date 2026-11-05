/**
 * @orlo/agent-sdk, the TypeScript SDK that agent runtimes use to send their steps to Orlo's agent
 * governance API (the /v1/agent-sessions and /v1/trace-samples routes of the Orlo API).
 * - OrloAgentClient is the thin HTTP client for those routes. It sends the org id in X-Orlo-Org-Id.
 * - OrloAgentRun holds one agent session and governs its model calls and outputs, tool calls and
 *   results, retrievals, and decisions, opening an approval request when a tool call needs one.
 * - createOrloStepCallbacks exposes the same checks as before and after hooks for frameworks.
 * Also re-exports the generic runtime adapter from generic-runtime.ts.
 */
import crypto from 'node:crypto';
import { waitForApprovalDecision, validateApproval, type WaitForApprovalOptions } from './approvals.js';
export { OrloApprovalTimeoutError, type WaitForApprovalOptions } from './approvals.js';
import { taskSystemInstructions } from './skill-content.js';
import { type SkillVersion } from './protocol.js';
import { verifySkillVersion } from './skills.js';
import type {
  AgentActionClass,
  AgentActionReport,
  AgentActionReportReceipt,
  AgentApproval,
  AgentGovernanceDecision,
  AgentPolicyDecisionArtifact,
  AgentSession,
  AgentSessionStatus,
  AgentStep,
  AgentStepType,
  AgentTraceAnnotation,
  AgentTraceSample,
  CreateAgentSessionRequest,
  CreateTraceSampleRequest,
  GovernAgentStepRequest,
  GovernAgentStepResponse,
  TraceSampleAnnotationRequest,
  ToolCheckRequest,
  ToolCheckResponse,
} from './protocol.js';
import {
  CircuitBreaker,
  OrloUnavailableError,
  describeError,
  retryDelayMs,
  sleep,
  type CircuitBreakerOptions,
} from './transport.js';

export { CircuitBreaker, OrloUnavailableError, type CircuitBreakerOptions } from './transport.js';
export type * from './protocol.js';
export type {ResourceContract,ResourceRequest,AccessLimits} from './resource-permissions.js';
export { createToolRegistry, type RegisteredTool, type RegisteredToolCall, type ToolRegistration } from './tool-registry.js';
export { verifySkillVersion } from './skills.js';
export { installSkill } from './skill-installer.js';
export * from './scenario-runner.js';

export interface OrloAgentClientOptions {
  /** Application-supplied signed user token; the SDK does not refresh the identity-provider session. */
  identityTokenProvider?: () => Promise<string | undefined>;
  baseUrl: string;
  orgId: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Per-attempt timeout. Default 3000 ms. */
  timeoutMs?: number;
  /** Extra attempts after a timeout, network error, or 5xx. Each retry reuses the Idempotency-Key. Default 1. */
  retries?: number;
  /** Stop calling Orlo after repeated failures. Pass false to disable. */
  circuitBreaker?: CircuitBreakerOptions | false;
}

export interface CreateAgentSessionResult {
  resource_identity?: {source:'authentication_verified'|'unknown';provider?:string;claim_names:string[];reason?:string;detail?:string;retryable?:boolean;unavailable_claims?:string[]};
  session: AgentSession;
  policy_cache_ttl_s: number;
  /** Step types the SDK must wait on. Servers that predate this field treat every step as blocking. */
  blocking_step_types?: AgentStepType[];
}

const RETRY_BASE_DELAY_MS = 200;

export interface AgentSessionDetail {
  session: AgentSession;
  steps: AgentStep[];
  events: Array<Record<string, unknown>>;
}

export interface ImportAgentTraceRequest {
  steps?: Array<GovernAgentStepRequest & { decision?: AgentGovernanceDecision; created_at?: string }>;
  events?: Array<{
    step_id?: string;
    event_type: string;
    event_source?: string;
    payload?: Record<string, unknown>;
    created_at?: string;
  }>;
}

export interface RequestApprovalInput {
  policy_reason: string;
  request_payload?: Record<string, unknown>;
  approval_timeout_seconds?: number | null;
  timeout_action?: 'reject' | 'escalate' | 'contain' | null;
}

export class OrloApiError extends Error {
  status: number;
  code: string | null;
  details: unknown;

  constructor(message: string, status: number, code: string | null = null, details: unknown = null) {
    super(message);
    this.name = 'OrloApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

async function readErrorPayload(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return await response.text().catch(() => null);
  }
}

function toApiError(response: Response, payload: any): OrloApiError {
  return new OrloApiError(
    payload?.message || payload?.error || response.statusText || 'Orlo request failed',
    response.status,
    payload?.error || null,
    payload,
  );
}

export class OrloAgentClient {
  private readonly identityTokenProvider?: () => Promise<string | undefined>;
  private readonly identityTimes = new Map<string,{iat:number;exp:number;failures:number;retryAt:number}>();
  private readonly baseUrl: string;
  private readonly orgId: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly breaker: CircuitBreaker | null;

  constructor(options: OrloAgentClientOptions) {
    this.identityTokenProvider=options.identityTokenProvider;
    this.baseUrl = options.baseUrl;
    this.orgId = options.orgId;
    this.headers = options.headers || {};
    this.fetchImpl = options.fetch || fetch;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.retries = Math.max(0, options.retries ?? 1);
    this.breaker = options.circuitBreaker === false ? null : new CircuitBreaker(options.circuitBreaker || {});
  }

  private async fetchOnce(path: string, init: RequestInit, idempotencyKey: string | null): Promise<{ response: Response; payload: any }> {
    init.signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Orlo-Org-Id': this.orgId,
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          ...this.headers,
          ...(init.headers || {}),
        },
      });
      const payload = response.status === 204 ? undefined : response.ok ? await response.json() : await readErrorPayload(response);
      controller.signal.throwIfAborted();
      return { response, payload };
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', abort);
    }
  }

  /**
   * Sends one request. Writes carry an Idempotency-Key that stays the same across retries, so a retry
   * after a timeout replays the server's first answer instead of recording the step twice.
   * Throws OrloUnavailableError when Orlo can't be reached, and OrloApiError for other error responses.
   */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = (init.method || 'GET').toUpperCase();
    const idempotencyKey = method === 'GET' || method === 'HEAD' ? null : crypto.randomUUID();
    const attempts = this.retries + 1;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      init.signal?.throwIfAborted();
      if (this.breaker && !this.breaker.canRequest()) {
        throw new OrloUnavailableError('Orlo is unavailable after repeated failures; not calling it until the cooldown ends', lastError);
      }

      let response: Response;
      let payload: any;
      try {
        ({ response, payload } = await this.fetchOnce(path, init, idempotencyKey));
      } catch (err) {
        init.signal?.throwIfAborted();
        lastError = err;
        this.breaker?.recordFailure();
        if (attempt < attempts) {
          await sleep(retryDelayMs(null, attempt, RETRY_BASE_DELAY_MS), init.signal);
          continue;
        }
        throw new OrloUnavailableError(`Orlo could not be reached: ${describeError(err)}`, err);
      }

      if (response.ok) {
        this.breaker?.recordSuccess();
        if (response.status === 204) {
          return undefined as T;
        }
        return payload as T;
      }

      const stillRunning = response.status === 409 && payload?.error === 'IDEMPOTENCY_IN_PROGRESS';
      if (response.status >= 500 || stillRunning) {
        if (!stillRunning) this.breaker?.recordFailure();
        lastError = toApiError(response, payload);
        if (attempt < attempts) {
          await sleep(retryDelayMs(response, attempt, RETRY_BASE_DELAY_MS), init.signal);
          continue;
        }
        if (stillRunning) throw lastError;
        throw new OrloUnavailableError(`Orlo returned ${response.status}`, lastError);
      }

      // Any other response means Orlo is up and answered.
      this.breaker?.recordSuccess();
      throw toApiError(response, payload);
    }

    throw new OrloUnavailableError('Orlo could not be reached', lastError);
  }

  /** Read current status after a webhook, reconnect, or process restart. Requires agent_governance.read. */
  async getApproval(approvalId: string, options: { signal?: AbortSignal } = {}): Promise<AgentApproval> {
    if (!approvalId.trim()) throw new TypeError('approvalId is required');
    return validateApproval(await this.request(`/v1/agent-approvals/${encodeURIComponent(approvalId)}`, { signal: options.signal }), approvalId);
  }

  /** Wait for approved, rejected, or expired. Never executes a tool or changes an approval. */
  async waitForApproval(approvalId: string, options: WaitForApprovalOptions = {}): Promise<AgentApproval> {
    return waitForApprovalDecision((signal) => this.getApproval(approvalId, { signal }), approvalId, options);
  }

  async createSession(input: CreateAgentSessionRequest): Promise<CreateAgentSessionResult> {
    const token=input.identity_token??await this.identityTokenProvider?.();
    const result=await this.request<CreateAgentSessionResult>('/v1/agent-sessions', {
      method: 'POST',
      body: JSON.stringify({...input,...(token?{identity_token:token}:{})}),
    });
    this.rememberIdentity(result.session.id,token,result.resource_identity);
    return result;
  }

  /** Deliver one idempotent lifecycle receipt for a test-scoped scenario trial. */
  async recordScenarioTrialReceipt(trialId: string, executionToken: string, receipt: import('./scenario-runner.js').ScenarioTrialReceipt) {
    return this.request<{trial_id:string;status:string;receipt_id:string;recorded:boolean;scenario_assessment?:Record<string,unknown>|null}>(`/v1/scenario-trials/${encodeURIComponent(trialId)}/receipt`, {
      method: 'POST', headers: { 'X-Orlo-Scenario-Token': executionToken }, body: JSON.stringify(receipt),
    });
  }

  /** Resume only after Orlo confirms the bound approval was granted. */
  async resumeScenarioTrial(trialId: string, executionToken: string) {
    return this.request<{trial_id:string;session_id:string;status:'running';checkpoint_reference:string|null}>(`/v1/scenario-trials/${encodeURIComponent(trialId)}/resume`, {
      method: 'POST', headers: { 'X-Orlo-Scenario-Token': executionToken },
    });
  }

  /** Claim one bounded unit of a frozen comparison; the returned credential is shown once. */
  async claimScenarioTrial(comparisonId:string, runnerId:string, leaseSeconds=120) {
    return this.request<{assignment:import('./scenario-runner.js').ScenarioTrialAssignment|null;comparison_status:string;retry_after_ms:number|null}>(`/v1/scenario-comparisons/${encodeURIComponent(comparisonId)}/trials/claim`,{
      method:'POST',body:JSON.stringify({runner_id:runnerId,lease_seconds:leaseSeconds}),
    });
  }

  /** Fetch an explicit published version; never silently follow the library's latest version. */
  async getSkillVersion(skillId: string, versionId: string): Promise<SkillVersion> {
    const version = await this.request<unknown>(`/v1/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(versionId)}`);
    return verifySkillVersion(version, skillId, versionId);
  }

  async getSession(sessionId: string): Promise<AgentSessionDetail> {
    return this.request(`/v1/agent-sessions/${sessionId}`);
  }

  async updateSessionStatus(sessionId: string, status: AgentSessionStatus): Promise<AgentSession> {
    return this.request(`/v1/agent-sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  }

  async governStep(sessionId: string, input: GovernAgentStepRequest): Promise<GovernAgentStepResponse> {
    let token=input.identity_token;
    const times=this.identityTimes.get(sessionId);
    if(token===undefined&&this.identityTokenProvider&&(!times||times.retryAt<=Date.now()&&times.exp<Date.now()/1000+300)){
      const candidate=await this.identityTokenProvider();
      if(candidate){const claims=this.identityTokenTimes(candidate);if(!times||claims.iat>times.iat)token=candidate;}
    }
    const result=await this.request<GovernAgentStepResponse>(`/v1/agent-sessions/${sessionId}/steps/govern`, {
      method: 'POST',
      body: JSON.stringify({...input,...(token?{identity_token:token}:{})}),
    });
    this.rememberIdentity(sessionId,token,result.resource_identity);
    return result;
  }
  // Unverified timestamps only schedule refresh. The engine authenticates every presented token.
  private identityTokenTimes(token:string):{iat:number;exp:number}{try{const p=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());return {iat:Number(p.iat)||0,exp:Number(p.exp)||0};}catch{return {iat:0,exp:0};}}
  private rememberIdentity(session:string,token:string|undefined,summary?:GovernAgentStepResponse['resource_identity']){
    const prior=this.identityTimes.get(session);
    if(summary?.source==='unknown'){
      // Never use timestamps from a refused token to suppress recovery. Retry once on the next action,
      // then back off repeated failures without replaying the action or retaining token text.
      if(!token&&prior?.failures)return;
      const failures=(prior?.failures??0)+1;
      this.setIdentityTimes(session,{iat:0,exp:0,failures,retryAt:failures===1?0:Date.now()+Math.min(30000,1000*2**Math.min(failures-2,5))});
    }else if(token){
      // An absent summary supports older servers; an explicit unknown summary always takes precedence.
      this.setIdentityTimes(session,{...this.identityTokenTimes(token),failures:0,retryAt:0});
    }
  }
  private setIdentityTimes(session:string,value:{iat:number;exp:number;failures:number;retryAt:number}){
    if(!this.identityTimes.has(session)&&this.identityTimes.size>=1024)this.identityTimes.delete(this.identityTimes.keys().next().value!);
    this.identityTimes.set(session,value);
  }

  /** Await durable receipt. Reuse report_id when resending the same report after a restart. */
  async recordActionReport(sessionId: string, actionId: string, report: AgentActionReport): Promise<AgentActionReportReceipt> {
    if (!actionId?.trim()) throw new TypeError('Use the action_id returned by a governed tool request. Upgrade the Orlo server if it is absent.');
    return this.request(`/v1/agent-sessions/${encodeURIComponent(sessionId)}/actions/${encodeURIComponent(actionId)}/reports`, { method: 'POST', body: JSON.stringify(report) });
  }

  async checkTool(sessionId: string, input: ToolCheckRequest): Promise<ToolCheckResponse> {
    return this.request(`/v1/agent-sessions/${sessionId}/tools/check`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async requestApproval(sessionId: string, stepId: string, input: RequestApprovalInput): Promise<AgentApproval> {
    return this.request(`/v1/agent-sessions/${sessionId}/steps/${stepId}/request-approval`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async importTrace(sessionId: string, input: ImportAgentTraceRequest): Promise<{ inserted_steps: number; inserted_events: number }> {
    return this.request(`/v1/agent-sessions/${sessionId}/traces/import`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async promoteStepToTraceSample(
    sessionId: string,
    stepId: string,
    input: CreateTraceSampleRequest = {},
  ): Promise<{ trace_sample: AgentTraceSample }> {
    return this.request(`/v1/agent-sessions/${sessionId}/steps/${stepId}/promote-to-trace-sample`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async listTraceSamples(input: { taskId?: string; status?: string; limit?: number } = {}): Promise<{ trace_samples: AgentTraceSample[] }> {
    const params = new URLSearchParams();
    if (input.taskId) params.set('task_id', input.taskId);
    if (input.status) params.set('status', input.status);
    if (typeof input.limit === 'number') params.set('limit', String(input.limit));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.request(`/v1/trace-samples${suffix}`);
  }

  async getTraceSample(traceSampleId: string): Promise<{ trace_sample: AgentTraceSample; annotations: AgentTraceAnnotation[] }> {
    return this.request(`/v1/trace-samples/${traceSampleId}`);
  }

  async annotateTraceSample(traceSampleId: string, input: TraceSampleAnnotationRequest): Promise<AgentTraceAnnotation> {
    return this.request(`/v1/trace-samples/${traceSampleId}/annotations`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** Creates an additive version from the latest datasetId; repeats return the existing promotion. */
  async promoteTraceSampleToDataset(traceSampleId: string, datasetId: string): Promise<{
    trace_sample: AgentTraceSample;
    dataset_sample_id: string | null;
    dataset: { id: string; version: number; sample_count: number; parent_dataset_id: string | null };
    already_added: boolean;
  }> {
    return this.request(`/v1/trace-samples/${traceSampleId}/promote-to-dataset`, {
      method: 'POST',
      body: JSON.stringify({ dataset_id: datasetId }),
    });
  }
}

export interface StartAgentRunInput extends CreateAgentSessionRequest {}

export type FailMode = 'open' | 'closed';

/**
 * What a tool call does when Orlo can't be reached: 'open' lets it run and attempts background reporting,
 * 'closed' blocks it. Keyed by action class, with `default` for the rest.
 */
export type FailModeConfig = Partial<Record<AgentActionClass | 'default', FailMode>>;

/** Every tool call stops during an Orlo outage unless its action class explicitly opts in. */
export const DEFAULT_FAIL_MODE: Readonly<FailModeConfig> = Object.freeze({ default: 'closed' });

export interface AgentRunOptions {
  failMode?: FailModeConfig;
}

export interface BeforeToolCallResult {
  governance: GovernAgentStepResponse;
  approval: AgentApproval | null;
  /** True when Orlo couldn't be reached and the action class fails open. Background reporting is attempted; delivery is not guaranteed. */
  failedOpen?: boolean;
}

const ALL_STEP_TYPES: AgentStepType[] = [
  'model_call',
  'model_output',
  'tool_request',
  'tool_result',
  'retrieval',
  'decision',
  'approval_request',
  'approval_result',
  'state_transition',
];

function failOpenResponse(sessionId: string, stepId: string, parentStepId: string | null): GovernAgentStepResponse {
  const policyDecision: AgentPolicyDecisionArtifact = {
    decision: 'allow',
    reason_code: 'orlo_unreachable_fail_open',
    reason_summary: "Orlo couldn't be reached and this action class fails open",
    matched_policies: [],
    decision_latency_ms: null,
    degraded_mode: true,
  };
  return {
    decision: 'allow',
    reason: "Orlo couldn't be reached. Allowed because this action class fails open.",
    trace_id: `local-${crypto.randomUUID()}`,
    risk_tier: 'low',
    containment: null,
    validation: null,
    policy_decision: policyDecision,
    citations: [],
    state_change: null,
    envelope: {
      version: 'governed_step_envelope_v1',
      session_id: sessionId,
      step_id: stepId,
      parent_step_id: parentStepId,
      step_type: 'tool_request',
      phase: 'pre',
      actor: 'runtime',
      request: null,
      result: null,
      citations: [],
      policy_decision: policyDecision,
      risk_tier: 'low',
      state_change: null,
      timing: null,
      idempotency_key: null,
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    },
    retrieval: null,
  };
}

export class OrloAgentRun {
  readonly client: OrloAgentClient;
  readonly sessionId: string;
  readonly session: AgentSession;
  readonly policyCacheTtlSeconds: number;
  /** Step types the SDK waits on. Other steps are sent in the background; Orlo still records and checks them. */
  readonly blockingStepTypes: ReadonlySet<AgentStepType>;
  private readonly failMode: FailModeConfig;
  private readonly pending = new Set<Promise<void>>();
  private unsent = 0;

  private constructor(
    client: OrloAgentClient,
    session: AgentSession,
    policyCacheTtlSeconds: number,
    blockingStepTypes: AgentStepType[] | undefined,
    options: AgentRunOptions,
  ) {
    this.client = client;
    this.sessionId = session.id;
    this.session = session;
    this.policyCacheTtlSeconds = policyCacheTtlSeconds;
    this.blockingStepTypes = new Set(blockingStepTypes ?? ALL_STEP_TYPES);
    this.failMode = { ...DEFAULT_FAIL_MODE, ...(options.failMode || {}) };
  }

  static async start(client: OrloAgentClient, input: StartAgentRunInput, options: AgentRunOptions = {}): Promise<OrloAgentRun> {
    const result = await client.createSession(input);
    return new OrloAgentRun(client, result.session, result.policy_cache_ttl_s, result.blocking_step_types, options);
  }

  /** Reattach to a saved active or paused run after a restart. Does not create or reopen a session. */
  static async resume(client: OrloAgentClient, sessionId: string, options: AgentRunOptions = {}): Promise<OrloAgentRun> {
    const { session } = await client.getSession(sessionId);
    if (session.id !== sessionId || !['active', 'paused'].includes(session.status)) {
      throw new Error('Only an active or paused Orlo session can be resumed');
    }
    // The detail endpoint has no cached blocking-step contract; conservatively wait on all steps.
    return new OrloAgentRun(client, session, 0, undefined, options);
  }

  /** Load immutable content and record its identities before any agent work starts. */
  static async startWithSkills(client: OrloAgentClient, input: Omit<StartAgentRunInput, 'skill_versions'>,
    references: Array<{ skillId: string; versionId: string }>, options: AgentRunOptions = {}): Promise<{ run: OrloAgentRun; skills: SkillVersion[]; instructions: string }> {
    if (!references.length || references.length > 8 || new Set(references.map((r) => r.skillId)).size !== references.length) {
      throw new Error('Select between one and eight skills, with one explicit version per skill.');
    }
    const skills = await Promise.all(references.map((r) => client.getSkillVersion(r.skillId, r.versionId)));
    const skillVersions = skills.map((skill) => ({ skill_id: skill.skill_id, version_id: skill.id, content_hash: skill.content_hash }));
    const run = await OrloAgentRun.start(client, { ...input, skill_versions: skillVersions }, options);
    // Older servers must not silently accept a run without recording the declared versions.
    if (JSON.stringify(run.session.skill_versions?.map(({ skill_id, version_id, content_hash }) => ({ skill_id, version_id, content_hash }))) !== JSON.stringify(skillVersions)) {
      await client.updateSessionStatus(run.sessionId, 'cancelled');
      throw new Error('This Orlo server did not record the requested skill versions. Upgrade it before starting a skill-backed run.');
    }
    return { run, skills, instructions: taskSystemInstructions({ skills }, {}) };
  }

  isBlocking(stepType: AgentStepType): boolean {
    return this.blockingStepTypes.has(stepType);
  }

  failModeFor(actionClass: AgentActionClass | null | undefined): FailMode {
    return (actionClass ? this.failMode[actionClass] : undefined) ?? this.failMode.default ?? 'closed';
  }

  /** Steps that couldn't be sent, even after retries. */
  get unsentSteps(): number {
    return this.unsent;
  }

  private track(sending: Promise<unknown>): void {
    const tracked = sending.then(
      () => undefined,
      () => {
        this.unsent += 1;
      },
    );
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  /** Sends a step without waiting for Orlo's answer. Orlo still records and checks it. */
  report(stepType: AgentStepType, input: Omit<GovernAgentStepRequest, 'step_type'>): void {
    this.track(this.client.governStep(this.sessionId, { ...input, step_type: stepType }));
  }

  /** Explicit reporting returns only after Orlo records it; delivery failures remain visible to the caller. */
  async recordActionReport(actionId: string, report: AgentActionReport): Promise<AgentActionReportReceipt> {
    return this.client.recordActionReport(this.sessionId, actionId, report);
  }

  /** Best-effort background reporting; flush() waits and unsentSteps includes failed reports. */
  reportAction(actionId: string, report: AgentActionReport): void {
    this.track(this.recordActionReport(actionId, report));
  }

  /** Waits for steps sent in the background. complete() calls this first. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  async governModelCall(input: Omit<GovernAgentStepRequest, 'step_type'>): Promise<GovernAgentStepResponse> {
    return this.client.governStep(this.sessionId, { ...input, step_type: 'model_call' });
  }

  async governModelOutput(input: Omit<GovernAgentStepRequest, 'step_type'>): Promise<GovernAgentStepResponse> {
    return this.client.governStep(this.sessionId, { ...input, step_type: 'model_output' });
  }

  async governToolResult(input: Omit<GovernAgentStepRequest, 'step_type'>): Promise<GovernAgentStepResponse> {
    return this.client.governStep(this.sessionId, { ...input, step_type: 'tool_result' });
  }

  async governToolRequest(
    input: Omit<GovernAgentStepRequest, 'step_type'>,
  ): Promise<GovernAgentStepResponse> {
    return this.client.governStep(this.sessionId, { ...input, step_type: 'tool_request' });
  }

  async recordRetrieval(input: Omit<GovernAgentStepRequest, 'step_type'>): Promise<GovernAgentStepResponse> {
    return this.client.governStep(this.sessionId, { ...input, step_type: 'retrieval' });
  }

  async recordDecision(input: Omit<GovernAgentStepRequest, 'step_type'>): Promise<GovernAgentStepResponse> {
    return this.client.governStep(this.sessionId, { ...input, step_type: 'decision' });
  }

  /**
   * Governs a tool call before it runs and, when Orlo requires approval, opens one for it.
   * After the reviewer decides, call again with the same `step_id` and the same arguments:
   * an approved call is allowed once, a rejected call is rejected, and changed arguments
   * need a new approval. The SDK does not wait for the decision.
   */
  async beforeToolCall(
    input: ToolCheckRequest & {
      autoRequestApproval?: boolean;
      parent_step_id?: string;
      model_name?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<BeforeToolCallResult> {
    const { autoRequestApproval = true, ...toolCheck } = input;
    const request = {
      step_id: toolCheck.step_id,
      parent_step_id: input.parent_step_id,
      tool_name: toolCheck.tool_name,
      model_name: input.model_name,
      action_class: toolCheck.action_class,
      environment: toolCheck.environment,
      input: toolCheck.arguments,
      resource:toolCheck.resource,
      metadata: input.metadata,
    };

    let governance: GovernAgentStepResponse;
    try {
      governance = await this.governToolRequest(request);
    } catch (err) {
      if (toolCheck.resource || !(err instanceof OrloUnavailableError) || this.failModeFor(toolCheck.action_class) !== 'open') {
        throw err;
      }
      // Explicit fail-open: attempt reporting with bounded retries; there is no persistent replay queue.
      this.track(this.client.importTrace(this.sessionId, {
        steps: [{
          ...request,
          step_type: 'tool_request',
          decision: 'allow',
          metadata: { ...(input.metadata || {}), fail_open: true, fail_open_reason: describeError(err) },
        }],
        events: [{
          step_id: toolCheck.step_id,
          event_type: 'sdk:fail_open',
          event_source: 'agent-sdk',
          payload: { tool_name: toolCheck.tool_name, action_class: toolCheck.action_class || null },
        }],
      }));
      return {
        governance: failOpenResponse(this.sessionId, toolCheck.step_id, input.parent_step_id || null),
        approval: null,
        failedOpen: true,
      };
    }
    let approval: AgentApproval | null = null;

    if (governance.decision === 'require_approval' && autoRequestApproval) {
      approval = await this.client.requestApproval(this.sessionId, toolCheck.step_id, {
        policy_reason: governance.reason || `Tool "${toolCheck.tool_name}" requires approval`,
        request_payload: {
          tool_name: toolCheck.tool_name,
          arguments: toolCheck.arguments || {},
          ...(governance.resource_contract?{resource_contract:governance.resource_contract}:{}),
          action_class: toolCheck.action_class || null,
          environment: toolCheck.environment || null,
        },
      });
    }

    return { governance, approval };
  }

  async complete(status: Extract<AgentSessionStatus, 'completed' | 'failed' | 'cancelled' | 'timed_out'> = 'completed'): Promise<AgentSession> {
    await this.flush();
    return this.client.updateSessionStatus(this.sessionId, status);
  }
}

export interface CreateOrloCallbacksOptions {
  run: OrloAgentRun;
  autoRequestApproval?: boolean;
}

export interface OrloStepCallbacks {
  beforeModelCall(input: Omit<GovernAgentStepRequest, 'step_type'>): Promise<GovernAgentStepResponse>;
  afterModelOutput(input: Omit<GovernAgentStepRequest, 'step_type'>): Promise<GovernAgentStepResponse>;
  beforeToolCall(
    input: ToolCheckRequest & {
      parent_step_id?: string;
      model_name?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<BeforeToolCallResult>;
  afterToolResult(input: Omit<GovernAgentStepRequest, 'step_type'>): Promise<GovernAgentStepResponse>;
  recordDecision(input: Omit<GovernAgentStepRequest, 'step_type'>): Promise<GovernAgentStepResponse>;
  recordRetrieval(input: Omit<GovernAgentStepRequest, 'step_type'>): Promise<GovernAgentStepResponse>;
  close(status?: Extract<AgentSessionStatus, 'completed' | 'failed' | 'cancelled' | 'timed_out'>): Promise<AgentSession>;
}

export function createOrloStepCallbacks(options: CreateOrloCallbacksOptions): OrloStepCallbacks {
  return {
    beforeModelCall(input) {
      return options.run.governModelCall(input);
    },
    afterModelOutput(input) {
      return options.run.governModelOutput(input);
    },
    beforeToolCall(input) {
      return options.run.beforeToolCall({
        ...input,
        autoRequestApproval: options.autoRequestApproval,
      });
    },
    afterToolResult(input) {
      return options.run.governToolResult(input);
    },
    recordDecision(input) {
      return options.run.recordDecision(input);
    },
    recordRetrieval(input) {
      return options.run.recordRetrieval(input);
    },
    close(status) {
      return options.run.complete(status);
    },
  };
}

export function createStepId(prefix: string = 'step'): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export * from './generic-runtime.js';
