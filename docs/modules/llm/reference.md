# LLM — Reference

This page details how `llm` works, from its settings to what a call reports
about its cost. What the package is for, and how to install it, is in the
[module overview](index.md).

## Package layout

| Path | Holds |
| --- | --- |
| `settings.py`, `runtime_dirs.py` | `LLMSettings`, `get_settings`, the credential checks; where the env file is read from |
| `client.py` | `LLMClient`, the entry point |
| `router/` | `LLMRouter`, the retry loop (`retry.py`), the failure policy (`policy.py`), the mode choice (`modes.py`), the wire shape (`wire.py`) |
| `estimation/` | `estimate_structured_calls` and the estimate DTOs |
| `observability/` | the usage collector and the metrics DTOs |
| `catalog.py` | `ModelCatalog`, what LiteLLM's model map knows about a model |
| `constants.py` | every provider table: keys, modes, prompt cache, token calibration; the retry and budget defaults |
| `exceptions.py` | `FailureKind`, `ModelFailure` and the exception hierarchy |

## Settings and the model chain

`LLMSettings` is a pydantic-settings model. Each field has one environment
variable:

| Field | Variable | Default | Rule |
| --- | --- | --- | --- |
| `primary_model` | `LLM_MODEL` | — | Required. A LiteLLM model string, `<provider>/<model-id>`. |
| `fallback_models` | `LLM_FALLBACK_MODELS` | none | Comma-separated, tried in order after the primary. |
| `max_retries` | `LLM_MAX_RETRIES` | `2` | `≥ 0`. Retries of one model on a retryable failure. |
| `timeout_seconds` | `LLM_TIMEOUT_SECONDS` | `30.0` | `> 0`. Timeout of one attempt. |
| `retry_backoff_base_seconds` | `LLM_RETRY_BACKOFF_BASE_SECONDS` | `0.5` | `≥ 0`. Base of the backoff between retries. |
| `call_budget_seconds` | `LLM_CALL_BUDGET_SECONDS` | `120.0` | `> 0` and at least `timeout_seconds`, so one full attempt always fits. |

`model_chain` is the primary model followed by the fallbacks, in try order; a
chain of two or more models gives a failing call somewhere to go.

### Where each value comes from

`get_settings(overrides)` resolves every field from the first source that has
it:

1. `overrides`, a mapping keyed by field name — how a caller applies its own
   configuration without touching the environment;
2. the process environment;
3. the env file;
4. the field default.

Before building the settings, `get_settings` exports the env file's entries to
the process environment with `override=False`: a variable already set in the
process keeps its value, and LiteLLM finds the provider keys that only the file
declares. Any invalid or missing value raises `LLMConfigurationError`, whose
`missing` lists the variables that were absent.

### Which env file is read

The path is resolved once, when the package is imported, so `LLM_ENV_FILE` has
to be set before the first `import llm`.

| Situation | File |
| --- | --- |
| `LLM_ENV_FILE` is set | that path |
| Running from a source checkout | `lib/llm/.env.local` |
| Running from a frozen build | `.env.local` under the user config directory, in `spec-forge/` |

The file is optional; without it, every value comes from the process environment.

### Credentials

A model's provider is the prefix of its model string. Each provider needs one of
its key variables:

| Provider | Key |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| `vertex_ai` | `GOOGLE_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `groq` | `GROQ_API_KEY` |

`ensure_credentials(settings)` checks **every model of the chain**, not only the
primary, and raises one `LLMConfigurationError` naming each model whose key is
unset. `LLMClient()` calls it before building its default router; a client given
an explicit router skips the check. `get_required_api_key_env_vars(model)` and
`has_credentials_for_model(model)` answer the same question for one model; the
second looks in the process environment and in the env file.

## Making a call

| Method | Returns | Arguments |
| --- | --- | --- |
| `complete_text` | the text and the `LLMUsageMetrics` of the request that answered | `messages`, `max_tokens`, `temperature` |
| `complete_structured` | an instance of `response_model` and the `StructuredCompletionMetrics` of the whole call | `messages`, `response_model`, `max_retries` (instructor re-asks, default `2`), `mode` (overrides the provider's mode) |

A `Message` is a dict with `role`, `content` and an optional `cacheable` flag.
`temperature` is sent only to a model that LiteLLM's model map says accepts it;
a structured call asks for `0.0` under the same rule.

"Retry" means two different things here. `LLM_MAX_RETRIES` counts transport
retries of one model after a classified failure. The `max_retries` argument of
`complete_structured` counts instructor's re-asks when an answer fails
validation; those happen inside a single attempt.

## Failures and the policy

Every failed attempt goes through one classification table, `POLICY_TABLE` in
`router/policy.py`. The first row whose exception types match decides the
`FailureKind` and the router's action. instructor's retry wrapper is unwrapped
first, so the real cause is classified.

| `FailureKind` | Provider error | Action | Raised at the end |
| --- | --- | --- | --- |
| `rate_limited` | rate limit (429) | retry the same model, then fall back | — |
| `timeout` | the attempt timed out | retry the same model, then fall back | — |
| `provider_unavailable` | 500, 502, 503, a connection error, or any other API error with a status of 500 or more | retry the same model, then fall back | — |
| `model_not_found` | 404: the model does not exist | fall back | — |
| `context_too_long` | the prompt exceeds the context window | fall back | — |
| `invalid_output` | the answer still fails validation after instructor's re-asks, cannot be parsed, is incomplete, or is empty | fall back | — |
| `authentication` | 401 or 403 | stop | `LLMAuthenticationError` |
| `request_rejected` | 400, 422, or any other API error below 500 | stop | `LLMRequestRejectedError` |
| `configuration` | a parameter the model does not support, or a mode instructor cannot build | stop | `LLMConfigurationError` |

**Retry** waits a backoff and tries the same model again, at most
`LLM_MAX_RETRIES` times; once the retries are spent the call falls back. **Fall
back** gives up on the model and moves to the next one in the chain. **Stop**
raises at once without trying the remaining models: a bad key, a malformed
request or an unsupported parameter would fail the same way on every model.

When every model of the chain is given up, the call raises
`LLMAllProvidersExhaustedError`, whose `models` lists them. When the call budget
runs out first, it raises `LLMCallBudgetExceededError` with its
`budget_seconds`. An exception the table does not match is not a provider
failure: it is a bug and propagates untouched.

### The exception hierarchy

```text
LLMError
├── EmptyCompletionError              a completion without text (classified as invalid_output)
├── LLMConfigurationError             unusable configuration; never retried, never a fallback
├── LLMCompletionError                a call ended without an answer; .failures says why
│   ├── LLMAuthenticationError
│   ├── LLMRequestRejectedError
│   ├── LLMCallBudgetExceededError
│   └── LLMAllProvidersExhaustedError
└── LLMEstimationError                a batch could not be priced offline
```

`LLMCompletionError.failures` holds one `ModelFailure` per model tried, in order:
its `model`, its `kind`, the provider's `error_type`, how many transport
`attempts` it took, and a short `message` — for an authentication failure, the
key variable to check. A retry replaces the previous record of the same model,
so the record is the model's last word.

A failure keeps what the call paid for. Once any model was tried, `LLMError`
carries `call_usage` (the usage of every request that reported one) and, for a
structured call, `metrics` folded the same way as on success. Both stay `None`
when no model was tried.

## Backoff and the call budget

The backoff before retry `n` of a model is **exponential with full jitter**: a
uniform draw between zero and `min(8 s, base × 2^(n−1))`, where `base` is
`LLM_RETRY_BACKOFF_BASE_SECONDS`. The jitter keeps parallel callers that hit
the same rate limit from retrying in lockstep; the 8 s cap bounds the wait
however many retries are configured.

One call never spends more than `LLM_CALL_BUDGET_SECONDS`, across every attempt,
backoff and fallback:

- each attempt gets `min(LLM_TIMEOUT_SECONDS, time left)` as its timeout, which
  also bounds instructor's re-asks inside it;
- a retry whose backoff would end past the deadline is not taken: the model is
  given up and the call falls back;
- when less than `MIN_ATTEMPT_SECONDS` (one second) is left before an attempt,
  the call raises `LLMCallBudgetExceededError`.

The clock and the random source are injected into `LLMRouter`, so the suites
check every timing rule without sleeping.

## Structured-output modes

A structured call needs the provider to answer in JSON that matches the response
model. Providers accept that request in different shapes, so the mode is chosen
per provider from `PROVIDER_INSTRUCTOR_MODES`:

| instructor mode | Providers | The schema travels |
| --- | --- | --- |
| `JSON` | `anthropic` | in the prompt |
| `JSON_SCHEMA` | `gemini`, `vertex_ai`, `openai`, `mistral`, and any provider not listed | as the provider's response schema |
| `TOOLS` | `groq` | as a tool definition |

One exception: `gemini` and `vertex_ai` refuse a response schema whose
references loop back on themselves. When the response model's schema is
recursive, those two providers get `JSON` mode, where the schema travels in the
prompt and instructor still validates the answer and re-asks. A caller that
passes `mode=` to `complete_structured` overrides the table.

## Prompt caching

Calls that share a long fixed prefix — the same system prompt for every endpoint
— can have the provider cache that prefix. A caller marks the prefix by setting
`cacheable: True` on the messages that open the list:

- cacheable messages must come first; a cacheable message after a non-cacheable
  one is a caller bug and raises `ValueError`;
- for a provider in `PROVIDER_PROMPT_CACHE` — `anthropic` is the only one — the last
  cacheable message is sent with a `cache_control` marker of type `ephemeral`;
- every other provider receives the same messages as plain text.

The provider only caches a prefix of at least `min_tokens` tokens; for
`anthropic` the policy sets 4096, the most conservative of its models' minimums.
The estimator uses that threshold to decide whether a prefix is priced as cached.

## Estimating a batch

`estimate_structured_calls(calls, *, response_model, model, expected_output_tokens,
prompt_cache=True, catalog=None)` prices a batch of structured calls **without a
network call and without a credential**. Each entry of `calls` is the message
list of one call.

**What is counted.** instructor itself prepares each request in the mode the
router would pick, so the response schema is counted wherever that mode puts it.

**Tokens.** Text is counted with LiteLLM's offline tokenizer and scaled by the
provider's factor in `PROVIDER_TOKEN_CALIBRATION`:

| `TokenBasis` | When | Factor |
| --- | --- | --- |
| `calibrated` | the provider has a measured factor | `anthropic`: 1.52 provider tokens per offline token |
| `approximate` | any other provider | 1.0 |

**Prompt cache.** Calls whose cache-marked prefix is identical are priced as one
batch: the first writes the prefix, every later one reads it. This applies only
when `prompt_cache` is true, the provider has a cache policy, and the prefix
reaches its `min_tokens`; otherwise every token is priced as plain input, which
errs high.

**Price.** Tokens are priced through LiteLLM's model map. A model the map does
not price gives `cost_usd = None` on every call; the batch total is `None` as
soon as one call is unpriced, and an empty batch costs `0.0`. An entry that
LiteLLM cannot use, or a request instructor cannot prepare, raises
`LLMEstimationError` with the `model` and the `cause`.

**What is not estimated.** The output size is the caller's
`expected_output_tokens`. Re-asks and fallbacks are not estimated: one model,
one attempt per call. A limit on real spend is enforced against the metrics a
run returns; the estimate is what a run is approved on.

| `CostEstimate` | Meaning |
| --- | --- |
| `model` | the model priced |
| `token_basis` | `calibrated` or `approximate` |
| `prompt_cache` | whether the prompt cache was modelled |
| `calls` | one `CallEstimate` per call, in order |
| `input_tokens`, `output_tokens` | the batch totals |
| `cost_usd` | the batch total, or `None` when any call is unpriced |
| `priced` | `cost_usd is not None` — `False` means no price is known, never free |

A `CallEstimate` carries `input_tokens` (cache tokens included),
`cache_write_tokens`, `cache_read_tokens`, `output_tokens` and `cost_usd`.

## The model catalog

`ModelCatalog` is the one reader of LiteLLM's model map. `entry(model)` looks the
model up under `provider/name`, then under `name`, and returns `None` when
neither is listed. `is_priced(model)` is true when the entry has a per-token
input price; `accepts_temperature(model, temperature)` when the model is listed
and LiteLLM would send it that temperature. The router, the usage collector and
the estimator share it, so "is this model priced?" has one answer across a call
and its estimate.

## Usage metrics

A usage collector registered with LiteLLM files the usage of every request under
the request id the router issued for it — answers that later fail validation
included, since the provider bills them too.

| `LLMUsageMetrics` | Meaning |
| --- | --- |
| `model` | the model the request went to |
| `prompt_tokens`, `completion_tokens`, `total_tokens` | as the provider reported them |
| `cache_read_tokens` | prompt tokens served from the provider's prompt cache |
| `cache_creation_tokens` | prompt tokens written to it |
| `cost_usd` | the request's cost, or `None` when the model is unpriced or LiteLLM could not compute it |
| `latency_ms` | the request's duration |
| `priced` | `cost_usd is not None` |

`StructuredCompletionMetrics` folds the same fields over every request of one
call: `attempts`, `retries`, the three token totals, `cache_read_tokens`,
`cache_creation_tokens`, `parse_errors` (instructor parse failures across all
attempts), `usage` (the per-request records) and `total_cost_usd`, which is
`None` as soon as one request is unpriced.

`format_cost_usd(cost)` renders a cost for people: six decimals, or `unpriced`
when the cost is `None`. A missing price is never shown as zero.

## Where to change what

| To | Change |
| --- | --- |
| Support a new provider | Add its key variables to `PROVIDER_API_KEY_ENV_VARS` and its mode to `PROVIDER_INSTRUCTOR_MODES` in `constants.py`, and its flat and recursive rows to the expected modes in `tests/router/test_instructor_modes.py`. |
| Cache its prompt prefix | Add a `PromptCachePolicy(control=..., min_tokens=...)` under its name in `PROVIDER_PROMPT_CACHE`. |
| Calibrate its token count | Add its measured factor to `PROVIDER_TOKEN_CALIBRATION`; its estimates become `calibrated`. |
| Treat a new provider error | Add a row to `POLICY_TABLE`: the exception types and a `FailurePolicy(kind, retry_same_model, message, terminal_error)`. The first matching row wins, so a subclass's row goes before its parent's. |
| Mark a provider as needing `JSON` for recursive schemas | Add it to `RECURSIVE_SCHEMA_UNSUPPORTED_PROVIDERS`. |

!!! tip "Adding a provider"
    A provider is data, not code. The mode test builds the real instructor
    client for each expected row and parses an answer through it, so a mode the
    provider cannot take fails a test instead of a run.

The reasons behind the policy, the mode table and the estimate are recorded in
the [decision records](adr/index.md).
