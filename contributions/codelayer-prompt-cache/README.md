# CodeLayer persistence and prompt-cache reuse

Measured on `humanlayer/humanlayer` commit `cbaf99b79446a914a0136c8eb93617b63dd424d6`, 26 October 2026. CodeLayer/AgentLayer 0.0.89, native Codex SSE, `gpt-6.1-sol`, PostgreSQL 17.

Two independent changes to persisted history reduce prefix reuse on an ordinary continuation: JSONB reorders tool argument keys, and generic sanitization removes IDs needed by the native adapter to replay self-contained encrypted reasoning. The proposed fixes stabilize tool JSON before first use and retain narrowly scoped reasoning replay metadata.

## Measured workload

Each arm reads the same three public repository files across three user turns, making six provider requests. Both include a cold first request and return READY after each read. Between turns, history passes through an actual PostgreSQL `jsonb` round trip. A checksum task on the first turn exercises reasoning in both arms. Tool choice is ordinary, not forced. The harness uses the actual SDK and product helpers; it does not start the full daemon/API/UI stack.

| Provider usage, complete conversation | Before | Both fixes |
|---|---:|---:|
| Input tokens | 93,828 | 94,441 |
| Cached input tokens | 51,840 | 67,200 |
| Uncached input tokens | 41,988 | 27,241 |
| Output tokens | 240 | 242 |

Uncached input falls by **35.1219%** in this workload. This is not a measured reduction in total tokens, total bill, latency, or all HumanLayer sessions. Input increases slightly because reasoning is retained. Runtime session frequency has not been measured.

`before-usage.jsonl` and `after-usage.jsonl` preserve the provider's aggregate counters for all 12 completed requests. Request labels are local labels. Per-item provider IDs and attribution, authorization, account metadata, ciphertext and prompt bodies are omitted.

The included pair is the complete after arm from `multiturn-natural` and complete before arm from `multiturn-natural-control`. An initial before attempt after the successful after arm stopped on a transport error and is excluded as an incomplete conversation. Separate isolated controls, including opposite request order, confirmed both causes. Their first resumed cached counts were 3,712 versus 9,984 for JSON ordering and 3,840 versus 9,472 for reasoning replay. An additional reasoning replicate timed out. These counts are not added to the combined pair.

## Recompute the published result offline

Run from this directory; Python standard library only:

```bash
python3 - <<'PY'
import json
from pathlib import Path
totals = {}
for arm in ('before', 'after'):
    rows = [json.loads(line)['usage'] for line in Path(f'{arm}-usage.jsonl').read_text().splitlines()]
    assert len(rows) == 6
    assert rows[0]['input_tokens_details']['cached_tokens'] == 0
    total = sum(r['input_tokens'] for r in rows)
    cached = sum(r['input_tokens_details']['cached_tokens'] for r in rows)
    assert all(0 <= r['input_tokens_details']['cached_tokens'] <= r['input_tokens'] for r in rows)
    totals[arm] = total - cached
    print(arm, dict(input=total, cached=cached, uncached=total-cached,
                    output=sum(r['output_tokens'] for r in rows)))
print('uncached reduction:', 1 - totals['after'] / totals['before'])
PY
```

## Live reproduction

`multiturn-probe.ts` is the original measured harness adapted to accept checkout/container paths and emit aggregate-only usage. Its successful inference path is unchanged; this portable adaptation has not been used to produce a new live measurement. Install the pinned dependencies with Bun in a checkout containing both fixes. Keep a separate baseline checkout at the measured commit for the public fixtures.

The included `combined-fix.patch` contains both fixes and regression tests. Apply it to a clean checkout at the measured base, then run `bun install --frozen-lockfile`. The two proposed code branches are independent of this evidence-only branch. `design-discussion.md` records the contributor's chosen scope and alternatives.

```bash
git clone https://github.com/humanlayer/humanlayer.git baseline
git -C baseline checkout cbaf99b79446a914a0136c8eb93617b63dd424d6
git clone baseline fixed
git -C fixed apply /absolute/path/to/combined-fix.patch
cd fixed
bun install --frozen-lockfile
```

Create an isolated PostgreSQL container (no host port is required):

```bash
docker run --detach --name hl-cache-repro -e POSTGRES_PASSWORD=local-repro-only postgres:17
docker exec hl-cache-repro pg_isready -U postgres
```

After PostgreSQL is ready, set the following paths in your local shell. `PROBE_AUTH` points to your existing local Codex authentication JSON with `tokens.access_token` and `tokens.account_id`. It is read only into memory; do not copy its contents into an issue or reproduction bundle.

```bash
PROBE_BASELINE=/absolute/path/to/baseline \
PROBE_FIXED=/absolute/path/to/checkout-with-both-fixes \
PROBE_AUTH=/absolute/path/to/local/auth.json \
PROBE_OUT=/absolute/path/to/new-output-directory \
PROBE_PG_CONTAINER=hl-cache-repro \
bun multiturn-probe.ts
```

This makes real inference requests using that account. It permits at most 24 network attempts, enforces the native Codex endpoint, requires exactly one successful read and two provider requests per turn, and fails closed if reasoning is absent or the task result changes. `PROBE_REVERSE=1` reverses arm order. A failure must not be counted as a successful conversation; retain it separately. Exact token counts and cache residency can vary between runs.

The original run's fixtures are `AGENTS.md`, `apps/riptide-daemon/src/agents/codelayer/execute-codelayer.ts`, and `apps/riptide-daemon/src/agents/codelayer/hooks.ts` from the measured base. Model/account guards and failure recovery are covered by deterministic unit tests; live credentials are not needed by CI.

Remove only this reproduction container when finished:

```bash
docker rm --force hl-cache-repro
```
