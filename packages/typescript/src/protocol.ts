/** Public wire contracts for the agent SDK. Keep changes compatible with supported Orlo API versions. */
export interface SkillContent {
  description: string;
  instructions: string;
  compatibility: string;
  files: SkillFile[];
}

export interface SkillVersion extends SkillContent {
  id: string;
  skill_id: string;
  name: string;
  version: number;
  content_hash: string;
  created_by: string | null;
  created_at: string;
  published_at: string | null;
  published_by: string | null;
  retired_at: string | null;
  retired_by: string | null;
  retirement_reason: string | null;
}

export interface SkillPackage {
  skill_id: string;
  version_id: string;
  name: string;
  version: number;
  content_hash: string;
  files: SkillFile[];
}

export interface AgentApproval {
  id: string;
  session_id: string;
  step_id: string;
  task_id: string;
  policy_reason: string;
  status: AgentApprovalStatus;
  request_payload: Record<string, unknown> | null;
  timeout_action: AgentTimeoutAction | null;
  timeout_at: string | null;
  /** When nobody decided by the first deadline and the approval went to the org's admins for one more window. */
  escalated_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decision_payload: Record<string, unknown> | null;
  /** When a governed retry used this approval; an approval authorizes at most one execution. */
  consumed_at: string | null;
  consumed_by_step_uuid: string | null;
  created_at: string;
  updated_at: string;
}

export type AgentContainmentAction =
  | 'increase_monitoring'
  | 'restrict_toolset'
  | 'read_only_mode'
  | 'human_takeover_required'
  | 'terminate_recommended';

export interface AgentSession {
  skill_versions?: AgentSkillVersion[];
  id: string;
  task_id: string;
  external_run_id: string | null;
  goal: string | null;
  expected_outcome: Record<string, unknown> | null;
  framework: string | null;
  risk_tier: AgentRiskTier;
  autonomy_level: AgentAutonomyLevel;
  status: AgentSessionStatus;
  containment_state: AgentContainmentAction | null;
  step_count: number;
  tool_call_count: number;
  write_action_count: number;
  external_side_effect_count: number;
  started_at: string;
  completed_at: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
}

export type AgentSessionStatus =
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface GovernAgentStepRequest {
  step_id: string;
  parent_step_id?: string;
  step_type: AgentStepType;
  phase?: AgentStepPhase;
  actor?: AgentStepActor;
  tool_name?: string;
  model_name?: string;
  action_class?: AgentActionClass;
  environment?: string;
  request?: Record<string, unknown>;
  input?: Record<string, unknown>;
  result?: {
    content?: unknown;
    model?: string;
    tokens_used?: { input?: number; output?: number };
    latency_ms?: number;
    [key: string]: unknown;
  };
  output?: {
    content?: unknown;
    model?: string;
    tokens_used?: { input?: number; output?: number };
    latency_ms?: number;
    [key: string]: unknown;
  };
  retrieval?: {
    task_id?: string;
    query?: string;
    token_budget?: number;
  };
  citations?: AgentCitation[];
  state_change?: AgentStateChange;
  timing?: AgentStepTiming;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
}

export interface GovernAgentStepResponse {
  decision: AgentGovernanceDecision;
  reason: string | null;
  trace_id: string;
  risk_tier: AgentRiskTier;
  containment: AgentContainmentAction | null;
  validation: {
    valid: boolean;
    warnings: string[];
    score: number;
    abstain: boolean;
    escalate: boolean;
  } | null;
  policy_decision: AgentPolicyDecisionArtifact;
  citations: AgentCitation[];
  state_change: AgentStateChange | null;
  envelope: GovernedStepEnvelope;
  retrieval: {
    chunks: Array<Record<string, unknown>>;
    attribution: Record<string, unknown>;
  } | null;
}

export type AgentActionClass = 'read' | 'write' | 'delete' | 'network' | 'control';

export type AgentGovernanceDecision =
  | 'allow'
  | 'allow_with_warning'
  | 'reject'
  | 'require_approval'
  | 'contain';

export interface AgentPolicyDecisionArtifact {
  decision: AgentGovernanceDecision;
  reason_code: string | null;
  reason_summary: string | null;
  matched_policies: string[];
  decision_latency_ms: number | null;
  degraded_mode: boolean;
  /** Approval whose decision settled this step; absent on artifacts recorded before approvals were bound. */
  approval_id?: string | null;
  /** For require_approval: the rule's approval timeout, or null when the rule sets none. */
  approval_timeout_seconds?: number | null;
  /** For require_approval: what the rule says happens when the timeout lapses, or null when it sets none. */
  timeout_action?: AgentTimeoutAction | null;
}

export interface AgentStep {
  id: string;
  session_id: string;
  step_id: string;
  parent_step_id: string | null;
  step_type: AgentStepType;
  phase: AgentStepPhase | null;
  actor: AgentStepActor | null;
  tool_name: string | null;
  model_name: string | null;
  request: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
  decision: AgentGovernanceDecision;
  validation_result: Record<string, unknown> | null;
  retrieval_attribution: Record<string, unknown> | null;
  citations: AgentCitation[];
  policy_decision: AgentPolicyDecisionArtifact | null;
  state_change: AgentStateChange | null;
  timing: AgentStepTiming | null;
  idempotency_key: string | null;
  envelope: GovernedStepEnvelope | null;
  cost_estimate: number | null;
  latency_ms: number | null;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  created_at: string;
}

export type AgentStepType =
  | 'model_call'
  | 'model_output'
  | 'tool_request'
  | 'tool_result'
  | 'retrieval'
  | 'decision'
  | 'approval_request'
  | 'approval_result'
  | 'state_transition';

export interface AgentTraceAnnotation {
  id: string;
  trace_sample_id: string;
  annotation_type: string;
  label: string;
  payload: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

export interface AgentTraceSample {
  id: string;
  task_id: string;
  dataset_id: string | null;
  session_id: string;
  step_uuid: string | null;
  source: 'manual' | 'policy' | 'drift' | 'import';
  status: AgentTraceSampleStatus;
  trace_snapshot: Record<string, unknown>;
  expected_output: Record<string, unknown> | null;
  expected_state_change: AgentStateChange | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentSessionRequest {
  skill_versions?: SkillVersionReference[];
  task_id: string;
  external_run_id?: string;
  goal?: string;
  expected_outcome?: Record<string, unknown>;
  framework?: string;
  risk_tier?: AgentRiskTier;
  autonomy_level?: AgentAutonomyLevel;
  metadata?: Record<string, unknown>;
}

export interface CreateTraceSampleRequest {
  source?: AgentTraceSample['source'];
  title?: string;
  notes?: string;
  expected_output?: Record<string, unknown> | null;
  expected_state_change?: AgentStateChange | null;
  metadata?: Record<string, unknown>;
}

export interface TraceSampleAnnotationRequest {
  annotation_type: string;
  label: string;
  payload?: Record<string, unknown>;
  created_by?: string;
}

export interface ToolCheckRequest {
  step_id: string;
  tool_name: string;
  arguments?: Record<string, unknown>;
  action_class?: AgentActionClass;
  environment?: string;
  risk_tier?: AgentRiskTier;
}

export interface ToolCheckResponse {
  decision: AgentGovernanceDecision;
  reason: string | null;
  containment: AgentContainmentAction | null;
  matched_policies: string[];
}

export interface SkillFile { path: string; content: string }

export type AgentApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type AgentTimeoutAction = 'reject' | 'escalate' | 'contain';

export interface AgentSkillVersion extends SkillVersionReference { name: string; version: number }

export type AgentRiskTier = 'low' | 'medium' | 'high' | 'critical';

export type AgentAutonomyLevel = 'manual' | 'assisted' | 'semi_autonomous' | 'autonomous';

export type AgentStepPhase = 'pre' | 'post';

export type AgentStepActor = 'runtime' | 'model' | 'tool' | 'human' | 'orlo_policy';

export interface AgentCitation {
  source_type: AgentCitationSourceType;
  source_id: string;
  label?: string | null;
  preview?: string | null;
  score?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface AgentStateChange {
  kind: AgentStateChangeKind;
  resource_type: string | null;
  resource_id: string | null;
  operation: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  evidence: Record<string, unknown> | null;
}

export interface AgentStepTiming {
  started_at?: string | null;
  completed_at?: string | null;
  latency_ms?: number | null;
}

export interface GovernedStepEnvelope {
  version: 'governed_step_envelope_v1';
  session_id: string;
  step_id: string;
  parent_step_id: string | null;
  step_type: AgentStepType;
  phase: AgentStepPhase;
  actor: AgentStepActor;
  request: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  citations: AgentCitation[];
  policy_decision: AgentPolicyDecisionArtifact;
  /** Approval whose decision settled this step; absent on envelopes recorded before approvals were bound. */
  approval_id?: string | null;
  risk_tier: AgentRiskTier;
  state_change: AgentStateChange | null;
  timing: AgentStepTiming | null;
  idempotency_key: string | null;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
}

export type AgentTraceSampleStatus = 'candidate' | 'approved' | 'rejected' | 'promoted';

export interface SkillVersionReference { skill_id: string; version_id: string; content_hash: string }

export type AgentCitationSourceType =
  | 'document_chunk'
  | 'tool_result'
  | 'memory_reference'
  | 'external_service';

export type AgentStateChangeKind = 'none' | 'proposed' | 'observed' | 'confirmed';
