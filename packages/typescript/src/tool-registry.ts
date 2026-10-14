/** Registers tool implementations once; dispatch can only invoke the registered, governed path. */
import { createGenericRuntimeAdapter, type GenericRuntimeAdapterOptions } from './generic-runtime.js';
import type { AgentActionClass } from './protocol.js';

export interface RegisteredTool<TArgs = any, TResult = any> {
  actionClass: AgentActionClass;
  environment?: string;
  execute: (args: TArgs) => Promise<TResult>;
}
export interface RegisteredToolCall {
  /** Reuse this ID and the same arguments when resuming an approved call. */
  stepId: string;
  parentStepId?: string;
  metadata?: Record<string, unknown>;
}
export interface ToolRegistration {
  name: string;
  actionClass: AgentActionClass;
  whenUnavailable: 'stop' | 'continue';
}
const actionClasses = new Set(['read', 'write', 'delete', 'network', 'control']);

/** The returned inventory describes this registry only; it cannot discover other execution paths. */
export function createToolRegistry<T extends Record<string, RegisteredTool>>(
  options: GenericRuntimeAdapterOptions & { tools: T },
) {
  const runtime = createGenericRuntimeAdapter(options);
  const tools = new Map<string, RegisteredTool>();
  for (const [name, definition] of Object.entries(options.tools)) {
    if (!name.trim() || !definition || !actionClasses.has(definition.actionClass) || typeof definition.execute !== 'function') {
      throw new Error(`Tool ${JSON.stringify(name)} needs an implementation and an explicit action class.`);
    }
    tools.set(name, Object.freeze({ ...definition }));
  }
  return Object.freeze({
    describe(): ToolRegistration[] {
      return [...tools].map(([name, tool]) => ({ name, actionClass: tool.actionClass,
        whenUnavailable: options.run.failModeFor(tool.actionClass) === 'open' ? 'continue' : 'stop' }));
    },
    async invoke<K extends Extract<keyof T, string>>(
      name: K, args: Parameters<T[K]['execute']>[0], call: RegisteredToolCall,
    ): Promise<Awaited<ReturnType<T[K]['execute']>>> {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${JSON.stringify(name)} is not registered.`);
      if (!call?.stepId?.trim()) throw new Error('A stable stepId is required for a registered tool call.');
      const result = await runtime.runToolStep({
        stepId: call.stepId, toolName: name, actionClass: tool.actionClass, environment: tool.environment,
        parentStepId: call.parentStepId, arguments: args, execute: tool.execute,
        metadata: { ...call.metadata, orlo_tool_registration: 'registry' },
      });
      return result.output;
    },
  });
}
