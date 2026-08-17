# dsv4-proxy

An OpenAI-compatible proxy that sits in front of [SGLang](https://github.com/sgl-project/sglang) serving **DeepSeek-V4-Flash**, and keeps the model reasoning across long agent sessions.

```
agent client ──► dsv4-proxy ──► sglang-router ──► inference workers
                     │
                dsv4-redis   (cached reasoning traces)
```

It began as a queue-full `503`→`429` rewriter. Most of what it does now works around a reasoning-collapse failure mode described below.

---

## The problem

In long agent sessions the model gradually stops thinking. `reasoning_tokens` drops to `1` — an immediately-closed thinking block — on most turns, **including the ones producing thousands of tokens of real code**. Output quality degrades and repetition creeps in. It looks like the model got worse, while nothing about the deployment changed.

### Causal chain

1. **DeepSeek-V4 requires previous turns' reasoning to be replayed.** Per the [thinking-mode docs](https://api-docs.deepseek.com/guides/thinking_mode/), when a request carries `tools`, `reasoning_content` *"must participate in the context concatenation and must be passed back to the API in all subsequent user interaction turns"*. The hosted API answers **400** when it is missing.

2. **Translation layers drop it.** Anthropic→OpenAI gateways strip the thinking blocks and do not re-inject them. Verified by sending 18 assistant messages each carrying a `thinking` block and observing `assistant_with_reasoning=0` in the converted request.

3. **SGLang accepts the request instead of rejecting it.** Its DSV4 encoder renders each historical assistant turn's thinking block from that message's `reasoning_content`, so a missing one becomes an **empty** `<think></think>`:

   ```
   without reasoning_content:  <|Assistant|><think></think>\n\n<tool_calls>…
   with    reasoning_content:  <|Assistant|><think>I need to inspect…</think>\n\n<tool_calls>…
   ```

4. **Those empty blocks become few-shot examples** teaching the model that this assistant does not think, and it copies the pattern. This is in-context learning, not a decision — it copies the *length* too.

### Measured thresholds

`reasoning_effort=max`, 12 runs per row, empty-history conversations of increasing length:

| empty `<think></think>` turns | responses with `reasoning=1` |
|---|---|
| 20 | 4/12 (33%) |
| 60 | **12/12 (100%)** |
| 120 | **12/12 (100%)** |
| 170 | **12/12 (100%)** |

Past roughly **60 turns it is deterministic**, not probabilistic. Production agent sessions run 100–200 turns.

### Corroboration

- HF [#39](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731/discussions/39) describes the same mechanism independently (one session's thinking rate fell from 63% to 3% by turn ~100) and adds that non-thinking turns emit **50–488** loop fragments versus **0–8** for thinking turns — the degradation reinforces itself in both directions.
- HF [#58](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731/discussions/58) reproduces the tool-call repetition on three unrelated serving stacks (Ollama cloud 6/6, DashScope 2/6, vLLM 4/6), ruling out infrastructure.
- The client-side half is filed across the ecosystem: [opencode#24124](https://github.com/anomalyco/opencode/issues/24124), [goose#9200](https://github.com/aaif-goose/goose/issues/9200), [kilocode#9501](https://github.com/Kilo-Org/kilocode/issues/9501), [claude-code-router#1378](https://github.com/musistudio/claude-code-router/issues/1378), [LangChain.js#10883](https://github.com/langchain-ai/langchainjs/issues/10883).

> **The fix is preventive, not curative.** A session that already degraded keeps degrading at any effort setting (HF #39). Evaluate changes on a **fresh session**.

---

## What it does

Four layers, each independently switchable.

### 1. `reasoning_effort` injection
SGLang treats a missing `reasoning_effort` as "none". A default is injected; `REASONING_EFFORT_OVERRIDE=1` also replaces what the client sent.

Verified reaching the model by prompt-token delta: `low`=17, `high`=96 (+79), `max`=109 (+92), matching the model card's prefix texts byte for byte.

### 2. `reasoning_content` backfill — the main fix
Caches the reasoning returned with each response and replays it into later requests.

- **Keys**: `tool_call_id` when the turn called a tool; otherwise a hash of the turn's leading content, because a turn that answered instead of calling a tool still needs its reasoning replayed and has no id.
- **Scope** mirrors SGLang's own rule: with `tools` every turn is repaired (`drop_thinking=False` server-side); without `tools` only turns after the last `user` message, since earlier ones get stripped by `_drop_thinking_messages` anyway. Note the boundary counts only `user`/`developer` — tool results render as `<|User|>` but do not move it, so agent loops keep an early boundary and nearly every turn stays worth repairing.
- **Never overwrites** reasoning the client did send.

### 3. Loop scrubbing
Collapses repeated short lines inside **assistant messages only**, plus a `frequency_penalty` on requests where something was actually removed (the recipe reported to work in HF #58).

Structural markers are exempt: an early version stripped markdown code fences (` ``` ` repeating 6 times) and broke every code-block pairing in the replayed history.

### 4. Deadlock backstop
If the model returns `reasoning<=1` on N consecutive responses **for the same session**, one line is appended to the trailing tool result. On a deadlocked conversation this moved median reasoning from 1 to 1390 with `finish_reason` staying `tool_calls` in 6/6 runs.

The trigger reads **responses, not requests**. An earlier version checked whether recent assistant messages carried `reasoning_content` — but backfill writes exactly that field, so the nudge saw its own repair and stayed silent while the model was demonstrably stuck.

Wording matters: `"Think carefully about what to do next before responding."` keeps the agent loop; phrasing it as `"before answering, reason step by step"` pushed 4/6 runs to `finish_reason=stop`, i.e. the model stopped calling tools mid-loop.

---

## Results

Fresh session, 133 turns, n=56 responses:

| output size | `reasoning=1` | median thinking |
|---|---|---|
| < 200 tokens (tool decisions) | 9/10 | 1 |
| 200–800 | 9/33 | 193 |
| **> 800 (substantive)** | **0/13** | **837** (max 2496) |

Backfill coverage holds at **70%**, flat across turns 124→133 — past the 60-turn threshold with no slide. Before the fix the equivalent session sat at 62% and falling, with `reasoning=1` on substantive turns.

Turns under 200 tokens skipping reasoning is expected — deciding which file to read next needs no deliberation. **Judge health by the `>800` row.**

The remaining 30% coverage gap is structural: turns that never reasoned produced nothing to cache. Filling them with placeholder text was tested and rejected — the model copies the placeholder's length, pinning every later response to it (10 runs collapsed to a flat 54 tokens).

### Performance

| | |
|---|---|
| Proxy ceiling, 865KB requests (200-turn history) | **~12,000 RPM** — 37× the upstream's ~320 RPM |
| Redis writes | 17,900 traces/s |
| Backfill lookup, 200 keys | 6.1ms (one pipelined round trip, including decryption) |
| Encryption overhead | +6.7ms per lookup ≈ 0.1–0.7% of a 1–7s inference |
| 10,000 traces | 40MB in Redis |

The proxy is never the bottleneck; GPU concurrency is.

---

## Install

```bash
openssl rand -hex 32 > cache.key && chmod 600 cache.key
docker compose up -d
```

Then point your client at `http://localhost:8002/v1`. See [`.env.example`](.env.example) for every setting.

Without Docker:

```bash
npm ci
UPSTREAM=http://localhost:30000 PORT=8002 \
  DEFAULT_REASONING_EFFORT=max BACKFILL_REASONING=1 \
  npm start
```

Redis is optional — without it the cache is in-process only and does not survive a restart, which puts long sessions straight back into the deterministic zone.

---

## Monitoring

One line per request and per response, counters only, never message content:

```
[effort] r12 req model=… effort_client=high effort_sent=max injected=yes backfilled=93 stream=true max_tokens=128000 messages=400
[effort] r12 res status=200 prompt=167213 completion=984 reasoning=768 finish=tool_calls thinking=yes content=yes dur=3.4s cache=816
```

```bash
# Health: substantive turns must not show reasoning=1
docker logs dsv4-proxy | grep '\[effort\].* res ' \
  | awk -F'completion=' '{print $2}' | awk '$1>800' | grep -c 'reasoning=1'

# Coverage: backfilled should track turn count (≈ messages/3), never freeze
docker logs dsv4-proxy | grep -oE 'backfilled=[0-9]+' | tail -20

# The backstop firing means layers 1–3 stopped holding
docker logs dsv4-proxy | grep -c 'nudged=yes'
```

### Diagnostics

All default to off and **all print real content** — use on a trusted console.

| variable | shows |
|---|---|
| `DUMP_REQUEST=struct` | roles, field names, lengths, and a `think-pattern` line (`#` = turn has reasoning, `.` = empty) — the fastest way to see a collapse |
| `DUMP_REQUEST=full` | the entire request body |
| `DUMP_RESPONSE_CHARS` | what the model actually reasoned and wrote |
| `DUMP_BACKFILL_CHARS` | which key each restored trace came from, to match against `[rdump]` |
| `DUMP_SCRUB_CHARS` | which repeated units the scrubber removed |

---

## Development

```bash
npm test           # 108 tests
npm run test:unit  # pure logic, ~120ms
npm run test:e2e   # spawns the proxy against a mock upstream
```

Redis-dependent tests skip themselves when no Redis is reachable; set `TEST_REDIS_URL` to point elsewhere. CI should provide one — those assertions are the only proof that persistence and TTL renewal work.

```
src/
  index.js          server assembly and lifecycle
  config.js         every environment variable, parsed once
  crypto.js         AES-256-GCM, cache keys, session ids
  cache.js          L1 LRU + L2 Redis
  upstream.js       503→429, SSE rewriting, usage extraction
  observability.js  structured logging and diagnostics
  transform/        effort · backfill · scrub · nudge
bench/              throughput and crypto-cost measurements
```

Pure logic takes its options as arguments rather than reading config, so unit tests exercise it without `process.env` or a live process.

---

## Security

Cached reasoning is encrypted with AES-256-GCM (random IV per value) before it reaches Redis or disk. The key is read from `REASONING_CACHE_KEY_FILE`; prefer the file form, since an inline `REASONING_CACHE_KEY` shows up in `docker inspect`.

This protects **data at rest** — stolen backups, decommissioned disks, an accidentally copied AOF file. It does not protect against anyone who can run commands on the host: they can read the key file and the live process memory. Losing the key is not fatal (a wrong key degrades to a cache miss, the cache rebuilds) but coverage drops to zero meanwhile, so back it up.

Key rotation is not implemented: changing the key makes existing entries undecryptable, and they are treated as misses until the TTL expires them.

---

## Ruled out

Recorded so nobody re-investigates. Each was tested against a live deployment.

| hypothesis | verdict |
|---|---|
| Gateway config / transformer plugins | Clean — no sampling params, no message rewriting |
| Gateway injecting sampling defaults | Pure passthrough |
| Gateway rewriting `tool_call_id` | Preserved verbatim; backfill hit rate proves it |
| `top_p` deviating from the model card (1.0 vs 0.95) | No accuracy effect: 18/18 both ways |
| DSPARK draft depth | `block_size=3`; [sglang#34959](https://github.com/sgl-project/sglang/issues/34959) finds only depth 5/6 corrupt. Identifier-corruption test: 0/288 |
| Chat template | HF #58 reproduces via raw completion with the reference encoder |
| Long context alone | 131K-token prompt still reasons normally (863 tokens) |
| Tools present / many tools | Reasons with and without |
| Streaming | 81 reasoning deltas over SSE |
| Multi-turn history alone | 30 turns still reasons (456) |
| `--enable-dp-attention` bugs ([#33397](https://github.com/sgl-project/sglang/issues/33397), [#33360](https://github.com/sgl-project/sglang/issues/33360)) | Not enabled |
| HiCache / PD / HiSparse issues | Those features not enabled |
| `reasoning_effort` mapped one level off ([#33185](https://github.com/sgl-project/sglang/issues/33185)) | Real bug, but fixed in the pinned nightly — token deltas confirm the correct three-level mapping |

**Still unverified:** `--kv-cache-dtype fp8_e4m3` + `--attention-backend dsv4` on Hopper. sglang#33397 asks maintainers whether that combination is tested for this checkpoint; no answer yet.

> **Methodology warning.** Synthetic conversations do not reproduce this reliably — HF #58 got 0/22 from synthetic payloads matching real depth, tool count and structure, concluding the attractor *"requires realistic content statistics"*. Several early conclusions here came from 20-turn synthetic tests sitting right at the noise-heavy threshold and were later contradicted by production data. Prefer measuring on real traffic.

---

## License

MIT
