import { createHash } from 'node:crypto'

import { type AgentState, sanitizeStateForPersistence } from '@humanlayer/agentlayer-core'
import type { AuthInfo } from '@humanlayer/agentlayer-provider-auth'
import { type LanguageModel, modelMessageSchema } from 'ai'
import z from 'zod/v4'

const persistedAgentStateSchema = z.object({ messages: modelMessageSchema.array() }).loose()
const replaySchema = z.object({ version: z.literal(1), modelId: z.string(), accountHash: z.string() })
export type CodexReasoningReplay = z.infer<typeof replaySchema>

export function isNativeCodexModel(model: LanguageModel): boolean {
	return typeof model !== 'string' && (model.provider === 'codex-sse-vendor' || model.provider === 'codex-effect')
}

export function codexReasoningReplayContext(
	model: LanguageModel,
	auth: AuthInfo | undefined,
): CodexReasoningReplay | undefined {
	if (typeof model === 'string' || !isNativeCodexModel(model) || auth?.kind !== 'oauth' || !auth.accountId) {
		return undefined
	}
	return {
		version: 1,
		modelId: model.modelId,
		accountHash: createHash('sha256').update(auth.accountId).digest('hex'),
	}
}

export function parsePersistedAgentState(value: unknown, replay?: CodexReasoningReplay): AgentState | null {
	const parsed = persistedAgentStateSchema.safeParse(value)
	if (!parsed.success) return null
	const { codexReasoningReplay, ...state } = parsed.data
	const stored = replaySchema.safeParse(codexReasoningReplay)
	if (
		replay &&
		stored.success &&
		stored.data.modelId === replay.modelId &&
		stored.data.accountHash === replay.accountHash
	) {
		return state
	}
	// Old snapshots and a changed route, model or account retain the SDK's safe resume behavior.
	return sanitizeStateForPersistence(state)
}

export function encodeAgentState(
	state: AgentState,
	replay?: CodexReasoningReplay,
	errorMessage?: string,
): { [Key in keyof AgentState]: AgentState[Key] } & { codexReasoningReplay?: CodexReasoningReplay } {
	const sanitized = sanitizeStateForPersistence(state)
	// Error wording varies by backend. An errored run must not retain potentially rejected replay IDs.
	const preserveReasoning = replay && errorMessage === undefined
	if (preserveReasoning) {
		sanitized.messages = sanitized.messages.map((message, messageIndex) => {
			const original = state.messages[messageIndex]?.content
			if (!Array.isArray(message.content) || !Array.isArray(original)) return message
			const content = message.content.map((part, partIndex) => {
				const previous = original[partIndex]
				if (part.type !== 'reasoning' || previous?.type !== 'reasoning') return part
				const options = previous.providerOptions?.openai
				if (
					typeof options?.itemId !== 'string' ||
					!options.itemId ||
					typeof options.reasoningEncryptedContent !== 'string' ||
					!options.reasoningEncryptedContent
				)
					return part
				return {
					...part,
					providerOptions: {
						...part.providerOptions,
						openai: { ...part.providerOptions?.openai, itemId: options.itemId },
					},
				}
			})
			return { ...message, content } as typeof message
		})
	}
	// Child agents may use other models. Keep their IDs sanitized until they have their own provenance.
	const encoded: { [Key in keyof AgentState]: AgentState[Key] } & { codexReasoningReplay?: CodexReasoningReplay } = {
		messages: sanitized.messages,
	}
	if (sanitized.pendingToolCalls !== undefined) encoded.pendingToolCalls = sanitized.pendingToolCalls
	if (sanitized.approvalHistory !== undefined) encoded.approvalHistory = sanitized.approvalHistory
	if (sanitized.toolState !== undefined) encoded.toolState = sanitized.toolState
	if (sanitized.subAgents !== undefined) encoded.subAgents = sanitized.subAgents
	if (sanitized.terminalChildren !== undefined) encoded.terminalChildren = sanitized.terminalChildren
	if (sanitized.compaction !== undefined) encoded.compaction = sanitized.compaction
	if (sanitized.contextWindowTokens !== undefined) encoded.contextWindowTokens = sanitized.contextWindowTokens
	if (preserveReasoning) encoded.codexReasoningReplay = replay
	return encoded
}
