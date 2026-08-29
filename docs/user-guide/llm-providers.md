# LLM Providers

Spec Forge's semantic-inference stage calls an LLM through
[LiteLLM](https://docs.litellm.ai/), so any supported provider works with the
same configuration: pick a model, set its credential, and the router handles the
rest (retries, fallbacks).

## Where configuration lives

`lib/semantic_inference` reads a module-local file, **not** a root `.env`:

```
lib/semantic_inference/.env.local
```

Copy `.env.local.example` in that directory to `.env.local` and fill it in.
Values already exported in the environment take precedence over the file.

## Required settings

| Variable | Purpose |
| --- | --- |
| `LLM_MODEL` | The model to call, in LiteLLM's `provider/model` form (e.g. `anthropic/claude-sonnet-5`). |
| *provider key* | The credential for that model's provider — see the table below. |

Only the key matching the configured `LLM_MODEL` is needed; you don't set every
provider's key at once.

| Provider | Key variable | Example `LLM_MODEL` |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-5` |
| Google Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `gemini/gemini-2.5-pro` |
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-4o` |
| Mistral AI | `MISTRAL_API_KEY` | `mistral/mistral-large-latest` |
| Groq | `GROQ_API_KEY` | `groq/llama-3.3-70b-versatile` |

Model names change often — check your provider's current catalogue (or
[LiteLLM's provider list](https://docs.litellm.ai/docs/providers)) rather than
copying the examples verbatim.

## Optional tuning

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_FALLBACK_MODELS` | — | Comma-separated models the router tries, in order, when the primary is rate-limited or unavailable. |
| `LLM_MAX_RETRIES` | `2` | Retries against one model before moving to the next. |
| `LLM_TIMEOUT_SECONDS` | `30` | Per-call timeout. |

## Verifying the setup

`specforge doctor` reports whether `LLM_MODEL` is set and whether the matching
credential is present (it never reads or prints the value). The semantic-inference
integration tests read the same file — see
[Contributing & Testing](../developer-guide/contributing.md#test-scope).
