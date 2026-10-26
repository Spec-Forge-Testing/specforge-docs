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
specforge                       # interactive: one core process, many operations
specforge <operation> [flags]   # one operation, then exit
```

With no arguments, `specforge` opens an interactive session against a freshly
started core: type an operation name, its flags, read the result, repeat. In a
capable terminal that session is the [full-screen interface](#the-full-screen-interface);
anywhere else it is a plain text [REPL](#the-text-repl) with the same commands.
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
| `SPECFORGE_SYSTEM_COMMANDS` | Set to `0`, `false`, `no` or `off` (case-insensitive) to disable the `!` system-command escape. Anything else, or unset, leaves it enabled. | enabled |
| `SPECFORGE_TUI` | Set to a falsy value (`0`, `false`, `no`, `off`) to skip the full-screen interface and use the text REPL. | enabled when the terminal allows it |
| `SPECFORGE_MOUSE` | Set to a falsy value to stop the full-screen interface from capturing the mouse, so the terminal's own selection and copy work and every action stays on the keys. | enabled |
| `SPECFORGE_THEME` | The color theme: `default`, `light`, `mono`, `nord`, `dracula`, `solarized` or `matrix`. The default theme's accent is Spec Forge's violet. | `default` |

Leaving the session (`exit`, `quit`, Ctrl-D on an empty line, or a closed terminal)
cancels whatever is still running and waits for the core to answer before closing,
so a run cut short keeps what it had produced.

## The full-screen interface

When both stdin and stderr are real terminals, `TERM` is not `dumb` and `SPECFORGE_TUI`
is not turned off, `specforge` takes over the screen: a banner and the conversation
above, one input line anchored at the bottom between two rules, and the current folder
(plus the open project, when it lives elsewhere) under it. The interface draws to
stderr, so stdout stays reserved for machine output. When any of those conditions fails,
the [text REPL](#the-text-repl) opens instead; `--json-output`, `--ci` and every
one-shot call never use the full-screen interface.

The banner says which core you are connected to and shows the CLI's version, the
folder you started in, tips, and your last few commands under *Recent activity* (kept
per project, in `.specforge/shell_history`). On a narrow terminal it drops to a
compact form without the box, and under 24 columns to a single line; nothing it
prints ever wraps.

### Typing a command

Commands are written as operation names with `key=value` pairs; there is no `/`
prefix. As you type, a menu lists the commands that match, each with what it does:
`↑`/`↓` move through it, `Enter` takes the highlighted entry (and, for a command that
needs nothing else — `help`, `clear`, `exit`, or an operation with no parameters —
runs it), `Esc` closes it. A first word the CLI does not know shows a notice with the
closest commands; `Enter` still sends it, and the core answers like any other error.

| Local command | What it does |
| --- | --- |
| `help [family\|operation]` | Opens a panel with a tab per family of operations, the operations in it, and each one's parameters. `←`/`→` change tab, `↑`/`↓` choose, `Enter` shows the details, `Esc` closes it. |
| `clear` | Clears the screen, leaving the banner and the input. A run still going keeps going. |
| `approve` | Approves what the core just asked to be approved. |
| `credentials <file.env>` | Gives the core the LLM model and key from your own `.env`. |
| `!<command>` | Runs a [system command](#system-commands-with). |
| `exit`, `quit` | Leaves. |

### Reading what comes back

What you typed is shown on a shaded line; what the core answers sits under it, and an
error hangs from it with a `└`. A long run shows one live line (a spinner, what it is
doing, the latest counters) and keeps its detailed progress folded: click the line, or
press `Ctrl-O`, to open it while it runs or once it finished; `Ctrl-O` again closes
every fold. The same finding reported again and again is shown once, followed by `×N`.
A table of more than 50 rows opens in a viewer (click it, or press `Ctrl-T`; `↑`/`↓`,
`PgUp`/`PgDn` to move, `Esc` to close) instead of flooding the conversation.

### Reading a run

`fuzz`, `replay`, `get_run` and `get_finding` use the same few words, so a report reads the
same wherever you meet it:

| Word | Means |
| --- | --- |
| **problem** | One distinct way the API misbehaved: the same rule broken at the same endpoint with the same status, already grouped. |
| **×N** | How many requests triggered it. |
| **possible problem** | Something the engine saw but could not confirm (it did not reproduce, or the run stopped before checking it). |

A run is drawn in sections, each with a line under its title saying what it is:

- **Problems.** Worst first. Each one names the rule it broke in a sentence, the endpoint, the
  status it answered, and, for the three worst, the evidence: `input` (what was sent), `reply`
  (what the API answered) and `repro`, an approximate `curl` to send it again. The command is
  aimed at the open project's URL (the call's own `base_url` when it named one) and says what it
  leaves out: it carries no credentials, so add your token to repeat a request that needs one.
- **Endpoints.** What happened to each endpoint the run reached. `Hits` is how many of its
  requests triggered a problem; `Status` says how it answered (`401 only`, `500s`, `clean`…).
- **Artifacts** (`get_run`). The files the run left on disk, each with its whole path: the
  execution trace (every request and response, which `replay` re-sends) and the report as json
  and as html.
- **Observations.** What the run suggests, said in a sentence and worked out by the CLI from the
  report: it was cut short by its deadline, no request ever got a successful answer, nearly every
  response was refused by authentication, the same error repeated across endpoints, a redirect
  the contract does not declare, or a replay that was not faithful.

The headline counts problems, not the findings that make them up: three findings of the same
rule at the same endpoint are `1 problem`, and `get_run` names the three (`findings #1, #2, #3`)
so that `get_finding finding_id=<#>` opens any of them. A finding's own `×N` counts only the
requests that finding stands for.

Each explanation line is shown the first time it is useful in a session and not again, so a long
session is not filled with the same sentences. `Ctrl-L` starts over, and so does the next
session. Where a result names a file or a folder you may want to open or copy (the project root,
the spec, the artifacts, a handler's file), the path is shown whole; only the header and the
footer shorten it. Run without a terminal (a pipe, a file, CI), the output is drawn 160 columns
wide, or as wide as `COLUMNS` says, so tables and commands are not cut.

### Keys

| Key | Effect |
| --- | --- |
| `Enter` | Sends the line (or takes the highlighted menu entry). |
| `Esc` | Closes the menu, a panel or a viewer, or drops a selection. |
| `Ctrl-C` | Copies the selection if there is one; otherwise cancels the runs in flight (the core answers with what they produced). |
| `Ctrl-D` | Leaves, on an empty input line. |
| `Ctrl-L` | Clears the screen. |
| `Ctrl-O` / `Ctrl-T` | Opens or closes the folded progress / opens the last long table. |
| `Ctrl-V` | Pastes from the system clipboard, as a single line. |
| `PgUp` / `PgDn`, mouse wheel | Scroll the conversation. |

Dragging with the mouse selects text and copies it when you let go (to the system
clipboard, and through the terminal's own clipboard escape where the system one is
not reachable). With `SPECFORGE_MOUSE=0` the terminal's native selection works
instead; in many terminals `Shift`+drag does the same without turning anything off.

### Questions

When something needs your say, a question takes the place of the input and the conversation
stays in view above it. Three kinds come up:

- **An approval** (a destructive operation, a run that would pay for LLM inference, a replay
  with side effects): the question and what would be sent. Only `y` approves; `n`, `Enter`,
  `Esc`, `Ctrl-C` and `Ctrl-D` decline, and a declined call says *not approved; nothing was
  sent*. Other keys do nothing, and a `y` typed before the question appeared is ignored, so
  typing ahead never approves anything. For an inference cost or a replay, run the call, read
  the estimate or the reason, and type `approve` to get the question.
- **Trusting the folder.** Opening `specforge` in a folder that is not a project asks
  *Do you trust this folder?* and lists what trusting allows: creating `specforge.toml` and a
  `.specforge/` folder, reading the source code, and saving the spec when you give a URL. Only
  `y` trusts; nothing is written to the folder before that.
- **The spec.** In a trusted folder with no `openapi.yaml`, `.yml` or `.json`, a line asks for
  the spec as a file path or a URL (a URL is downloaded into the folder). A path with no file,
  or a URL that cannot be fetched, says why and asks again; an empty line or `Esc` cancels.

## The text REPL

The fallback interface: a prompt (`❯`), one line at a time, results printed in
your terminal's scrollback. It takes the same lines and the same local commands as
the full-screen interface, and the same completion (below), and it is what you get
over a pipe, in a `dumb` terminal, on Git Bash without a pseudo-terminal, or with
`SPECFORGE_TUI=0`. A destructive call, an inference cost or a replay with side
effects is confirmed inline (see [Asking before it matters](#asking-before-it-matters)).

## Two ways to write a call

**Inside the interactive session**, a line is `<operation> [key=value ...]`:

```text
❯ open_project path=/home/dev/my-api
❯ fuzz base_url=http://localhost:8000 execution=stateful
```

Each value is parsed as JSON when it looks like JSON (`42`, `true`,
`{"a":1}`), and as a plain string otherwise — so quoting is only needed for a
string that happens to look like a number or a keyword.

A value with spaces goes in quotes right after the `=`. Double quotes are taken
literally, so a Windows path needs no escaping; single quotes are read like an
unquoted value, which is how a JSON object with spaces is quoted. An object or
array can also span spaces unquoted:

```text
❯ open_project path="C:\Users\Ana Perez\my-api"
❯ fuzz base_url=http://localhost:8000 load={"latency_sla_ms": 500}
```

**From your shell**, a flag is `--<name-with-dashes> <value>`, derived from the
same parameter name with underscores turned to dashes:

```bash
specforge fuzz --base-url http://localhost:8000 --execution stateful
```

A boolean parameter is a flag with no value, with an automatic negated form:
`--save` / `--no-save`. An `object`-typed parameter (`load`, `producer` on
`fuzz`/`run_pipeline`) takes one flag carrying a JSON literal, the same
convention the interactive session uses for a line's own `key=value`:

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

The prompt completes as you type, in order: the operation name first, then
`<parameter>=` for one of that operation's parameters, then — for an `enum`
parameter — the admissible values after the `=`. All of it is derived from the
catalog, so a parameter the core adds later completes without a CLI release.

The history (`.specforge/shell_history`, kept only once the folder is a project) never stores a credential in
plain text. A line that mentions `headers` (the option where an `Authorization`
header would go) is not written to the file at all, though the up arrow still
recalls it during the session. Any `user:pass@host` userinfo embedded in a URL
(e.g. a `base_url=` with inline credentials) is redacted to `user:***@host`.
Nothing is scrubbed from what the core itself logs or persists, and a secret
passed as a shell argument stays in your shell's own history: this only protects
the history file.

### System commands with `!`

Prefix a line with `!` to run it as a system command without leaving the
session:

```text
❯ !git status
❯ !pytest -q
```

The escape is explicit on purpose: a line without `!` is always an operation call,
so a typo in an operation name never turns into an accidental system call. A `!`
line never reaches the core; the CLI runs it locally.

- **Streaming output.** `stdout` is shown as the command runs and `stderr` in the
  error colour, so a long command shows progress. A non-zero exit code is reported.
- **Working directory.** Commands run in the directory the CLI was started in. `!cd
  <dir>` moves the session there, so the commands that follow run in the new
  directory; `!cd` with no argument prints the current one. A directory that does
  not exist is reported and the session stays where it was. `!cd` does not change how
  operations resolve a relative path: the core anchors those to the project root.
- **Output encoding.** Output is read as UTF-8 and, if it isn't valid UTF-8, in the
  console's own codepage, so native Windows tools (`help`, `ping`) show their accents
  correctly.
- **The prompt stays free.** The command runs off the prompt, like any operation,
  so you can keep typing while it runs.
- **Failures don't end the session.** A missing program, an unparsable line (such
  as an unbalanced quote) or a failing command is reported and the session carries on.
- **Disabling it.** Set `SPECFORGE_SYSTEM_COMMANDS=0` (or `false`, `no`, `off`) to
  turn the escape off, for example in a shared or non-interactive environment.
  `!` then answers that system commands are disabled.

A command is a single program run **without a shell**: no pipes, redirection or
shell built-ins such as `dir` or `ls` (`cd` is the exception, handled by the CLI
itself), and no interactive programs (its stdin is closed, so
`vim` or `git rebase -i` will not work). The `!` escape exists only in the interactive
session (full-screen or text); the argv form (`specforge <operation> ...`) runs your shell's own commands anyway.

When a program isn't found, the error suggests running it through a shell, which is
how to use a built-in:

```text
❯ !dir
✗  Command not found: dir
   │ It may be a shell built-in, and `!` runs programs directly, without a shell.
   │ Try: !powershell -c "dir"
```

On Linux and macOS the suggestion is `!sh -c "..."`.

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

With no arguments at all, `specforge` opens the interactive session regardless of any of
these — they only apply once an operation name is given.

Ctrl-C during a one-shot call asks the core to cancel and still prints what the
run had produced; a second Ctrl-C stops waiting.

## Asking before it matters

Some calls stop to ask first. In the text REPL the question is asked inline, and a call
that needs approval can also be approved with `approve`. The full-screen interface asks the
same questions on a [screen](#questions).

| What | When it asks | Answering up front |
| --- | --- | --- |
| Destructive operations (`apply_fix_plan`, `apply_prune_plan`) | Before they are sent. | `--yes` |
| A run that would pay for LLM inference | The core refuses and returns its estimate (contracts to infer, tokens, cost). The CLI shows it, asks, and resends with the approval token. | `--yes`, but only with `producer.max_cost_usd` set; without a cap it stops with exit `2`. |
| A replay that could change the target | The CLI explains why (recorded with side effects, or its run reached routes the safety guard held back) and asks. | `--allow-side-effects`. `--yes` does not cover it, and `--no-allow-side-effects` is never overridden. |

In the text REPL, a call that needs approval shows its estimate or reason and waits:
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

`describe` publishes 33 operations across eight families. `requires` says
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

An analysis's runs, each row already saying whether to trust its evidence. `Problems` counts
the distinct problems a run found, and says how many were confirmed when that is not all of
them (a run cut short leaves some unverified).

| Flag | Type | Required | Default |
| --- | --- | --- | --- |
| `--analysis-id` | integer | yes | — |
| `--status` | string | no | — |
| `--since` | date | no | — |
| `--endpoint-path` | string | no | — |
| `--limit` | integer | no | — |

#### `get_run`

Everything one run recorded, with its findings paged. It is drawn like a fresh report (see
[Reading a run](#reading-a-run)), plus the files the run left on disk.

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
