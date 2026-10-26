import { type AgentState, sanitizeStateForPersistence } from '@humanlayer/agentlayer-core'
import { createCodexSseVendorProvider, createCodexEffectProvider } from '@humanlayer/agentlayer-provider-openai-codex'
import { describe, expect, test } from 'vitest'

import {
	codexReasoningReplayContext,
	encodeAgentState,
	isNativeCodexModel,
	parsePersistedAgentState,
} from '../../../../src/agents/codelayer/persisted-agent-state'

const native = createCodexSseVendorProvider().languageModel('gpt-6.1-sol')
const auth = { kind: 'oauth' as const, accessToken: 'synthetic', accountId: 'account-one' }
const replay = codexReasoningReplayContext(native, auth)!
const reasoning = {
	type: 'reasoning' as const,
	text: 'summary',
	providerOptions: {
		openai: { itemId: 'rs_self_contained', reasoningEncryptedContent: 'synthetic-ciphertext', phase: 'analysis' },
	},
}
const state: AgentState = {
	messages: [
		{
			role: 'assistant',
			content: [
				reasoning,
				{
					type: 'text',
					text: 'done',
					providerOptions: { openai: { itemId: 'msg_remote', phase: 'final_answer' } },
				},
			],
		},
	],
}

describe('self-contained native Codex reasoning persistence', () => {
	test('recognizes the real native transports and rejects custom routes or unidentifiable auth', () => {
		expect(isNativeCodexModel(native)).toBe(true)
		expect(isNativeCodexModel(createCodexEffectProvider().languageModel('gpt-6.1-sol'))).toBe(true)
		expect(codexReasoningReplayContext({ ...native, provider: 'custom.responses' }, auth)).toBeUndefined()
		expect(codexReasoningReplayContext(native, { kind: 'api', apiKey: 'test-key' })).toBeUndefined()
		expect(codexReasoningReplayContext(native, { kind: 'oauth', accessToken: 'test' })).toBeUndefined()
		expect(replay.accountHash).not.toContain(auth.accountId)
	})

	test('keeps root self-contained IDs, strips remote IDs and phase, and does not mutate the original', () => {
		const saved = encodeAgentState(state, replay)
		expect(saved.messages).toEqual([
			{
				role: 'assistant',
				content: [
					{
						...reasoning,
						providerOptions: {
							openai: { itemId: 'rs_self_contained', reasoningEncryptedContent: 'synthetic-ciphertext' },
						},
					},
					{ type: 'text', text: 'done' },
				],
			},
		])
		expect(reasoning.providerOptions.openai.phase).toBe('analysis')
		expect(saved.codexReasoningReplay).toEqual(replay)
		expect(parsePersistedAgentState(JSON.parse(JSON.stringify(saved)), replay)).toEqual({
			messages: saved.messages,
		})
	})

	test.each([undefined, { ...replay, modelId: 'other-model' }, { ...replay, accountHash: 'other-account' }])(
		'strips replay identifiers for a missing or changed context',
		(current) => {
			const saved = encodeAgentState(state, replay)
			expect(parsePersistedAgentState(saved, current)).toEqual(sanitizeStateForPersistence(state))
		},
	)

	test('legacy untagged snapshots and malformed tags retain the original safe behavior', () => {
		expect(parsePersistedAgentState(state, replay)).toEqual(sanitizeStateForPersistence(state))
		expect(parsePersistedAgentState({ ...state, codexReasoningReplay: { ...replay, version: 2 } }, replay)).toEqual(
			sanitizeStateForPersistence(state),
		)
		expect(parsePersistedAgentState({ messages: 'invalid' }, replay)).toBeNull()
		expect(encodeAgentState(state)).toEqual(sanitizeStateForPersistence(state))
	})

	test('never restores IDs without encrypted content or inside a different-model child', () => {
		const unsafe: AgentState = {
			messages: [
				{
					role: 'assistant',
					content: [
						{ ...reasoning, providerOptions: { openai: { itemId: 'rs_missing' } } },
						{
							...reasoning,
							providerOptions: { openai: { itemId: 'rs_empty', reasoningEncryptedContent: '' } },
						},
						{
							...reasoning,
							providerOptions: { openai: { itemId: 'rs_null', reasoningEncryptedContent: null } },
						},
					],
				},
			],
			subAgents: { child: state },
			terminalChildren: {
				child: { state, lastOutcome: 'complete', completedTurns: 1, runtime: { type: 'fork' } },
			},
		}
		const saved = encodeAgentState(unsafe, replay)
		const { codexReasoningReplay: tag, ...withoutTag } = saved
		expect(tag).toEqual(replay)
		expect(withoutTag).toEqual(sanitizeStateForPersistence(unsafe))
	})

	test.each([
		'Invalid encrypted_content: decryption failed',
		"Item with id 'rs_replayed' not found",
		'LLM stream failed',
		'',
	])('an errored run removes the tag and IDs regardless of provider wording: %s', (message) => {
		expect(encodeAgentState(state, replay, message)).toEqual(sanitizeStateForPersistence(state))
	})
})
