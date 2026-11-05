/**
 * Generic runtime adapter for wrapping ordinary async model and tool functions from any JavaScript
 * agent runtime. Built on OrloAgentRun from index.ts: runModelStep and runToolStep send the step to
 * Orlo before and after the caller's execute function runs, and throw OrloGovernanceBlockedError
 * when Orlo rejects, contains, or requires approval. index.ts re-exports this module as part of
 * @orlo/agent-sdk.
 */
import crypto from 'node:crypto';
import {parseAccessLimits,parseResourceRequest,combineAccessLimits} from './resource-permissions.js';
import type {
  AgentApproval,
  AgentContainmentAction,
  AgentSession,
  AgentSessionStatus,
  GovernAgentStepRequest,
  GovernAgentStepResponse,
} from './protocol.js';
import { OrloAgentRun, type BeforeToolCallResult } from './index.js';
import { OrloUnavailableError } from './transport.js';

export class OrloGovernanceBlockedError extends Error {
  readonly decision: GovernAgentStepResponse['decision'];
  readonly reason: string | null;
  readonly containment: AgentContainmentAction | null;
  readonly traceId: string;
  readonly approval: AgentApproval | null;
  /** The blocked step. After an approval is decided, retry with this step id and the same arguments. */
  readonly stepId: string | null;
  readonly response: GovernAgentStepResponse;

  constructor(
    message: string,
    response: GovernAgentStepResponse,
    approval: AgentApproval | null = null,
    stepId: string | null = null,
  ) {
    super(message);
    this.name = 'OrloGovernanceBlockedError';
    this.decision = response.decision;
    this.reason = response.reason;
    this.containment = response.containment;
    this.traceId = response.trace_id;
    this.approval = approval;
    this.stepId = stepId ?? response.envelope?.step_id ?? null;
    this.response = response;
  }
}

export interface GenericRuntimeAdapterOptions {
  /** Opt in to background execution reports. Business outcomes must be reported explicitly. */
  reportExecution?: boolean;
  run: OrloAgentRun;
  autoRequestApproval?: boolean;
}

export interface GovernedModelStepInput<TOutput = Record<string, unknown>> {
  stepId: string;
  modelName: string;
  input: Record<string, unknown>;
  execute: () => Promise<TOutput>;
  parentStepId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Handed to a resource handler with its contract. Call `applied()` once the handler has enforced every
 * limit, or `applied([...types])` for the ones it enforced. Without it the SDK reports the outcome as unknown,
 * because only the handler knows whether the limits took effect.
 */
export interface LimitAttestation {applied(limitTypes?: string[]): void}

export interface GovernedToolStepInput<TArgs = Record<string, unknown>, TResult = Record<string, unknown>> {
  resource?: import('./resource-permissions.js').ResourceRequest;
  supportedLimitTypes?: string[];
  /**
   * Reuse the blocked step's id, with the same arguments, to retry after a reviewer decides its
   * approval: Orlo allows the call once, rejects it if the approval was rejected, and asks for a
   * new approval if the arguments changed.
   */
  stepId: string;
  toolName: string;
  arguments: TArgs;
  execute: (args: TArgs, contract?: Readonly<import('./resource-permissions.js').ResourceContract>, limits?: LimitAttestation) => Promise<TResult>;
  actionClass?: GovernAgentStepRequest['action_class'];
  environment?: string;
  parentStepId?: string;
  modelName?: string;
  metadata?: Record<string, unknown>;
}

/** `pre` and `post` are null when that step was sent in the background (see OrloAgentRun.blockingStepTypes). */
export interface GovernedModelStepResult<TOutput = Record<string, unknown>> {
  output: TOutput;
  pre: GovernAgentStepResponse | null;
  post: GovernAgentStepResponse | null;
}

/** `post` is null when the tool result was sent in the background. */
export interface GovernedToolStepResult<TResult = Record<string, unknown>> {
  output: TResult;
  pre: BeforeToolCallResult;
  post: GovernAgentStepResponse | null;
}

function isBlockingDecision(decision: GovernAgentStepResponse['decision']): boolean {
  return decision === 'reject' || decision === 'require_approval' || decision === 'contain';
}

function asGovernedOutput(value: unknown, modelName: string): GovernAgentStepRequest['output'] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    return {
      ...objectValue,
      model: typeof objectValue.model === 'string' ? objectValue.model : modelName,
      content: objectValue.content ?? value,
    };
  }

  return {
    model: modelName,
    content: value,
  };
}

function throwIfBlocked(
  response: GovernAgentStepResponse,
  stepId: string,
  approval: AgentApproval | null = null,
): void {
  if (!isBlockingDecision(response.decision)) return;

  const message =
    response.reason
    || (response.decision === 'require_approval'
      ? 'Orlo requires approval before this step can continue'
      : 'Orlo blocked this step');

  throw new OrloGovernanceBlockedError(message, response, approval, stepId);
}

export interface GenericRuntimeAdapter {
  runModelStep<TOutput = Record<string, unknown>>(input: GovernedModelStepInput<TOutput>): Promise<GovernedModelStepResult<TOutput>>;
  runToolStep<TArgs = Record<string, unknown>, TResult = Record<string, unknown>>(input: GovernedToolStepInput<TArgs, TResult>): Promise<GovernedToolStepResult<TResult>>;
  recordDecision(input: Omit<GovernAgentStepRequest, 'step_type'>): Promise<GovernAgentStepResponse>;
  recordRetrieval(input: Omit<GovernAgentStepRequest, 'step_type'>): Promise<GovernAgentStepResponse>;
  close(status?: Extract<AgentSessionStatus, 'completed' | 'failed' | 'cancelled' | 'timed_out'>): Promise<AgentSession>;
}

export function createGenericRuntimeAdapter(options: GenericRuntimeAdapterOptions): GenericRuntimeAdapter {
  return {
    async runModelStep<TOutput = Record<string, unknown>>(input: GovernedModelStepInput<TOutput>): Promise<GovernedModelStepResult<TOutput>> {
      const preRequest = {
        step_id: input.stepId,
        parent_step_id: input.parentStepId,
        model_name: input.modelName,
        input: input.input,
        metadata: input.metadata,
      };
      let pre: GovernAgentStepResponse | null = null;
      if (options.run.isBlocking('model_call')) {
        pre = await options.run.governModelCall(preRequest);
        throwIfBlocked(pre, input.stepId);
      } else {
        options.run.report('model_call', preRequest);
      }

      const output = await input.execute();
      const postRequest = {
        step_id: input.stepId,
        parent_step_id: input.parentStepId,
        model_name: input.modelName,
        input: input.input,
        output: asGovernedOutput(output, input.modelName),
        metadata: input.metadata,
      };
      let post: GovernAgentStepResponse | null = null;
      if (options.run.isBlocking('model_output')) {
        post = await options.run.governModelOutput(postRequest);
        throwIfBlocked(post, input.stepId);
      } else {
        options.run.report('model_output', postRequest);
      }

      return { output, pre, post };
    },

    async runToolStep<TArgs = Record<string, unknown>, TResult = Record<string, unknown>>(
      input: GovernedToolStepInput<TArgs, TResult>,
    ): Promise<GovernedToolStepResult<TResult>> {
      const pre = await options.run.beforeToolCall({
        step_id: input.stepId,
        tool_name: input.toolName,
        arguments: (input.arguments || {}) as Record<string, unknown>,
        action_class: input.actionClass,
        environment: input.environment,
        resource:input.resource,
        parent_step_id: input.parentStepId,
        model_name: input.modelName,
        metadata: input.metadata,
        autoRequestApproval: options.autoRequestApproval,
      });
      const actionId = pre.governance.action_id;
      if (options.reportExecution && !pre.failedOpen && !actionId) throw new Error('Execution reporting needs action_id support. Upgrade the Orlo server before enabling reportExecution.');
      const attested=new Set<string>();
      const report = (outcome: 'succeeded' | 'failed' | 'not_executed', durationMs?: number,limitStatus?:'unsupported') => {
        const resource=pre.governance.resource_contract;
        const types=resource?Object.keys(resource.access_limits):[];
        // Success alone is not proof the limits took effect; only the handler's attestation is.
        const all=types.length>0&&types.every(t=>attested.has(t));
        const status=limitStatus??(outcome==='failed'?'failed':outcome==='succeeded'&&all?'applied':'unknown');
        const partial=outcome==='succeeded'&&!all&&attested.size?{applied_limit_types:types.filter(t=>attested.has(t))}:{};
        if ((options.reportExecution||input.resource) && actionId) options.run.reportAction(actionId, { report_id: crypto.randomUUID(), kind: 'execution', outcome, ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
          ...(resource?{resource_access:{authorization_hash:resource.authorization_hash,status,limit_types:types,...partial}}:{}) });
      };
      if (isBlockingDecision(pre.governance.decision)) report('not_executed');
      throwIfBlocked(pre.governance, input.stepId, pre.approval);

      const contract=pre.governance.resource_contract;
      if(input.resource||contract){
        if(!input.resource||!contract||contract.version!==1||!contract.authorization_hash||contract.resource.resource_type!==input.resource.resource_type||contract.resource.operation!==input.resource.operation||contract.resource.resource_id!==input.resource.resource_id)
          throw new Error('RESOURCE_CONTRACT_UNAVAILABLE: this tool requires a matching resource permission contract.');
        try {
          parseResourceRequest(contract.resource);
          combineAccessLimits([parseAccessLimits(contract.access_limits)]);
          if(!/^[a-f0-9]{64}$/.test(contract.authorization_hash)||!Array.isArray(contract.policy_versions)||!contract.policy_versions.length
            ||contract.policy_versions.some(p=>typeof p.id!=='string'||!Number.isSafeInteger(p.version)||p.version<1))throw new Error();
        } catch {throw new Error('RESOURCE_CONTRACT_UNAVAILABLE: this tool requires a valid resource permission contract.');}
        const limits=Object.entries(contract.access_limits).filter(([,v])=>!Array.isArray(v)||v.length>0).map(([key])=>key);
        if(limits.some(key=>!input.supportedLimitTypes?.includes(key))){report('not_executed',undefined,'unsupported');throw new Error('RESOURCE_LIMIT_UNSUPPORTED: the handler cannot apply every access limit.');}
        const freeze=(value:any):any=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
        freeze(contract);
      }

      const started = performance.now();
      let output: TResult;
      const limits:LimitAttestation={applied:(types)=>{const known=contract?Object.keys(contract.access_limits):[];for(const t of types??known)if(known.includes(t))attested.add(t);}};
      try { output = await input.execute(input.arguments,contract,limits); }
      catch (error) { report('failed', performance.now() - started); throw error; }
      report('succeeded', performance.now() - started);
      const postRequest = {
        resource:input.resource,
        step_id: input.stepId,
        parent_step_id: input.parentStepId,
        tool_name: input.toolName,
        model_name: input.modelName,
        action_class: input.actionClass,
        environment: input.environment,
        input: (input.resource?{resource_access:true}:input.arguments || {}) as Record<string, unknown>,
        output: asGovernedOutput(input.resource?{resource_result:true}:output, input.modelName || input.toolName),
        metadata: input.metadata,
      };
      let post: GovernAgentStepResponse | null = null;
      // After a fail-open call Orlo was unreachable moments ago, so report the result instead of waiting on it.
      if (options.run.isBlocking('tool_result') && !pre.failedOpen) {
        try {
          post = await options.run.governToolResult(postRequest);
        } catch (err) {
          if (!(err instanceof OrloUnavailableError) || options.run.failModeFor(input.actionClass) !== 'open') {
            throw err;
          }
          options.run.report('tool_result', postRequest);
        }
        if (post) throwIfBlocked(post, input.stepId);
      } else {
        options.run.report('tool_result', postRequest);
      }

      return { output, pre, post };
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
