# Spec Forge CLI

This page documents **`specforge-cli`**, the command-line tool shipped to end
users. It lives in its own repository and talks to the core only over the
JSON-RPC protocol (`specforge --serve`) — it declares no operation or flag of
its own; everything below is derived from the core's own `describe` catalog,
so a core upgrade that adds an operation or a parameter shows up here without
a CLI release.

!!! info "Not the core's own testing REPL"
    If you are working inside the `llm-pbt-agent` monorepo and run `specforge`
    there directly, you are using the **core's built-in REPL** instead — a
    different, Typer-style surface (`contract-assembly`, `trace`,
    `ast-extract`, …) used by the team to exercise the pipeline directly. That
    one is documented on the [CLI Reference](cli-reference.md) page. This page
    is about the client that ships to users of the packaged tool.

## Running it

```bash
specforge                       # the REPL: one core process, many operations
specforge <operation> [flags]   # one operation, then exit
```

With no arguments, `specforge` launches an interactive REPL against a freshly
started core: type an operation name, its flags, read the result, repeat.
With an operation name as the first argument, it starts the core, dispatches
exactly that one call, renders the result, and exits — no REPL, no prompt, no
state kept between invocations. This second form is what scripts and CI use.

The core command itself defaults to the published entry point (`specforge
--serve`); override it with `SPECFORGE_CORE_COMMAND` for a dev checkout that
has not installed that console script, e.g.:

```bash
export SPECFORGE_CORE_COMMAND="python -m specforge_core --serve"
```

| Variable | What it sets | Default |
| --- | --- | --- |
| `SPECFORGE_CORE_COMMAND` | The command that launches the core. | `specforge --serve` |
| `SPECFORGE_STARTUP_TIMEOUT` | Seconds to wait for the core's handshake. A cold start can take longer than the default; raise it rather than retrying. | `15` |
| `SPECFORGE_SYSTEM_COMMANDS` | Set to `0`, `false`, `no` or `off` (case-insensitive) to disable the REPL's `!` system-command escape. Anything else, or unset, leaves it enabled. | enabled |

Leaving the REPL (`exit`, Ctrl-D, or a closed terminal) cancels whatever is still
running and waits for the core to answer before closing, so a run cut short keeps
what it had produced.

## Two ways to write a call

**Inside the REPL**, a line is `<operation> [key=value ...]`:

```text
specforge ❯ open_project path=/home/dev/my-api
specforge ❯ fuzz base_url=http://localhost:8000 execution=stateful
```

Each value is parsed as JSON when it looks like JSON (`42`, `true`,
`{"a":1}`), and as a plain string otherwise — so quoting is only needed for a
string that happens to look like a number or a keyword.

A value with spaces goes in quotes right after the `=`. Double quotes are taken
literally, so a Windows path needs no escaping; single quotes are read like an
unquoted value, which is how a JSON object with spaces is quoted. An object or
array can also span spaces unquoted:

```text
specforge ❯ open_project path="C:\Users\Ana Perez\my-api"
specforge ❯ fuzz base_url=http://localhost:8000 load={"latency_sla_ms": 500}
```

**From your shell**, a flag is `--<name-with-dashes> <value>`, derived from the
same parameter name with underscores turned to dashes:

```bash
specforge fuzz --base-url http://localhost:8000 --execution stateful
```

A boolean parameter is a flag with no value, with an automatic negated form:
`--save` / `--no-save`. An `object`-typed parameter (`load`, `producer` on
`fuzz`/`run_pipeline`) takes one flag carrying a JSON literal, the same
convention the REPL uses for a line's own `key=value`:

```bash
specforge fuzz --base-url http://localhost:8000 \
  --producer '{"kind": "fixture", "contracts_dir": "contracts/"}'
```

A path flag you type in the shell is resolved against the directory you ran the
command from, including a path inside a JSON flag (`producer.source_repo`). The
core would otherwise read a relative path from the project root.

A required parameter you omit, an enum value outside the declared list, or an
integer outside its declared range is caught **before** the request reaches
the core, in both forms — the message names the parameter and, for an enum,
every admissible value. Everything else (does the project exist, is the
contract loaded) is the core's call alone; the CLI never second-guesses it.

## Interactive niceties

The REPL prompt completes as you type, in order: the operation name first, then
`<parameter>=` for one of that operation's parameters, then — for an `enum`
parameter — the admissible values after the `=`. All of it is derived from the
catalog, so a parameter the core adds later completes without a CLI release.

The REPL's history (`.specforge/shell_history`) never stores a credential in
plain text. A line that mentions `headers` (the option where an `Authorization`
header would go) is not written to the file at all, though the up arrow still
recalls it during the session. Any `user:pass@host` userinfo embedded in a URL
(e.g. a `base_url=` with inline credentials) is redacted to `user:***@host`.
Nothing is scrubbed from what the core itself logs or persists, and a secret
passed as a shell argument stays in your shell's own history: this only protects
the REPL's history file.

### System commands with `!`

Prefix a REPL line with `!` to run it as a system command without leaving the
session:

```text
SpecForge ❯ !git status
SpecForge ❯ !pytest -q
```

The escape is explicit on purpose: a line without `!` is always an operation call,
so a typo in an operation name never turns into an accidental system call. A `!`
line never reaches the core; the CLI runs it locally.

- **Streaming output.** `stdout` is shown as the command runs and `stderr` in the
  error colour, so a long command shows progress. A non-zero exit code is reported.
- **Working directory.** The command runs in the directory the CLI was started in.
  There is no `cd` built-in, and a `!cd` only affects its own short-lived process.
- **The prompt stays free.** The command runs off the prompt, like any operation,
  so you can keep typing while it runs.
- **Failures don't end the session.** A missing program, an unparsable line (such
  as an unbalanced quote) or a failing command is reported and the REPL carries on.
- **Disabling it.** Set `SPECFORGE_SYSTEM_COMMANDS=0` (or `false`, `no`, `off`) to
  turn the escape off, for example in a shared or non-interactive environment.
  `!` then answers that system commands are disabled.

A command is a single program run **without a shell**: no pipes, redirection or
shell built-ins such as `dir`, and no interactive programs (its stdin is closed, so
`vim` or `git rebase -i` will not work). The `!` escape exists only in the REPL; the
argv form (`specforge <operation> ...`) runs your shell's own commands anyway.

### Argv-only flags

These are never part of any operation — they describe how *you* want the call
run and its result delivered, so every operation accepts them alike and the
catalog never lists them:

| Flag | Effect |
| --- | --- |
| `--project PATH` | Opens the project at `PATH` before the operation. Needed by any operation that `requires` a project or a contract, since a one-shot call starts with nothing open. |
| `--contract PATH` | Loads the contract at `PATH` once the project is open, for a project that declares none. Needs `--project`. |
| `--yes` | Answers yes to confirmations up front. See [Asking before it matters](#asking-before-it-matters) for what it does not cover. |
| `--json-output` | The raw result as one JSON object on real stdout — no banner, no progress, no human render share that stream. A domain error renders to stderr as usual and stdout stays empty, so a script can always `> file.json` unconditionally. Long operations subscribe to no progress token at all in this mode. |
| `--ci` | No color (sets `NO_COLOR` before anything renders); exits `1` if the operation's own result carries findings (`fuzz`, `replay`, `run_pipeline`), if the operation itself failed, **or** if a run did not finish with status `completed` (`cancelled`, `failed`, `safety_breached`, or a report with no status). Exits `0` on a clean run. Combine with `--json-output` to get a script-friendly result and a pipeline-friendly exit code at once. |
| `--junit-xml PATH` | Also writes the result as JUnit XML at `PATH`, alongside whatever else rendered — one `<testsuite>` per endpoint, one `<testcase>` per defect (or a single passing one if the endpoint had none). Only `fuzz`/`replay`/`run_pipeline` results produce anything; anything else writes an empty `<testsuites/>`. |

```bash
specforge fuzz --project ./my-api --contract ./my-api/openapi.yaml \
  --base-url http://localhost:8000 --ci --junit-xml report.xml
echo $?   # 1 if fuzz found anything, or if it didn't complete
```

With no arguments at all, `specforge` opens the REPL regardless of any of
these — they only apply once an operation name is given.

Ctrl-C during a one-shot call asks the core to cancel and still prints what the
run had produced; a second Ctrl-C stops waiting.

## Asking before it matters

Some calls stop to ask first. In the REPL the question is asked with `approve`.

| What | When it asks | Answering up front |
| --- | --- | --- |
| Destructive operations (`apply_fix_plan`, `apply_prune_plan`) | Before they are sent. | `--yes` |
| A run that would pay for LLM inference | The core refuses and returns its estimate (contracts to infer, tokens, cost). The CLI shows it, asks, and resends with the approval token. | `--yes`, but only with `producer.max_cost_usd` set; without a cap it stops with exit `2`. |
| A replay that could change the target | The CLI explains why (recorded with side effects, or its run reached routes the safety guard held back) and asks. | `--allow-side-effects`. `--yes` does not cover it, and `--no-allow-side-effects` is never overridden. |

In the REPL, a call that needs approval shows its estimate or reason and waits:
type `approve` to ask and resend it, or carry on with any other line to drop it.

`--json-output`, `--ci` and a call with no terminal never wait for an answer:
without `--yes` they stop with exit `2`, and in `--json-output` mode the estimate
goes to stderr so stdout stays clean. Git Bash (mintty) does not present itself
to Python as a terminal, so there a one-shot call never asks: use PowerShell or
`winpty`, or pass `--yes`.

## Exit codes (argv form)

| Code | Meaning |
| --- | --- |
| `0` | The operation completed, and (under `--ci`) found nothing. |
| `1` | A domain or protocol error, a confirmation you answered no to (or an estimate that kept changing), or (under `--ci` only) a finding or a run that did not complete. |
| `2` | A usage error caught before the request was sent: an unknown operation, a missing required flag (`--project` included), a value outside an enum, JSON that failed to parse, or a confirmation nobody could give. |
| `130` | Interrupted with Ctrl-C (also with `--ci`), or ended by `SIGTERM`/`SIGHUP` (`128` plus the signal number). |

## Operations

`describe` publishes 32 operations across eight families. `requires` says
what must already be true for the call to succeed: `none`, `project` (a
project must be open — see [`open_project`](#open_project)), `contract` (a
contract must also be loaded — see [`load_contract`](#load_contract), which
implies a project) or `analysis` (an [`analyze_endpoints`](#analyze_endpoints)
run earlier in the same session, which implies a contract). A one-shot call
cannot have an earlier call, so the operations that require an analysis are
refused before anything is sent: use the REPL for them. The full `requires`/events summary, independent of the
CLI, lives in [Operations](../modules/core/protocol/operations.md); the
values an operation's result can take (`run.status`, `comparability`, replay
verdicts, …) are enumerated once in
[Result vocabularies](../modules/core/protocol/vocabularies.md); every error
code the core can answer with is in [Errors](../modules/core/protocol/errors.md).
This section adds what those pages don't: every flag, its default, and a
worked example.

### Session

#### `open_project`

Opens a project, or switches the active one to it, and returns its whole
state — root, contract (loaded or explaining why not), and whatever the
store already holds for it.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--path` | path | yes | — |

```text
specforge ❯ open_project path=/home/dev/my-api

root: /home/dev/my-api
contract: not loaded
```

A project with no `specforge.toml` opens with no contract loaded (`contract:
not loaded` above is honest, not an error) — load one explicitly with
[`load_contract`](#load_contract).

#### `project_state`

The active project's state, without re-opening anything. Same shape and view
as `open_project`. No parameters. Requires a project.

#### `close_project`

Closes the active project and releases everything it held. No parameters, no
result.

#### `init_project`

Creates a project's `.specforge` data directory and its `specforge.toml`
**without** opening it — use this to scaffold a project ahead of time, then
`open_project` it later (or let a later `open_project` read the `.toml` it
wrote).

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--path` | path | no | the current directory |
| `--overwrite` / `--no-overwrite` | boolean | no | `false` |
| `--name` | string | no | the directory's name |
| `--openapi-spec` | path | no | the first of `openapi.yaml`, `openapi.yml`, `openapi.json` found, else `openapi.yaml` |
| `--base-url` | string | no | `http://localhost:8000` |

Giving `--name`, `--openapi-spec` or `--base-url` for a project whose
`specforge.toml` already exists needs `--overwrite`.

### Contract

#### `load_contract`

Parses an OpenAPI/Swagger spec and makes it the active contract, returning
its summary. This is what an `open_project` with no `specforge.toml` (or a
`.toml` with no `spec_path`) is missing.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--path` | path | no | the project's own configured `spec_path` |

```text
specforge ❯ load_contract path=/home/dev/my-api/openapi.yaml
load_contract: starting
  ✓  load_contract: completed
  ✓  {'path': '/home/dev/my-api/openapi.yaml', 'title': 'My API',
     'version': '0.1.0', 'openapi_version': '3.0.3', 'endpoint_count': 2,
     'deviations': []}
```

Emits progress (`started`/`finished`); see
[Events and cancellation](../modules/core/protocol/events.md).

#### `get_contract`

The active contract's summary, without parsing anything again. No
parameters. Requires a contract.

#### `list_endpoints`

The contract's endpoints, narrowed by whichever filters are given. With no
flags, every endpoint.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--path` | string | no | — |
| `--method` | string | no | — |
| `--operation-id` | string | no | — |

```bash
specforge list_endpoints --method GET --json-output
```

#### `get_endpoint`

Everything the document declares about one endpoint.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--reference` | endpoint reference | yes | — |

A reference is either the endpoint's stable number (from `list_endpoints` or
an earlier `analyze_endpoints`, e.g. `1`) or its canonical id
(`"GET:/accounts/{id}"`).

### Analysis

#### `analyze_endpoints`

Traces the selected endpoints with static analysis and keeps the result as
the current analysis — the AST pass that locates each handler and extracts
its dependency chain, with no LLM involved.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--path` | string | no | — |
| `--method` | string | no | — |
| `--operation-id` | string | no | — |
| `--repo-root` | path | no | the project's own root |

```text
specforge ❯ analyze_endpoints
analyze_endpoints: starting — 2 endpoints
GET:/accounts/{id}: resolved
POST:/transfer: resolved
2 resolved · 0 failed · 0.2s elapsed
  ✓  analyze_endpoints: completed
```

Emits progress and is cancellable (`Ctrl-C` in the REPL; never subscribed to
under `--json-output` — see [Argv-only flags](#argv-only-flags)).

#### `get_static_analysis`

The current analysis, without tracing anything again. No parameters.
Requires an analysis.

#### `get_endpoint_static_analysis`

The handler's code, its dependency chain and its metrics, for one endpoint.
Requires an analysis.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--reference` | endpoint reference | yes | — |

#### `get_llm_payload`

The endpoint's XML context the inference pipeline would send an LLM — inline
when it fits the handshake's declared `inline_max_bytes`, written to disk and
named otherwise (always, if `--destination` is given). Requires an analysis.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--reference` | endpoint reference | yes | — |
| `--destination` | path | no | inline unless the payload is too large |

### Execution

#### `fuzz`

Fuzzes the active project's API and returns the run's report. Requires a
contract; needs a target to send requests to (the project's own configured
`base_url`, or `--base-url` to override it for this run only).

| Flag | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `--target` | endpoint reference | no | every endpoint | One exact endpoint, by number or canonical id |
| `--endpoint` | string | no | — | A path filter; without `--method`, every operation on that path |
| `--method` | string | no | — | |
| `--base-url` | string | no | the project's configured target | Overrides it for this run only |
| `--timeout-s` | number | no | — | |
| `--max-concurrency` | integer | no | — | |
| `--deadline-ms` | integer | no | — | Per-endpoint time budget; past it the engine truncates with `deadline_exceeded` |
| `--identities-path` | path | no | — | |
| `--execution` | enum: `stateless`, `stateful`, `performance`, `resilience`, `auth` | no | `stateless` | |
| `--strategy` | enum: `default`, `hacker` | no | `default` | |
| `--load` | object | no | — | `{latency_sla_ms, concurrency_steps[], degradation_tolerance}` |
| `--allow-side-effects` / `--no-allow-side-effects` | boolean | no | `false` | Lifts the guard that holds back probes on endpoints the contract marks as writing |
| `--producer` | object | no | schema-only | `{kind: "fixture"|"inference", contracts_dir, source_repo, refresh, approval_token, max_cost_usd}`; the last three are for `inference` only |
| `--save` / `--no-save` | boolean | no | `true` | |
| `--project-name` | string | no | — | Overrides the name the run is stored under |

```text
specforge ❯ fuzz base_url=http://localhost:8000 target=1
fuzz: starting
GET:/accounts/{id} (1/1)
GET:/accounts/{id}: phase valid
20/200 sent · 0 findings · 0.4s elapsed
GET:/accounts/{id}: phase boundary
GET:/accounts/{id}: phase invalid
  ⚠  GET:/accounts/{id}: status_code_conformance (status 422)
  ✓  fuzz: completed
```

The non-interactive, CI-friendly form:

```bash
specforge fuzz --base-url http://localhost:8000 --execution stateful --ci --junit-xml report.xml
```

Emits progress and is cancellable. See
[Execution modes](../modules/specforge-engine/execution-modes.md) for what
each `--execution` value actually does, and
[Run Report](reports.md) for the document's full shape.

A run with `kind: "inference"` pays for LLM calls, so it asks first; see
[Asking before it matters](#asking-before-it-matters).

#### `estimate_inference`

What inferring the selected endpoints' contracts would cost, without calling
any model. Takes the same selection flags as `fuzz` (`--target`, `--endpoint`,
`--method`, `--strategy`) and a required `--producer` of `kind: "inference"`.
Requires a contract.

```bash
specforge estimate_inference --project ./my-api --contract ./my-api/openapi.yaml \
  --producer '{"kind": "inference", "source_repo": "./my-api"}'
```

#### `replay`

Re-sends an analysis's recorded recipe and rules on the defects it found —
the verbatim requests, not a fresh generation.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--analysis-id` | integer | yes | — |
| `--preserve-timing` / `--no-preserve-timing` | boolean | no | `true` |
| `--identities-path` | path | no | — |
| `--base-url` | string | no | the recorded target | Restores credentials the recipe never persisted — does **not** retarget |
| `--allow-side-effects` / `--no-allow-side-effects` | boolean | no | `false` | Consent to re-send a recording made with side effects allowed, or one whose run reached routes the safety guard held back |
| `--save` / `--no-save` | boolean | no | `true` |

Emits progress and is cancellable. Requires a project (not a contract — the
analysis already carries its own recorded shape).

#### `run_pipeline`

Contract, static analysis, enrichment, execution and persistence, in one
call. Unlike its stages called alone, it never bounces on an empty
session — a missing project or contract just fails the first stage of the
report, instead of refusing the whole call up front.

Takes the union of `fuzz`'s flags, plus:

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--analyze` / `--no-analyze` | boolean | no | `true` |
| `--repo-root` | path | no | `producer.source_repo` if given, else the project root |

```bash
specforge run_pipeline --base-url http://localhost:8000 \
  --producer '{"kind": "inference", "source_repo": "/home/dev/my-api"}'
```

`--producer kind=inference` needs an LLM provider key configured (see
[LLM Providers](llm-providers.md)) — without one it fails with a dependency
error naming what's missing, same as `doctor` would report it.

Emits progress, framed per stage
(`stage_started`/`stage_finished` over `contract` / `static_analysis` /
`inference` / `execution`); is cancellable. Requires nothing to be open —
it's the one operation designed to run cold.

### Results

All nine results operations resolve by id against the central store, so none
of them are limited to the currently open project.

#### `list_projects`

Every project the store knows, with its analysis count. No parameters.

#### `list_analyses`

A project's analyses, each saying whether its recipe can still be replayed.

| Flag | Type | Required |
| --- | --- | --- |
| `--project-id` | integer | yes |

#### `get_analysis`

One analysis by id — the recipe a replay names.

| Flag | Type | Required |
| --- | --- | --- |
| `--analysis-id` | integer | yes |

#### `list_runs`

An analysis's runs, each row already saying whether to trust its evidence.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--analysis-id` | integer | yes | — |
| `--status` | string | no | — |
| `--since` | date | no | — |
| `--endpoint-path` | string | no | — |
| `--limit` | integer | no | — |

#### `get_run`

Everything one run recorded, with its findings paged.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--run-id` | integer | yes | — |
| `--findings` | object | no | first page | `{offset, limit}` |

Emits progress (`started`/`finished` — reading a large run's findings is not
instant).

#### `get_finding`

One finding, tagged as the crash or the unconfirmed finding it is.

| Flag | Type | Required |
| --- | --- | --- |
| `--finding-id` | integer | yes |

#### `compare_runs`

What changed between two runs' defects, by reference rather than by payload.
The two runs may belong to different projects.

| Flag | Type | Required |
| --- | --- | --- |
| `--before-id` | integer | yes |
| `--after-id` | integer | yes |

See [Result vocabularies](../modules/core/protocol/vocabularies.md#caveats)
for what makes a pairing `new` / `persisted` / `possibly resolved` /
`inconclusive`, and for `comparability` in general.

#### `prune_runs`

Plans a retention pass over the whole central store. **Nothing is deleted,
compressed or collected by this call** — it only proposes a plan; see
[`apply_prune_plan`](#apply_prune_plan).

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--keep-last` | integer | no | — |
| `--older-than` | date | no | — |
| `--max-size-mb` | integer | no | — |
| `--compress` / `--no-compress` | boolean | no | `false` |
| `--include-traces` / `--no-include-traces` | boolean | no | `false` |
| `--collect-orphans` / `--no-collect-orphans` | boolean | no | `false` |

#### `apply_prune_plan`

Applies the retention pass a client already saw proposed by `prune_runs` —
same flags, plus the plan it commits to:

| Flag | Type | Required |
| --- | --- | --- |
| `--plan-token` | string | yes |

A stale plan (the store changed since `prune_runs` proposed it) is refused
rather than applied against data it never saw. Destructive: it asks for
confirmation before it is sent.

### Config

#### `get_config`

Every option's effective value, and which layer it came from.

| Flag | Type | Required |
| --- | --- | --- |
| `--overrides` | object | no |

#### `set_config`

Fixes values in the user's own config layer, and answers with the whole
configuration. Requires a project.

| Flag | Type | Required |
| --- | --- | --- |
| `--values` | object | yes |

#### `reset_config`

Returns options to their defaults, by key or all of them. Requires a project.

| Flag | Type | Required |
| --- | --- | --- |
| `--keys` | string, repeated | no — all keys if omitted |

```bash
specforge reset_config --keys base_url --keys timeout_s
```

### Environment

#### `diagnose`

Probes the environment and reports what's missing, with concrete ways to fix
it — Python/CLI runtime, each pipeline module (probed by import, never
executed), the test runtime, and LLM provider configuration. No parameters.
Emits progress.

#### `apply_fix_plan`

Applies the remedies `diagnose` proposed, for the named components only —
never arbitrary input, and never a remedy you didn't ask for.

| Flag | Type | Required |
| --- | --- | --- |
| `--components` | string, repeated | yes |

Emits progress (each install streams as it runs). Destructive: it asks for
confirmation before it is sent.

### Catalog

#### `describe`

Every operation the core exposes, every event it emits, every code it can
fail with — the document this whole page is derived from. No parameters.

#### `describe_operations`

Just the operations, for a caller that wants nothing else (no event or error
catalog). No parameters.

## Errors

A rejection always renders to stderr with the domain code and the core's own
message (never swallowed, never re-worded by the CLI), and argv exits `1`.
The full registry — every code `describe` publishes, what triggers each one —
is in [Errors](../modules/core/protocol/errors.md). Two worth knowing up
front because they're the ones a fresh session hits first:

- **`NO_ACTIVE_PROJECT`** — an operation that `requires: project` or
  `requires: contract` was called with none open. `open_project` first.
- **`NO_CONTRACT_LOADED`** — a project is open, but it has no `specforge.toml`
  with a `spec_path` (or none was ever loaded). `load_contract --path
  <spec>` first.

## See also

- [Run Report](reports.md) — the full shape of what `fuzz`/`replay`/
  `run_pipeline` answer with, and the `report.json`/`report.html` artifacts a
  saved run leaves.
- [Example Walkthrough](example-walkthrough.md) — a self-contained demo API
  to try every operation above against, end to end.
- [Operations](../modules/core/protocol/operations.md),
  [Events and cancellation](../modules/core/protocol/events.md),
  [Result vocabularies](../modules/core/protocol/vocabularies.md) — the
  protocol-level reference this page's flag tables are derived from.
