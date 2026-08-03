# Multi-Model Router and Fallback System (LiteLLM)

A model router built on **LiteLLM** lets the pipeline pivot dynamically between
providers (OpenAI, Anthropic, Gemini, Groq, Mistral) without refactoring any
calling code, keeping high availability through an automatic fallback chain and
retry policies.

## Architecture decisions

### 1. Centralized on LiteLLM

All inference calls go through `litellm.completion`, avoiding direct
provider-specific SDKs. This keeps the system provider-agnostic and makes adding a
new model a configuration change, not a code change.

### 2. Resilience layer (retries and fallbacks)

The system runs a retry "spiral" before falling through to the next model in the
fallback list.

- **Retry** — applied on transient network errors or server-side delays.
- **Fallback** — triggered when the primary provider is out of quota or has a
  critical outage.

### 3. Error classification

| Error | Likely cause | System action |
|---|---|---|
| `AuthenticationError` | Invalid or expired API key. | **Fail-fast** — no retry, execution stops to avoid a silent failure. |
| `RateLimitError` (429) | Quota/credits exhausted. | **Fallback** — switches immediately to the next provider in the list. |
| `ServiceUnavailable` (500) | Provider-side outage. | **Fallback** — tries the next available provider. |
| `Timeout` | Model is slow to respond. | **Retry** — retries the same model with exponential backoff. |

## Logging

Fallback logging is already implemented via `logging.warning`, but to see it
clearly in a real deployment the module's or service's entrypoint should configure
log handlers/formatting. The logic itself is in place; what's still missing is a
project-wide logging configuration.
