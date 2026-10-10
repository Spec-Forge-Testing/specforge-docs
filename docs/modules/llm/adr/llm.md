# LLM — Decision records — LLM client

Part of the [LLM decision records](index.md). Decisions about the client every
model call goes through: how a failure is acted on, which structured-output mode
a provider gets, and how a batch of calls is priced before it is sent.

---

## ADR-090 — Every failed attempt is classified once, and the class decides retry, fallback or stop { #adr-090 }

**Status:** accepted · `router/policy.py`, `router/retry.py`, `exceptions.py`

### Context

A fuzz run with inference sends a model call for every endpoint it infers, often
several in parallel. The failures those calls meet differ in what they mean. A rate limit,
a timeout or a provider outage is transient: the same model will likely answer
a moment later. A missing model, a prompt too long for its window, or an answer
that never validates is specific to that model: another one may do better. A bad
key, a malformed request or an unsupported parameter fails the same way on
every model. Treating them alike either loses an endpoint's contract to one
429, or spends every fallback on a request no model can serve.

### Decision

One table maps each provider error to a `FailureKind` and a policy, and one loop
acts on it for text and structured calls alike:

- **retry the same model** for `rate_limited`, `timeout` and
  `provider_unavailable` (5xx and connection errors), up to `LLM_MAX_RETRIES`
  times with an exponential, full-jitter backoff capped at 8 s;
- **fall back to the next model** for `model_not_found`, `context_too_long` and
  `invalid_output`, and for a retryable kind once its retries are spent;
- **stop** for `configuration`, `authentication` and `request_rejected`, raising
  a typed error without trying the rest of the chain.

The whole call runs inside one time budget, at least one attempt long: each
attempt's timeout is what is left of it, and a backoff that would cross it moves
on instead of waiting. Every model tried leaves a `ModelFailure` (kind, error
type, attempts, message) on the error the caller sees, together with the usage
already paid for.

### Rejected

Falling back on every failure: a bad key would be retried against every
provider, and an outage of the primary would be indistinguishable from a
misconfiguration. Catching provider exceptions at each call site: the text and
structured paths would each need their own loop, and two loops drift into
answering the same failure differently. A linear backoff without jitter:
parallel calls that hit the same rate limit would retry in lockstep and hit it
again.

### Consequences

The caller catches one hierarchy, `LLMError`, and reads why each model failed
without parsing a provider message. Adding a provider error is a row in the
table, not a new branch. An exception the table does not know propagates
untouched, so a bug is never retried into silence. The run's latency for one
endpoint is bounded by the call budget whatever the chain length.

---

## ADR-091 — The structured-output mode is chosen per provider from a table { #adr-091 }

**Status:** accepted · `constants.py`, `router/modes.py`, `router/schema.py`

### Context

A contract is only useful if the model's answer validates against the response
model. instructor can ask for structured output in several modes — the schema
in the prompt, a provider-side response schema, a tool call — and each provider
accepts only some of them. A mode a provider does not support fails when the
client is built or when the answer is parsed, on every call to that provider.
Gemini and Vertex also refuse a response schema whose references loop back on
themselves, which a nested contract schema does.

### Decision

`PROVIDER_INSTRUCTOR_MODES` names the mode per provider: `JSON` for `anthropic`,
`JSON_SCHEMA` for `gemini`, `vertex_ai`, `openai` and `mistral`, `TOOLS` for
`groq`, and `JSON_SCHEMA` for any provider not listed. When the response model's
schema is recursive, `gemini` and `vertex_ai` get `JSON`: the schema travels in
the prompt and instructor still validates the answer and re-asks. The router and
the estimator call the same function, so a call is priced in the mode it is sent
in. A caller may pass `mode=` to override the table for one call. A test builds
the real instructor client for every provider and schema shape, and parses an
answer through it.

### Rejected

One mode for every provider: no single mode is accepted by all of them. Choosing
the mode from an environment variable: it hands the user knowledge that belongs
to the package, and does not stop the table from breaking unnoticed.

### Consequences

Adding a provider means adding a row and its expected modes in the test; a mode
the provider cannot take fails the suite, not a run. Providers in `JSON` mode
carry the schema as prompt tokens, which the estimate counts. Building the
client is inside the typed failure boundary: a mode instructor cannot build is a
`configuration` failure, never an unexplained crash.

---

## ADR-092 — Cost is estimated without calling the model, and an unknown price is never free { #adr-092 }

**Status:** accepted · `estimation/`, `catalog.py`, `observability/metrics.py`

### Context

Inferring contracts for a whole API costs real money, and the user approves that
spend before it happens. An estimate that needs the network or a credential
cannot run before the user has configured and agreed to anything. And LiteLLM's
price map does not know every model: a lookup that falls back to zero makes an
unknown price look like a free call, which is the one answer that would approve
an unbounded spend.

### Decision

`estimate_structured_calls` prices a batch offline. instructor prepares the
exact request each call would send, in the mode the router would pick, and the
tokens are counted with LiteLLM's offline tokenizer, scaled by a measured
per-provider factor. The estimate says how its tokens relate to the provider's:
`calibrated` when the provider has a factor (`anthropic`: 1.52), `approximate`
otherwise. Calls sharing a cache-marked prefix are priced as one write and then
reads, only when the provider caches and the prefix reaches its minimum.

A cost the package cannot know is `None`, and `priced` is `False`: on one call's
metrics, on a batch total as soon as one call is unpriced, and on an estimate.
`format_cost_usd` renders it as `unpriced`. `ModelCatalog` is the single reader
of the price map for the router, the usage collector and the estimator.

### Rejected

Counting through the provider's token-counting endpoint: it needs the network
and an account. Counting with a tokenizer chosen from the model name: some names
open a network connection, and the tokenizer changes from model to model.
Re-creating instructor's request shape by hand: it drifts silently with every
instructor release. Reporting `0.0` for an unpriced model: it hides the cost
until the bill arrives.

### Consequences

An estimate is deterministic and free, and can be shown before any key is
checked. It is an approval figure, not a brake: the output size is the caller's
`expected_output_tokens`, re-asks and fallbacks are not counted, and a limit on
real spend is enforced against the metrics a run returns. Every reader of a cost
has to handle `None`; that is the price of never lying about it.
