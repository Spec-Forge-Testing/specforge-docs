# Environment Variables

Every environment variable Spec Forge reads, what it does, and where it is read from. Two
sources are used: your **shell** (the process environment) and, for the LLM settings only, the
**env file** `lib/llm/.env.local` (or the file `LLM_ENV_FILE` names). Where both carry the same
key, the shell wins.

## Interface and behaviour

| Variable | Read from | Default | What it does |
| --- | --- | --- | --- |
| `SPECFORGE_THEME` | shell | `default` | Selects the UI color theme at startup. Valid values: `default`, `mono`, `nord`, `dracula`, `solarized`, `matrix`. An unknown name falls back to `default`. You can also switch it live with the `theme` command. |
| `SPECFORGE_SYSTEM_COMMANDS` | shell | enabled | Controls the `!` shell-escape. Set it to a falsy value (`0`, `false`, `no`, `off`, case-insensitive) to disable running system commands from the REPL — useful in CI. Any other value, or unset, leaves it enabled. |
| `SPECFORGE_DATA_DIR` | shell | `<repo>/data` in a source checkout, otherwise the platform's user data directory | The data directory, where the database and the artifacts live unless the two variables below point elsewhere. |
| `CORETEST_DB_PATH` | shell | `coretest.db` in the data directory | Path to the SQLite database that stores projects, analyses and runs. Takes precedence over `SPECFORGE_DATA_DIR`. |
| `CORETEST_ARTIFACTS_ROOT` | shell | `artifacts/` in the data directory | Root folder for on-disk artifacts (reports and trace files). Takes precedence over `SPECFORGE_DATA_DIR`. |

See [where the data lives](../modules/storage/index.md#where-the-data-lives) for how the data directory is resolved.

## LLM configuration

These are read from the shell or the env file, the shell first. Only a run with the inference
producer needs them; fuzzing straight from the spec does not. The `llm.*` options of a project's
`specforge.toml` take precedence over both. See [LLM Providers](llm-providers.md) for the full
setup.

| Variable | Default | What it does |
| --- | --- | --- |
| `LLM_ENV_FILE` | — | Path of the env file to read instead of `lib/llm/.env.local`. Shell only: it is read once, when the LLM package is first imported. |
| `LLM_MODEL` | — | The model to use, in LiteLLM's `provider/model` form, e.g. `gemini/gemini-2.5-flash`. Required. |
| `LLM_FALLBACK_MODELS` | none | Comma-separated models tried in order if the primary fails. |
| `LLM_MAX_RETRIES` | `2` | How many times one model is retried before the next one is tried. |
| `LLM_TIMEOUT_SECONDS` | `30` | Timeout of one attempt, in seconds. |
| `LLM_RETRY_BACKOFF_BASE_SECONDS` | `0.5` | Base, in seconds, of the exponential wait between retries. |
| `LLM_CALL_BUDGET_SECONDS` | `120` | Total seconds one call may spend across its retries and fallbacks. Must be at least `LLM_TIMEOUT_SECONDS`. |
| `ANTHROPIC_API_KEY` | — | Credential for `anthropic/` models. |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — | Credential for `gemini/` models; either one serves. |
| `GOOGLE_API_KEY` | — | Credential for `vertex_ai/` models. |
| `OPENAI_API_KEY` | — | Credential for `openai/` models. |
| `MISTRAL_API_KEY` | — | Credential for `mistral/` models. |
| `GROQ_API_KEY` | — | Credential for `groq/` models. |

Every model of the chain needs its provider's key: `LLM_MODEL` and each model in
`LLM_FALLBACK_MODELS`. A missing key for any of them stops the run before any model is
called.

## Developer-only

| Variable | Read from | What it does |
| --- | --- | --- |
| `SPECFORGE_CORPUS_DIR` | shell | Opt-in gate for the pipeline test suite over the spec corpus; unset it and that suite skips. Only relevant when running Spec Forge's own tests. |
