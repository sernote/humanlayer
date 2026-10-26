import type { PreRequestHook } from '@humanlayer/agentlayer-core'

/** Match JSONB's UTF-8 key ordering before the first request that contains a value. */
function orderJsonForPersistence(value: unknown): unknown {
	if (Array.isArray(value)) {
		const ordered = value.map(orderJsonForPersistence)
		return ordered.every((item, index) => item === value[index]) ? value : ordered
	}
	if (value === null || typeof value !== 'object') return value
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) return value
	const entries = Object.entries(value)
	const ordered = entries
		.map(([key, child]) => ({ key, bytes: Buffer.from(key), value: orderJsonForPersistence(child) }))
		.sort((a, b) => a.bytes.length - b.bytes.length || Buffer.compare(a.bytes, b.bytes))
	const result = Object.fromEntries(ordered.map(({ key, value: child }) => [key, child]))
	// JavaScript enumerates integer keys first, even when JSONB places a short string before them.
	if (
		Object.entries(result).every(
			([key, child], index) => key === entries[index]?.[0] && child === entries[index]?.[1],
		)
	) {
		return value
	}
	return result
}

/** JSONB preserves values but not object order; serialized tool history must stay stable on resume. */
export const stabilizePersistedToolHistory: PreRequestHook = (ctx) => {
	let changed = false
	const messages = ctx.messages.map((message) => {
		if (!Array.isArray(message.content)) return message
		let messageChanged = false
		const content = message.content.map((part) => {
			if (part.type === 'tool-call') {
				const input = orderJsonForPersistence(part.input)
				if (input !== part.input) {
					messageChanged = true
					return { ...part, input }
				}
			} else if (part.type === 'tool-result') {
				const output = orderJsonForPersistence(part.output) as typeof part.output
				if (output !== part.output) {
					messageChanged = true
					return { ...part, output }
				}
			}
			return part
		})
		if (!messageChanged) return message
		changed = true
		return { ...message, content } as typeof message
	})
	return changed ? ctx.transform(messages, { persist: true }) : ctx.next()
}
