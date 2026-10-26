import { runPreRequestHooks } from '@humanlayer/agentlayer-core'
import type { ModelMessage } from 'ai'
import { describe, expect, test } from 'vitest'

import { stabilizePersistedToolHistory } from '../../../../src/agents/codelayer/prompt-state'

describe('persisted model-visible JSON', () => {
	test('stabilizes nested tool arguments while preserving array order and the original state', async () => {
		const input = {
			file_path: 'public.txt',
			limit: 2000,
			nested: [
				{ longer: 1, x: 2 },
				{ b: 3, a: 4 },
			],
		}
		const messages: ModelMessage[] = [
			{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read-1', toolName: 'read', input }] },
		]
		const result = await runPreRequestHooks([stabilizePersistedToolHistory], { messages })
		const content = result.messages[0]?.content
		expect(Array.isArray(content) && content[0]?.type === 'tool-call' && JSON.stringify(content[0].input)).toBe(
			'{"limit":2000,"nested":[{"x":2,"longer":1},{"a":4,"b":3}],"file_path":"public.txt"}',
		)
		expect(JSON.stringify(input)).toBe(
			'{"file_path":"public.txt","limit":2000,"nested":[{"longer":1,"x":2},{"b":3,"a":4}]}',
		)
		const repeated = await runPreRequestHooks([stabilizePersistedToolHistory], { messages: result.messages })
		expect(repeated.transformed).toBe(false)
	})

	test('matches PostgreSQL UTF-8 order for Unicode and numeric keys without losing special keys', async () => {
		const input = JSON.parse('{"long":1,"é":2,"aa":3,"中":4,"2":5,"10":6,"a":9,"__proto__":{"z":7,"a":8}}')
		const messages: ModelMessage[] = [
			{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'fixture', input }] },
		]
		const result = await runPreRequestHooks([stabilizePersistedToolHistory], { messages })
		const content = result.messages[0]?.content
		expect(Array.isArray(content) && content[0]?.type === 'tool-call' && JSON.stringify(content[0].input)).toBe(
			'{"2":5,"10":6,"a":9,"aa":3,"é":2,"中":4,"long":1,"__proto__":{"a":8,"z":7}}',
		)
		const repeated = await runPreRequestHooks([stabilizePersistedToolHistory], { messages: result.messages })
		expect(repeated.transformed).toBe(false)
	})

	test('stabilizes structured tool results and leaves text, reasoning and binary values intact', async () => {
		const bytes = new Uint8Array([3, 2, 1])
		const messages: ModelMessage[] = [
			{ role: 'user', content: [{ type: 'image', image: bytes }] },
			{
				role: 'assistant',
				content: [
					{
						type: 'reasoning',
						text: 'unchanged',
						providerOptions: { openai: { itemId: 'rs-1', reasoningEncryptedContent: 'opaque' } },
					},
				],
			},
			{
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: 'call-1',
						toolName: 'fixture',
						output: { type: 'json', value: { longer: 'value', a: [2, 1] } },
					},
				],
			},
			{
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: 'call-2',
						toolName: 'fixture',
						output: { type: 'text', value: '{"longer":1,"a":2}' },
					},
				],
			},
		]
		const result = await runPreRequestHooks([stabilizePersistedToolHistory], { messages })
		expect(result.messages[0]).toBe(messages[0])
		expect(result.messages[1]).toBe(messages[1])
		expect(result.messages[3]).toBe(messages[3])
		const content = result.messages[2]?.content
		expect(Array.isArray(content) && content[0]?.type === 'tool-result' && JSON.stringify(content[0].output)).toBe(
			'{"type":"json","value":{"a":[2,1],"longer":"value"}}',
		)
	})

	test('does not parse JSON strings or rewrite an already stable text-only history', async () => {
		const messages: ModelMessage[] = [
			{ role: 'user', content: 'unchanged' },
			{
				role: 'assistant',
				content: [
					{ type: 'tool-call', toolCallId: 'call-1', toolName: 'fixture', input: '{"longer":1,"a":2}' },
				],
			},
		]
		const result = await runPreRequestHooks([stabilizePersistedToolHistory], { messages })
		expect(result.transformed).toBe(false)
		expect(result.messages).toBe(messages)
	})
})
