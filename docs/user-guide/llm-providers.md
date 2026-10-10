# LLM Providers

Spec Forge's semantic-inference stage calls an LLM through
[LiteLLM](https://docs.litellm.ai/), so any supported provider works with the
same configuration: pick a model, set its credential, and the router handles the
rest (retries, fallbacks). The router lives in the [LLM](../modules/llm/index.md)
package, `lib/llm`, which owns the configuration below.

## Where configuration lives

`lib/llm` reads a module-local env file, **not** a root `.env`:

```
lib/llm/.env.local
```

Copy `lib/llm/.env.local.example` to `lib/llm/.env.local` and fill it in, or set
`LLM_ENV_FILE` in the shell to read another file. Values already exported in the
environment take precedence over the file.

A project's `specforge.toml` can fix the same settings for its own runs, under
`[llm]`: `primary_model`, `fallback_models`, `max_retries`, `timeout_seconds`,
`call_budget_seconds` and `retry_backoff_base_seconds`. An option set there takes
precedence over the environment and the env file; one left unset falls back to
them. Provider keys are never read from `specforge.toml`.

## Required settings

| Variable | Purpose |
| --- | --- |
| `LLM_MODEL` | The model to call, in LiteLLM's `provider/model` form (e.g. `anthropic/claude-sonnet-5`). |
| *provider key* | The credential for that model's provider — see the table below. |

Every model of the chain needs its provider's key: `LLM_MODEL` and each model in
`LLM_FALLBACK_MODELS`. A chain of one provider needs one key; a chain across two
providers needs both.

| Provider | Key variable | Example `LLM_MODEL` |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-5` |
| Google Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `gemini/gemini-2.5-pro` |
| Google Vertex AI | `GOOGLE_API_KEY` | `vertex_ai/gemini-2.5-pro` |
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-4o` |
| Mistral AI | `MISTRAL_API_KEY` | `mistral/mistral-large-latest` |
| Groq | `GROQ_API_KEY` | `groq/llama-3.3-70b-versatile` |

Model names change often — check your provider's current catalogue (or
[LiteLLM's provider list](https://docs.litellm.ai/docs/providers)) rather than
copying the examples verbatim.

## Optional tuning

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_FALLBACK_MODELS` | — | Comma-separated models the router tries, in order, when the primary fails. |
| `LLM_MAX_RETRIES` | `2` | Retries against one model before moving to the next. |
| `LLM_TIMEOUT_SECONDS` | `30` | Timeout of one attempt. |
| `LLM_RETRY_BACKOFF_BASE_SECONDS` | `0.5` | Base, in seconds, of the exponential wait between retries. |
| `LLM_CALL_BUDGET_SECONDS` | `120` | Total seconds one call may spend across its retries and fallbacks; at least `LLM_TIMEOUT_SECONDS`. |
| `LLM_ENV_FILE` | — | The env file to read instead of `lib/llm/.env.local`; set it in the shell. |

How the router retries, backs off and falls back is in the
[LLM reference](../modules/llm/reference.md#failures-and-the-policy).

## Verifying the setup

The doctor (the protocol's `diagnose` operation) reads the env file
the LLM package reads, with the shell taking precedence, and reports three
checks: whether that env file exists, whether `LLM_MODEL` is set, and whether a
credential is present for every model of the chain, naming each model that lacks
one. It never prints a credential's value. Without the LLM packages installed it
cannot tell a model's provider, so it only checks that some known provider key is
set. It reads the environment alone: a model set under `[llm]` in
`specforge.toml` is not part of its check. The semantic-inference
integration tests read the same file — see
[Contributing & Testing](../developer-guide/contributing.md#test-scope).
