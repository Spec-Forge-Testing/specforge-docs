# Core — Configuration

The core's behaviour that a user may tune lives in a closed set of **options**,
each one owned by a subsystem: the engine that sends a run's requests, the LLM
chain an inference asks, the inference producer, how a replay finds, reads and
rebuilds the API under test, how an applied fix is built, and the paths the
session works under. Every option has a default in code; a project may fix its own value in its
`specforge.toml`. Three operations read and write them: `get_config`,
`set_config` and `reset_config` (see [Operations](protocol/operations.md#config)).
This page lists the options, how their layers combine, how a run reads them, and
how a value is checked.

## The options

The table is the whole set; there is no option outside it. A key is
`<group>.<name>`, and the group is also the section of `specforge.toml` the value
is kept under.

| Key | Type | Default | Range | What it decides |
| --- | --- | --- | --- | --- |
| `engine.timeout_s` | number | `10.0` | `> 0`, finite | How long one request may take before it counts as a timeout. |
| `engine.max_concurrency` | integer | `20` | `≥ 1` | How many requests may be in flight at once. |
| `engine.max_retries` | integer | `3` | `≥ 0` | How many times a request is retried before the endpoint gives up. |
| `engine.backoff_base` | number | `1.0` | `≥ 0`, finite | The base, in seconds, of the exponential wait between retries. |
| `engine.headers` | string map | `{}` | no credential header | Headers added to every request of a run. |
| `llm.primary_model` | string | none (required) | — | The model an inference asks first. |
| `llm.fallback_models` | string list | `[]` | — | Models tried, in order, when the primary one fails. |
| `llm.max_retries` | integer | `2` | — | How many times one model is retried before the next one is tried. |
| `llm.timeout_seconds` | number | `30.0` | — | How long one completion may take. |
| `llm.call_budget_seconds` | number | `120.0` | — | How long one LLM call may take across its retries and fallbacks. |
| `llm.retry_backoff_base_seconds` | number | `0.5` | — | The base, in seconds, of the exponential wait between LLM retries. |
| `inference.require_approval` | boolean | `true` | — | Refuse an inference run with calls to pay for until it carries an approved estimate's token. |
| `inference.max_workers` | integer | `4` | `1` to `16` | How many contracts a run produces at once; `1` produces them one after the other. |
| `replay.log_container` | string | none | — | The Docker container whose log `replay_finding` reads while the finding's request is in flight, when it is not the container publishing the API's port. |
| `replay.log_file` | string | none | — | The file the API under test writes its log to, relative to the project root, for a service run without Docker; `replay_finding` reads what it wrote while the request was in flight. |
| `replay.rebuild_command` | string | none | — | The command, run from the project root, that builds and starts the API under test again before a replay asked to `rebuild`. Without it, a service Docker Compose started is rebuilt with Compose. |
| `replay.hot_reload` | boolean | none | — | Whether the API under test reloads changed code without restarting. Unset, it is told from the command the service runs (`--reload`, `nodemon`, `watch` and the like). |
| `replay.rebuild_timeout_s` | number | `300.0` | `> 0`, finite | How long rebuilding the API under test may take before it is stopped (`REBUILD_FAILED`, `timed_out`). |
| `replay.ready_timeout_s` | number | `60.0` | `> 0`, finite | How long a rebuilt API under test may take to answer again (`REBUILD_FAILED`, `not_ready`). |
| `fix.check_command` | string | none | — | The command, run from the project root, that builds the project when `verify_finding_fix` verifies an applied fix without rebuilding the service. Without it, the toolchain the manifest nearest the edited file names is used. |
| `fix.check_timeout_s` | number | `120.0` | `> 0`, finite | How long building an applied fix on this machine may take; past it the build is skipped, the fix kept and the finding replayed. |
| `paths.data_dir` | path | — | read-only | The open project's own Spec Forge directory, `.specforge` under its root. |
| `paths.db_path` | path | — | read-only | The database the session reads and writes. |
| `paths.artifacts_root` | path | — | read-only | The root every stored artifact path is under. |
| `paths.llm_env_file` | path | — | read-only | The `.env.local` this process's LLM layer reads: `LLM_ENV_FILE` when set, else `lib/llm/.env.local` in a source checkout, else `<user config dir>/spec-forge/.env.local` in a frozen build. It comes back with no project open. |

`llm.primary_model` has no default on purpose: there is no sensible one, and a
guess would spend money on a model nobody chose. A `string list` accepts a JSON
list or one comma-separated string. Integers refuse a fraction and a boolean;
numbers refuse a boolean.

The `llm.*` ranges are the LLM package's own, checked when a run builds its
settings rather than when the value is written: `max_retries` at least `0`,
`timeout_seconds` above `0`, `retry_backoff_base_seconds` at least `0`, and
`call_budget_seconds` above `0` and at least `timeout_seconds`. A value that breaks one fails the run's producer with
`CONTRACT_PRODUCER_FAILED` before any model is called (see
[LLM › Settings and the model chain](../llm/reference.md#settings-and-the-model-chain)).

### What a `get_config` row carries

Each of the three operations answers with the whole configuration, one row per
option:

| Field | Meaning |
| --- | --- |
| `key`, `group`, `type` | The option, its subsystem (`engine`, `llm`, `inference`, `replay`, `fix`, `paths`) and its value type. |
| `value` | The effective value. |
| `layer` | Which layer that value came from (below). |
| `default` | What the value would be with nothing set. |
| `writable` | `false` for the `paths.*` options. |
| `required` | `true` for an option with no default that must be set before it is used. |
| `minimum`, `maximum` | The inclusive bounds of a whole-number option; `null` where it has none. |
| `help` | One line on what the option decides. |

## Layers and precedence

An option's value is folded through four layers; the highest one that holds a
value wins.

| `layer` | Where the value lives | Lifetime |
| --- | --- | --- |
| `run` | The `overrides` passed to `get_config`. | That one answer; never persisted. |
| `user` | The project's `specforge.toml`, under `[engine]`, `[llm]`, `[inference]`, `[replay]` and `[fix]`. | Until `set_config` or `reset_config` changes it. |
| `environment` | The process environment, else the LLM's `.env.local`: only `llm.primary_model`, from `LLM_MODEL`. An empty variable fills nothing. | Read on every call. |
| `default` | The code. | Always present. |

The `environment` layer is not the user's choice: `reset_config` has nothing to
undo for it, and inference is not handed it as an override, since the LLM layer
already reads the same variable.

`set_config` writes into the user layer, and only rewrites those five sections:
anything else in `specforge.toml` (the project's name, spec and base URL) is left
as written. A key the file carries that is not an option is ignored. Without an
open project there is no user layer, so `get_config` answers with the defaults
and any `overrides`, and the `paths.*` values but `paths.llm_env_file` are `null`.

The `paths.*` values never come from a file. `paths.data_dir` is the open
project's own directory (its `.specforge`), `paths.db_path` the store the session
opened, and `paths.artifacts_root` the root storage reports. The store and the
artifacts do not live under the project: they sit in storage's data directory,
`SPECFORGE_DATA_DIR` or, without it, `data/` of the checkout; see
[Storage › Where the data lives](../storage/index.md#where-the-data-lives).
Writing a read-only key is refused `CONFIG_READ_ONLY`: moving the store in a live
session is a migration, not an adjustment.

## How a run reads the configuration

A run resolves the project's configuration once, before anything is produced or
sent.

| Option | `fuzz` and `run_pipeline` | `replay` |
| --- | --- | --- |
| `engine.timeout_s`, `engine.max_concurrency` | the request's own `timeout_s` / `max_concurrency` when given, else `specforge.toml`, else the default | the values the original run recorded |
| `engine.max_retries`, `engine.backoff_base` | `specforge.toml`, else the default | the values the original run recorded |
| `engine.headers` | `specforge.toml`, else none; sent on every request, recorded by name only | re-read from the project the replay runs in |
| `llm.*` | only the keys `specforge.toml` sets, passed over the environment | not read |
| `inference.require_approval` | `specforge.toml`, else `true` | not read |
| `inference.max_workers` | `specforge.toml`, else `4`; read only by a run with a producer | not read |
| `replay.*`, `fix.*` | not read | not read; `replay_finding`, `inspect_service` and `verify_finding_fix` read them from `specforge.toml`, else the default |

A recording keeps the names of the headers it sent, never their values, so a
replay takes the values from `engine.headers` where it runs, as it re-reads the
identities file. `estimate_inference` reads the `llm.*` options and
`inference.require_approval` the way a run does, so an estimate prices the model
the run would ask.

`inference.require_approval` is strict: anything but an explicit `false` requires
approval, so a doubtful value never spends. `inference.max_workers` out of range
is refused, never clamped.

### The `[llm]` section over the environment

The LLM package reads its settings from the process environment and its env file
(see [Environment Variables](../../user-guide/environment.md#llm-configuration)).
A project's `[llm]` values take precedence over both, key by key, for that
project's inference runs only:

| Option | Overrides |
| --- | --- |
| `llm.primary_model` | `LLM_MODEL` |
| `llm.fallback_models` | `LLM_FALLBACK_MODELS` |
| `llm.max_retries` | `LLM_MAX_RETRIES` |
| `llm.timeout_seconds` | `LLM_TIMEOUT_SECONDS` |
| `llm.call_budget_seconds` | `LLM_CALL_BUDGET_SECONDS` |
| `llm.retry_backoff_base_seconds` | `LLM_RETRY_BACKOFF_BASE_SECONDS` |

A key left at its default is not passed, so the environment fills it. The
provider keys are never options: they stay in the environment.

## Validation

The user layer is held to the same rules as a value that arrives in a request.
`get_config`, `set_config`, `fuzz`, `run_pipeline` and `replay` all read the
file, and each refuses a value of the wrong type or outside its range with
`INVALID_PARAMS`:

| `data` field | Meaning |
| --- | --- |
| `key` | The option whose value is refused. |
| `expected` | Its type. |
| `reason` | Why the value does not fit, e.g. `expected 1 to 16, got 32`. |
| `source` | `"specforge.toml"` when the value came from the file; absent when it came from the call. |

See [`INVALID_PARAMS` from configuration](protocol/errors.md#config-invalid-params).
An unknown key is refused `UNKNOWN_CONFIG_KEY`, whose `data.known` lists every
option.

### Setting, repairing and resetting

- `set_config` takes a map of keys to values, checks each one, merges them into
  the file and checks the merged result before writing it. A value of `null` is
  refused: clearing a key is `reset_config`'s job.
- Because the merged file is checked, a bad value already in `specforge.toml`
  makes every `set_config` fail on that key until it is fixed. Setting that key
  to a valid value repairs it in the same call.
- `reset_config` drops keys from the user layer, by name or all of them, and
  never checks what remains: it is the way out of a file that no other call can
  read.

## Credential headers are refused

`engine.headers` is for headers every request needs and anybody may read, such
as a tenant or a tracing header. A header that carries a credential is refused,
classified by its name and never by its value, without regard to case:

| Refused | Names |
| --- | --- |
| Exact | `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` |
| Containing | `api-key`, `apikey`, `token`, `secret` |

The refusal is `INVALID_PARAMS` with `data.key` `engine.headers` and a
`data.reason` naming the header. It applies on `set_config` and whenever the file
is read. Credentials belong in the identities file a run names with
`identities_path`: it is resolved against the project root, its values never come
back in any answer, and the credential values a run sends are redacted from the
findings it keeps.

## Where to change what

| To | Change |
| --- | --- |
| Add an option | an `OptionSpec` in `services/config/definitions.py`, in its group's tuple; it appears in `get_config` on its own |
| Give an option a rule beyond its type | the spec's `check`, a function raising `ValueError` with the reason |
| Bound a whole-number option | the spec's `minimum` / `maximum`; they are published on its row |
| Make a run read an option | `services/config/runtime.py`, which turns a resolved configuration into run settings |
| Change which header names count as credentials | `services/config/credentials.py` |
