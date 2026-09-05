# Environment Variables

Every environment variable Spec Forge reads, what it does, and where it is read from. Two
sources are used: your **shell** (the process environment) and the module-local
**`.env.local`** file (`lib/semantic_inference/.env.local`, used for LLM settings). Where both
carry the same key, `.env.local` wins.

## Interface and behaviour

| Variable | Read from | Default | What it does |
| --- | --- | --- | --- |
| `SPECFORGE_THEME` | shell | `default` | Selects the UI color theme at startup. Valid values: `default`, `mono`, `nord`, `dracula`, `solarized`, `matrix`. An unknown name falls back to `default`. You can also switch it live with the `theme` command. |
| `SPECFORGE_SYSTEM_COMMANDS` | shell | enabled | Controls the `!` shell-escape. Set it to a falsy value (`0`, `false`, `no`, `off`, case-insensitive) to disable running system commands from the REPL — useful in CI. Any other value, or unset, leaves it enabled. |
| `CORETEST_DB_PATH` | shell | `data/coretest.db` | Path to the SQLite database that stores projects, analyses and runs. |
| `CORETEST_ARTIFACTS_ROOT` | shell | `data/artifacts` | Root folder for on-disk artifacts (reports and trace files). |

## LLM configuration

These are read from `.env.local` or the shell (`.env.local` wins). Only the business-rule
inference step needs them; fuzzing straight from the spec does not. See
[LLM Providers](llm-providers.md) for the full setup.

| Variable | Default | What it does |
| --- | --- | --- |
| `LLM_MODEL` | — | The model to use, e.g. `gemini/gemini-2.5-flash`. |
| `LLM_FALLBACK_MODELS` | none | Comma-separated models tried in order if the primary fails. |
| `LLM_MAX_RETRIES` | `2` | How many times to retry a failed model call. |
| `LLM_TIMEOUT_SECONDS` | `30` | Per-call timeout, in seconds. |
| `ANTHROPIC_API_KEY` | — | Credential for Anthropic models. |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — | Credential for Google Gemini / Vertex AI models. |
| `OPENAI_API_KEY` | — | Credential for OpenAI models. |
| `MISTRAL_API_KEY` | — | Credential for Mistral models. |
| `GROQ_API_KEY` | — | Credential for Groq models. |

Only the key matching your `LLM_MODEL`'s provider is required.

## Developer-only

| Variable | Read from | What it does |
| --- | --- | --- |
| `SPECFORGE_CORPUS_DIR` | shell | Opt-in gate for the pipeline test suite over the spec corpus; unset it and that suite skips. Only relevant when running Spec Forge's own tests. |
