---
task: codelayer-persisted-prompt-cache
type: design-discussion
repo: humanlayer/humanlayer
branch: codex/codelayer-state-cache
sha: cbaf99b79446a914a0136c8eb93617b63dd424d6
---

### Summary of change request

Preserve the model-visible history prefix when a CodeLayer conversation is saved and continued. Two persistence changes currently reduce cache reuse: JSONB reorders tool argument keys, and generic sanitization drops the ID required by the native Codex adapter to replay self-contained encrypted reasoning.

Process note: this document follows the upstream `rpi:create-design-discussion` skill and template, applied in Codex. Two attempts to generate it through the RPI plugin in Claude Code failed before producing a document, so it is not presented as successful Claude command output. Claude-b Opus 5.5 high participated in the preceding research and code/design reviews. The contributor explicitly selected the decisions below on 26 October 2026.

### Current State

Sending another message can change context that the model already processed, even when the conversation uses the same model and account. Later file contents then lose prefix reuse. This happens across ordinary turns, without a permission-mode switch.

A controlled native Codex conversation reads three fixed public files over three user turns. Both variants make six provider requests, start cold, perform the same reads and return READY three times. Input/cached/uncached tokens are 93,828 / 51,840 / 41,988 before and 94,441 / 67,200 / 27,241 with both changes. Output is 240 versus 242 tokens. The measured reduction is 35.1% of uncached input for this workload, not a product-wide estimate.

The harness exercises the native SDK and real PostgreSQL serialization; it does not launch the full daemon/API/UI stack. Separate provider controls isolate JSON ordering and reasoning replay, including reversed request order. CI regressions use no real credentials.

### Desired End State

Continuing on the same supported model/account preserves replayable history that was already sent. Structured tool arguments and outputs retain their serialization order across persistence. Unsupported routes, legacy state, context switches and errors retain conservative sanitization behavior.

### What we're not doing

- Changing database schema, cache keys, provider routing, billing statistics or permissions.
- Replaying arbitrary remote response IDs or extending reasoning replay to children without per-child model provenance.
- Fixing the separate permission-toggle case in these PRs.
- Claiming a production session frequency, universal 35.1% saving, lower total token count, billing reduction or latency improvement.

### Proposed End State Architecture

```text
Before
  tool history → provider request → generic sanitization → JSONB
  → changed earlier history on resume → next provider request

After
  tool history → stable tool JSON → provider request
  → guarded state encoding → JSONB
  → verify model/account provenance → same replayable prefix → next request
```

The existing pre-request hook normalizes only model-visible tool-call inputs and structured tool results. It persists the transformed messages so the initial request and resumed request agree. The existing save path uses an encoder that first runs SDK sanitization, then restores only eligible root reasoning IDs. A versioned model/account tag stays in persisted state and is removed before `agent.run`. Resume and fork validate it identically.

### Design Questions

None remaining for this proposal. The scope and tradeoffs below were presented to and explicitly selected by the contributor; implementation details were checked against the existing SDK and executor.

### Resolved Design Questions

#### Where should JSON order become stable?

**Decision:** Normalize before the first model request containing the value, using UTF-8 key byte length and then byte order, matching JSONB after JavaScript enumeration. Keep arrays, values and string content intact. Use the existing `preRequest` hook with `persist: true`.

**Rationale:** The contributor chose the minimal fix because it makes fewer changes and already has a measured effect. It keeps the existing storage contract and avoids changing already-cached history only after reload.

**Rejected:** JSON/text storage would require a broader migration; alphabetic-only sorting is undone by JSONB; sorting only on reload still changes the previously sent prefix.

#### Which reasoning should survive sanitization?

**Decision:** Restore only a root reasoning `openai.itemId` accompanied by nonempty encrypted content, on native Codex routes. Other IDs and `phase` remain sanitized. Require the same model ID and a hash of the OAuth account ID; remove this metadata before running the agent.

**Rationale:** The approved scope preserves the measured self-contained replay path while limiting compatibility changes. Account identity remains stable through normal token refresh. No raw account ID or credential is added to persisted state.

**Rejected:** Keeping all remote IDs could retain non-self-contained references; encrypted content without its ID is omitted by the current native adapter; using an access-token hash would break on token refresh; omitting model/account provenance would allow incompatible replay. Broader child-agent support was explicitly deferred because the child's model can differ and no per-child provenance is available in this patch.

#### How should errors recover?

**Decision:** Any errored result is saved without replay IDs/tag, accepting a potentially colder next continuation. The successful path retains replay. Do not add automatic inference retries.

**Rationale:** The contributor accepted this performance/recovery tradeoff as part of the minimal fix. Error recovery should not depend on exact backend wording.

**Rejected:** Matching only decryption-related messages misses generic, unknown-item and empty-message errors; keeping the same IDs after an error can repeat a failing replay. Three regression cases exercise the broader fallback. The inspected SDK returns model-loop errors in `RunResult`; no observed rejected-result path required a new exception-time database write.

#### How should the changes be submitted and measured?

**Decision:** Two focused PRs under one proposal: JSON ordering and native Codex reasoning replay. Keep 35.1% attached to the combined workload. Each individual PR uses its own isolated control and deterministic regressions.

**Rationale:** Each cause is independently reviewable and has different compatibility boundaries. The contributor approved this split and selected the minimal scope because it is already measured.

**Rejected:** A larger storage/child-agent redesign adds unmeasured scope; putting the rare permission-toggle case in these PRs mixes separate behavior. Giving either individual fix the combined saving would misstate the measurement.

### Patterns to follow

The executor already owns agent hooks, loading, forking and saving: `apps/riptide-daemon/src/agents/codelayer/execute-codelayer.ts`.

```ts
hooks: {
  preRequest: [stabilizePersistedToolHistory],
  approval: [createCodelayerApprovalHook(services, session, cwd)],
  postToolUse: postToolUseHooks,
}
```

The new hook returns `ctx.next()` when unchanged, otherwise `ctx.transform(messages, { persist: true })`. It does not mutate the caller's original objects and is idempotent, including numeric, Unicode and special keys.

The API already persists state through JSONB in `apps/riptide-api/src/orpc/daemon/codelayer-state/upsert.effect.ts`; no migration is needed. Keep the existing SDK sanitizer as the default and apply the narrow replay exception afterward.

```ts
const savedState = parsePersistedAgentState(persistedValue, replayContext)
await services.orpc.codelayerState.upsert({
  sessionId: session.id,
  state: encodeAgentState(result.state, replayContext, result.error?.message),
})
```

Follow the existing Vitest executor tests under `apps/riptide-daemon/test/unit/agents/codelayer/`. Tests cover hook wiring; nested keys and idempotence; resume/fork provenance; old snapshots; changed models/accounts; unsupported routes; child sanitization; and generic/unknown-item/empty-message errors. The split branches pass 91 and 102 CodeLayer tests respectively. Both pass repository-wide typecheck and quality after a clean frozen-lockfile install. The previous combined patch passed 107 CodeLayer tests. Repository-wide unit/service validation is reported separately in the proposal; these counts are not a claim that all CI is green.
