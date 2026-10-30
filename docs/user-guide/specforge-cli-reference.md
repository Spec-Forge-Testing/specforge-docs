# CLI operation reference

This is the operation-level reference for the packaged `specforge-cli`. It describes the flags and rendering added by the client; the protocol-level requirements, events and error registry remain in the [Core protocol reference](../modules/core/protocol/index.md).

## Operations

`describe` publishes the operations in the core's own families, and this reference follows
them (`help` groups them differently, as described in [Interactive use](cli/interactive.md#finding-a-command-with-help)). `requires` says
what must already be true for the call to succeed: `none`, `project` (a
project must be open — see [`open_project`](#open_project)), `contract` (a
contract must also be loaded — see [`load_contract`](#load_contract), which
implies a project) or `analysis` (an [`analyze_endpoints`](#analyze_endpoints)
run earlier in the same session, which implies a contract). A one-shot call
cannot have an earlier call, so the operations that require an analysis are
refused before anything is sent: use the interactive session for them. The full `requires`/events summary, independent of the
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
store already holds for it. It is drawn as a card: what the project is, what
it still lacks, and what to do next.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--path` | path | yes | — |

```text
specforge ❯ open_project path=/home/dev/my-api

name: my-api
folder: /home/dev/my-api
contract: My API v1.2.0 · 14 endpoints
target: http://localhost:8000
model: openai/gpt-5-nano
history: 2 analyses · 5 runs
last run: run #12 completed · 2 problems · 2026-10-27 14:42

  → fuzz · get_run run_id=12
```

| Line | What it says |
| --- | --- |
| `name` | The name `specforge.toml` declares; left out when there is none. |
| `folder` | The project's root, whole. |
| `contract` | Title, version and size of the contract, or `not loaded` with the reason. |
| `target` | The `base_url` the project declares, or `not set`. |
| `model` | The model inference asks first, or `not chosen`. Left out when the core could not be asked. |
| `history` | The analyses and runs the store holds for the project. Left out when it holds none. |
| `last run` | Id, status, confirmed problems and time of the latest run. The problems are counted as `get_run` counts them, so both say the same number. Left out when there is none; the count alone is left out when the run could not be read. |

What the project lacks is shown in yellow, and the line under the card names
the call that fills it, in the order to give them: `load_contract` (or
`generate_contract`) for a missing contract, `update_project base_url=<url>`
for a missing target, `analyze_endpoints` for a project never analyzed, and
`model` when no model is chosen. Once nothing is missing the step is `fuzz`.

A project with no `specforge.toml` opens with no contract loaded (`contract:
not loaded` is honest, not an error) — load one explicitly with
[`load_contract`](#load_contract).

The model and the latest run are not part of the core's answer: the CLI asks
for them right after it (`get_config`, and `list_analyses`, `list_runs` and `get_run`
when the store holds runs). If any of those fails, the card is drawn without
that line. `--json-output` prints the core's answer as it came, without them.

#### `project_state`

The active project's state, without re-opening anything. Same shape and view
as `open_project`, the card included. No parameters. Requires a project.

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

#### `update_project`

Updates the active project's `name`, `openapi_spec` or `base_url` in
`specforge.toml`, then reloads the project and its contract. Only the values
provided are changed; the remaining project settings and comments are kept.

The operation is refused while another operation is running.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--name` | string | no | — |
| `--openapi-spec` | path | no | — |
| `--base-url` | string | no | — |

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

Emits progress and is cancellable (`Ctrl-C` in the interactive session; never subscribed to
under `--json-output` — see [Scripts and CI](cli/scripts-and-ci.md)).

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
| `--strategy` | enum: `default`, `security`, `conformance`, `smoke`, `exposure` | no | `default` | What the run generates and which extra checks judge it ([strategies](../modules/core/protocol/vocabularies.md#strategy)) |
| `--examples-per-endpoint` | integer | no | the strategy's default, under the mode's cap | At least 1; refused for the `performance` ladder, `auth` and `resilience` ([examples per endpoint](../modules/core/protocol/fuzz-options.md#examples-per-endpoint)) |
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
20 sent · 0 with problems · 0.4s elapsed
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
[Scripts and CI](cli/scripts-and-ci.md#approvals-and-cost-estimates).

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

These resolve by id against the central store, so none of them is limited to the currently
open project — except the ones that ask a model about a finding, or write its fix, which say
they need one: they read the code the finding's run traced.

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

An analysis's runs, each row already saying whether to trust its evidence. `Findings` counts
the distinct findings the run kept, and says how many were confirmed when that is not all of
them (a run cut short leaves some unverified). It counts findings, not problems: a listing
cannot group them, and a problem may stand on several findings (the same rule broken at the
same endpoint, in different phases), so `get_run` can show fewer problems than this column
shows findings.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--analysis-id` | integer | yes | — |
| `--status` | string | no | — |
| `--since` | date | no | — |
| `--endpoint-path` | string | no | — |
| `--limit` | integer | no | — |

#### `get_run`

Everything one run recorded, with its findings paged. It is drawn like a fresh report (see
[Run Report](reports.md)), plus the files the run left on disk.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--run-id` | integer | yes | — |
| `--findings` | object | no | first page | `{offset, limit}` |

Emits progress (`started`/`finished` — reading a large run's findings is not
instant).

#### `get_finding`

One finding, tagged as the crash or the unconfirmed finding it is. A confirmed one shows the
rule it broke, the request that did it, what came back and an approximate `curl` to repeat it;
one that never confirmed keeps no request and shows only the shape of the response.

The `×N` in the title is how many requests this finding stands for. When its problem gathers
several findings (the same rule broken at the same endpoint, in different phases), the title
also gives the problem's total, `×116 of the problem's ×150`, the number `get_run` lists for it.
The CLI reads that total from the finding's run, so it is left out when the run cannot be read.

| Flag | Type | Required |
| --- | --- | --- |
| `--finding-id` | integer | yes |

#### `estimate_finding_explanation`

What explaining a finding would cost, without sending anything. `source` says how it would be
explained: `template` and `cache` are free, `model` is priced and carries the `approval_token`
[`explain_finding`](#explain_finding) takes. Needs an open project.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--finding-id` | integer | yes | — |
| `--include-code` | boolean | no | `false` |
| `--refresh` | boolean | no | `false` |

`--include-code` prices the explanation with the handler's code in the prompt; `--refresh` prices
a new one even when one is already stored.

#### `explain_finding`

A finding in plain language, kept as the finding's current explanation: what happened, the
probable cause, a suggested fix and the lines of code it points at. A finding about the
contract's own hygiene gets a fixed text for free, and an equivalent finding already explained
is reused for free; otherwise a model is asked. An explanation is a model's reading of the
evidence, not something the run measured, and the view says so.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--finding-id` | integer | yes | — |
| `--include-code` | boolean | no | `false` |
| `--approval-token` | string | no | — |
| `--refresh` | boolean | no | `false` |

With `inference.require_approval` on (the default), asking a model needs the token of the
estimate that priced exactly this call; without it the core refuses with
`INFERENCE_APPROVAL_REQUIRED` and the estimate. Needs an open project. Emits progress and is
cancellable. A code reference to code the model was not shown is dropped, and lowers the
confidence the view reports.

#### `estimate_finding_fix`

What proposing a fix for a finding would cost, without sending anything to a model.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--finding-id` | integer | yes | — |
| `--refresh` | boolean | no | `false` |

`source` says where the fix would come from: `cache` is an equivalent finding's fix, already
paid for and free; `model` is priced and carries the `approval_token` [`propose_fix`](#propose_fix)
takes. It needs the handler's code behind the finding, so a finding whose run traced no code
answers `STATIC_ANALYSIS_REQUIRED` here, before anything is spent. Needs an open project.

#### `propose_fix`

A fix for a finding, as a unified diff — **never applied**. The model reads the finding's
evidence (with the credentials redacted) and its handler's code, and answers edits that are
checked before they become the diff: an edit whose search text does not occur exactly once in
its file, or that touches a file the model was not shown, is left out and listed with its reason.
The result is kept as the finding's current fix.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--finding-id` | integer | yes | — |
| `--approval-token` | string | no | — |
| `--refresh` | boolean | no | `false` |

The token is the one [`estimate_finding_fix`](#estimate_finding_fix) returned; without it the
core refuses with the estimate. Needs an open project. Emits progress and is cancellable.
Reading the diff is what a person is for: a diff can apply cleanly and still be incomplete.

#### `get_finding_fix_patch`

A finding's proposed fix as a `.patch` file — its current one, or `--fix-id`. Nothing is written
to disk: the diff is shown under the name to save it as, and applies with `git apply` from the
root of the tree the finding's run traced. Like the other results it resolves by id against the
central store.

| Flag | Type | Required |
| --- | --- | --- |
| `--finding-id` | integer | yes |
| `--fix-id` | integer | no |

#### `apply_finding_fix`

Writes a finding's proposed fix, its current one or `--fix-id`, to the source files of the tree
its run traced. This is the one operation of the group that changes your code, and it is
**destructive**: it is confirmed before it is sent.

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--finding-id` | integer | yes | — |
| `--fix-id` | integer | no | the finding's current fix |
| `--create-backup` | boolean | no | `true` |

In a Git work tree the diff is checked with `git apply --check` and then applied, and the way
back is Git. Anywhere else (or without `git` installed) each edit is checked again against its
file and replaced in it, with a `.bak` copy beside each file unless `--create-backup` is off. A
tree that no longer takes the fix answers `status: conflict` and **nothing is touched**; a fix
with nothing left to apply is `FIX_EMPTY_OR_UNAPPLICABLE`, and any other failure to write is
`FIX_APPLY_FAILED`, which leaves the tree as it was. The result says which files changed and
which backups were left. Needs an open project. For the guided way through all of this, see
[Fixing findings](cli/fixing-findings.md).

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
configuration. Requires a project. The CLI draws only what changed, each option as it was
and as it is, and says when nothing changed.

| Flag | Type | Required |
| --- | --- | --- |
| `--values` | object | yes |

#### `reset_config`

Returns options to their defaults, by key or all of them. Requires a project. Like
`set_config`, it draws only the options that changed.

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

The CLI draws it as a manual:

- **Operations**, grouped as `help` groups them. Under each group, a line says what its
  `requires` values mean (`requires contract: a project must be open and its contract
  loaded`), so the column needs no lookup.
- **Notes**, a column that appears when some operation has something to say about how it
  behaves: `progress` (it streams progress while it runs), `cancellable` (`Ctrl+C` stops it) and
  `destructive` (it asks for confirmation before it is sent).
- **Events**, with the operations that emit each and whether it is a state (a droppable
  snapshot) or a fact.
- **Error codes**, in two blocks. A `Code | Try` table lists the codes the CLI knows what to do
  about, each with the call that usually fixes it — the same step the CLI adds when it fails
  with that code. Below, under "Without a suggested step:", the remaining codes, which are
  explained by the core's message alone.

#### `describe_operations`

Just the operations, for a caller that wants nothing else (no event or error
catalog). No parameters.

## Local maintenance commands

These commands belong to the packaged CLI. They do not start the core.

### `credentials <file.env>`

Copies `KEY=value` entries from the given `.env` file into the env file used
by the core's LLM layer. Existing entries with the same name are replaced;
other entries are kept. Secret values are masked in the terminal output.

The core reports the destination path through `get_config`, so this command
also works with a source checkout and with the packaged binary. It runs
`diagnose` after writing the file. Nothing is written when the source file is
missing, empty, or is already the core's destination file.

```bash
specforge credentials .env.local
```

The command needs a core that publishes `paths.llm_env_file` (protocol
`0.1.14` or later).

### `update`

Checks GitHub for a newer packaged CLI release and installs it when one is
available. Development installs are not changed; update them with `git pull`.
On Windows, the replacement completes after the current process exits.

```bash
specforge update
```

Interactive sessions also check for an update once per day, in the background.
That check only displays a notice; it never installs anything.

### `delete`

Removes the packaged CLI, its launcher, and its per-user data, settings, and
cache after an interactive confirmation. Project files, including
`specforge.toml` and `.specforge/`, are left untouched.

```bash
specforge delete
```

For a development install, use `pip uninstall specforge-cli` instead.

## Errors

A rejection always renders to stderr with the domain code and the core's own
message (never swallowed, never re-worded by the CLI), and argv exits `1`. For most codes the
CLI adds the call that usually fixes it (`NO_STATIC_ANALYSIS` → `analyze_endpoints`), and an
empty list says what to run to fill it.
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
