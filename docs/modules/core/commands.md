# Spec Forge CLI (`specforge_cli`)

Interactive REPL orchestrator for the Spec Forge pipeline. Commands self-register
through the `@command` decorator (`repl/registry.py`) and are dispatched by
`repl/dispatcher.py`. Presentation is a small design system under `ui/`
(tokens → theme → components); business logic lives in pure `services/`.

## Running

```bash
specforge          # launch the interactive REPL
```

Inside the REPL, type `help` to list commands or `help <command>` for details.

## Architecture

The CLI is layered so styling, commands and logic each have one home:

- **`ui/`** — the design system. `tokens.py` names semantic styles and icons,
  `theme.py` maps them to a switchable `rich.Theme`, and `components.py` builds
  every panel, table and message from those tokens. No raw colors live outside the
  theme, so re-skinning is a one-file change.
- **`config/`** — typed, grouped definitions: `paths`, `commands` and the
  `CommandCategory` enum.
- **`services/`** — all business logic, free of any printing: pure helpers that
  return DTOs (`workspace`, `tracing`, `contract`) and the larger self-contained
  subsystems (`shell/` for the `!` escape, `diagnostics/` for `doctor`).
- **`repl/`** — the session loop, dispatcher, registry, completer and thin command
  handlers; feature renderers live in `repl/views/` (one module per feature),
  composed from the `ui/` components.
- **`cli/`** — the argv entrypoints: Typer subcommands run from the shell (e.g.
  `specforge init`), distinct from the in-REPL `repl/commands/`. Both reuse the
  same `services/`.

The registry is the single source of truth for commands: the completer and help
derive from it, so adding a command is one file — declare it with `@command`
(name, category, aliases, argument flags) and it appears in dispatch, help and
completion automatically.

## Adding a new command

Commands are self-registering, so a new one is small and local:

1. **Name** — add the command string to `config/commands.py`
   (e.g. `CMD_FOO = "foo"`), and a `CommandCategory` to `config/categories.py` if
   none fits.
2. **Handler** — create `repl/commands/foo.py` and decorate the handler:

   ```python
   from specforge_cli.config import CommandCategory, commands
   from specforge_cli.repl.registry import command


   @command(
       name=commands.CMD_FOO,
       description="One-line summary shown in `help`.",
       category=CommandCategory.GENERAL,
       aliases=("f",),                 # optional
       arguments=("--flag", "-x"),     # optional, feeds autocompletion
       examples=["foo --flag"],        # optional, shown in `help foo`
   )
   def cmd_foo(args: list[str]) -> None:
       result = run_foo(args)          # logic in services/
       print_foo(result)               # presentation in repl/views/ + ui/
   ```

3. **Logic & presentation** — keep computation in `services/` (pure, returns a DTO)
   and rendering in a `repl/views/` module built on the `ui/` components. Handlers
   stay thin: parse args, call the service, render the result.
4. **Register the module** — add `foo` to the imports in
   `repl/commands/__init__.py` so the decorator runs at startup.

That's it: dispatch, fuzzy-match suggestions, `help`, `help foo` and tab-completion
are all derived from the registry — no other file needs editing.

## Current Commands

??? "`doctor` — environment & dependency diagnostics"

    ```text
    SpecForge ❯ doctor
    ```

    `doctor` checks that the local environment is ready to run the whole pipeline and
    prints a categorized report. For each check it shows a status, a detail and — when
    something is wrong — a concrete fix.

    It validates:

    - **Runtime** — the Python interpreter version and the CLI's own dependencies.
    - **Pipeline modules** — Contract Engine, AST parser, LLM integration, execution
      engine, storage and the shared contracts, probed by import without executing them.
    - **Test runtime** — `pytest` / `pytest-cov`.
    - **LLM configuration** — the module-local `lib/semantic_inference/.env.local`,
      `LLM_MODEL`, and the provider credential the configured model needs (presence
      only — credential *values* are never read or shown).

    Findings are split into two levels:

    - **critical** (✖) — the interpreter, the CLI runtime, or a pipeline stage wired
      into a working command today (the Contract Engine, the AST parser, the execution
      engine). The environment is *not ready* while any critical check fails.
    - **warning** (⚠) — a not-yet-wired pipeline stage, the test runtime, or missing LLM
      configuration. These degrade a capability but don't block the CLI.

    The diagnostic logic is pure and deterministic: `specforge_cli.services.diagnostics.run_diagnostics`
    returns a `DiagnosticReport` DTO and never prints; the CLI renders it. The check
    catalog and severities are declared as data in `services/diagnostics/requirements.py`.

??? "`doctor --fix` — guided installation"

    ```text
    SpecForge ❯ doctor --fix          # plan, confirm, install, re-check
    SpecForge ❯ doctor --fix --yes    # skip the confirmation (CI / non-interactive)
    ```

    `--fix` installs the missing components. It runs **only** the catalog's install
    commands — never arbitrary input — as `python -m pip install -e <target>` in the
    **current interpreter**, ordered so the shared contracts land before the engines
    that import them. It is read-only until confirmation: it prints the plan, asks for
    approval (skipped by `--yes`), streams each install, then **re-runs the diagnosis**
    to show the resulting state. Manual fixes (the `.env.local` file, `LLM_MODEL`,
    credentials) are listed but never auto-applied. Honors `SPECFORGE_SYSTEM_COMMANDS`:
    when system commands are disabled, the plan is shown but nothing is executed.

    The planning is pure (`services/diagnostics/planner.py`: a `DiagnosticReport` →
    `FixPlan`) and the execution is a thin orchestration over the injectable
    `CommandExecutor` seam (`services/diagnostics/fixer.py`), so both are unit-tested
    without installing anything.

    > Like the rest of the Rich UI, `doctor` emits status glyphs (✔ ⚠ ✖). On a
    > legacy Windows console these require a UTF-8 capable terminal; redirecting output
    > to a non-UTF-8 pipe can raise an encoding error (a pre-existing, app-wide trait of
    > the Rich presentation layer, not specific to this command).

??? "`trace` — static code tracing from an OpenAPI endpoint"

    ```text
    SpecForge > trace --contract openapi.yaml --project /path/to/project --operation-id create_user
    ```

    `trace` connects the OpenAPI contract with the source code of the project being tested. It reads the contract, selects one or more endpoints, locates the handler function in the target repository and asks `core_ast` to extract only the relevant AST context for that endpoint.

    The command prints:

    - **Endpoint** — the HTTP method and path found in the OpenAPI contract.
    - **Controller** — the source file where the endpoint handler was located.
    - **Target function** — the function extracted as the entry point for the endpoint.
    - **Trace mode** — whether the dependency trace was surgical, hybrid or fallback.
    - **Processed functions** — each file/function pair visited while resolving local calls and imports.
    - **Fallback / hybrid files** — extra files selected when the tracer cannot resolve enough dependencies surgically.

    `--operation-id` is the OpenAPI `operationId` of the endpoint. In many APIs this matches the handler function name, so it gives the AST locator a precise target:

    ```yaml
    paths:
      /users:
        post:
          operationId: create_user
    ```

    With that contract, `--operation-id create_user` means: "trace the `POST /users` endpoint whose OpenAPI operation is named `create_user`".

    If the contract has no `operationId`, use the endpoint coordinates instead:

    ```text
    SpecForge > trace -c openapi.yaml -p /path/to/project --path /users --method post
    ```

??? "`ast-extract` — inspect the extracted code and the LLM context"

    ```text
    SpecForge ❯ ast-extract -c openapi.yaml -p /path/to/project --operation-id create_user --code
    ```

    Where `trace` reports *which* files and functions were visited, `ast-extract`
    shows the *actual content*: the function `core_ast` surgically extracts and the
    context that would be sent to the LLM. It accepts the same endpoint selectors as
    `trace` (`-c/--contract`, `-p/--project`, `--operation-id`, or `--path`/`--method`)
    plus three mode flags:

    - **`--code`** (default) — the extracted controller and each dependency function,
      syntax-highlighted with their real line numbers. Use it to verify the AST cut is
      correct.
    - **`--payload`** — the packaged context the inference engine would receive, parsed
      into sections (primary controller, dependencies, fallback files and any missing
      context) plus its estimated token count and a complete/partial flag.
    - **`--raw`** — the *literal* `system_context` XML the LLM actually receives,
      verbatim (the `<source_context>` block with its `<primary_controller>`,
      `<dependencies>` and `CDATA` sections), for auditing the exact prompt input.

    They can be combined (e.g. `--code --payload`, or `--payload --raw`). Even when the
    dependency trace degrades to *hybrid* or *fallback* mode, `--payload`/`--raw` still
    show the primary controller and the selected fallback files, so there is always
    something to inspect.

??? "`fuzz` — compile strategies from the schema and fuzz a live API"

    ```text
    SpecForge ❯ fuzz -f openapi.yaml --base-url http://localhost:8000
    SpecForge ❯ fuzz -f openapi.yaml --base-url http://localhost:8000 --stateful
    SpecForge ❯ fuzz -f openapi.yaml --base-url http://localhost:8000 --identities identities.toml
    ```

    `fuzz` runs the execution engine end to end **without the LLM or source analysis**:
    it parses the contract, compiles Hypothesis strategies straight from the schema,
    fuzzes the live API at `--base-url`, groups the failures by symptom and shrinks one
    representative per symptom to its minimal reproducer. The schema constraints alone
    (`type`, `minimum`, `enum`, `pattern`, …) are enough to surface `5xx` crashes and
    undeclared responses.

    The command prints:

    - **Run summary** — the exploration requests, the requests shrinking sent apart
      from them, and the finding funnel: raw → confirmed (one representative per
      symptom, still failing after shrinking) → collapsed (same symptom as a
      confirmed one, never shrunk) → unverified (never attempted, because the run
      was cut before shrinking started) → flaky → unique after de-duplication.
      `raw == confirmed + flaky + collapsed + unverified` always holds. A stateful
      run has no separate shrink phase, so its report shows neither shrink requests
      nor collapsed or unverified findings.
    - **Category breakdown** — requests grouped by outcome (success, client/server
      error, timeout, availability).
    - **Crashes** — one row per minimal reproducer: method, endpoint, phase, how many
      prior steps set it up (a dash for a single request), the violated invariant,
      the status code, how many raw findings the crash stands for (`Represents`;
      stateless runs only), the identity it was found under (`Identity`; only shown
      when at least one crash in the run recorded one) and the smallest failing
      payload.

    A run the target's liveness probe found dead is cut **before** shrinking, so
    its findings were collected but never confirmed. The report never calls that a
    clean run: it shows the **Unverified** count instead of the usual "No crashes
    found", with a warning explaining the run was cut short — the same distinction
    `inspect --run <id>` shows later.

    Narrow the run with `--endpoint <path>` and/or `--method <verb>`, and tune execution
    with `--timeout` / `--max-concurrency`. The target API must already be running;
    infrastructure failures (server down, timeout) are reported, never fatal.

    `--identities <file>.toml` declares who the requests are sent as — a TOML list
    of labelled credential sets, any of them possibly anonymous (a label with no
    headers):

    ```toml
    [[identities]]
    label = "anonymous"

    [[identities]]
    label = "alice"
    [identities.headers]
    Authorization = "Bearer alice-token"
    ```

    Labels must be unique — they key findings, crash reports and replays. Each
    endpoint phase's example budget is split evenly across the declared identities
    (the remainder to the first ones, and one the budget cannot reach gets no
    share), and a finding is shrunk under the identity that found it, never
    re-drawn. A stateful sequence draws one identity when it starts and keeps it
    for every step, since a sequence is a session. The same symptom found under two
    identities is two findings, never one — so the crash tables gain the
    **Identity** column above. The label is persisted with the crash and the run's
    trace; the credentials never are (see below).

    `--stateful` switches to [stateful fuzzing](../custom-schemathesis/stateful-fuzzing.md):
    requests are **chained into sequences** instead of each operation being fuzzed on
    its own, which surfaces order-dependent failures — a resource created, deleted,
    then read. `--endpoint`/`--method` still narrow the sequences to the matching
    operations, and the run is saved like any other. Two limits: a stateful run is
    markedly slower, and the data flow between requests — an id returned by one call
    feeding the next — is not compiled from the spec yet, so sequences share no
    values. A stateful finding is reported by the step that failed; the **Prior
    steps** column says how many requests set it up, which is the cue to open
    `inspect --crash <id>` for the sequence. A transition the API answered with an
    unexpected status shows as `unexpected transition status`. The run is cut short
    and reported as `aborted` when the target stops answering, or when a state link —
    the declared hand-off from one request's response into the next request — cannot
    be honored; the engine's diagnosis is reported with it.

    Every run is **saved by default** through the [storage engine](../storage/index.md):
    a project → analysis → run hierarchy with metrics, per-endpoint stats, crash
    reports and the execution trace as a critical artifact, written in one atomic
    transaction — a mid-write failure rolls the whole run back. `--no-save` opts out;
    `--project` overrides the stored project name (default: the spec's `info.title`,
    falling back to the file stem). The report always renders before persisting, so a
    storage failure surfaces as a warning without losing the run's output, and a
    missing `storage` install degrades gracefully.

    The saved run is a **shareable reproducible recipe**, so no credential value is
    ever stored — not even redacted: the execution config keeps header *names* only,
    any `user:pass@` in the base URL is stripped, and the declared identities are
    dropped whole, labels aside — a crash keeps the label it was found under, the
    trace keeps the label each request was sent under, and a replay re-supplies the
    values from `--identities <file>.toml`. The run also records its outcome `status`
    (`completed`/`truncated`/`aborted`), the replay `fidelity` when it is one, and the
    engine version as provenance. The analysis records whether the run was stateful
    and, when it was, the effective budget it ran with (`stateful_config`: examples,
    steps per sequence and distinct bugs per sequence).

??? "`history` — browse persisted projects, analyses and runs"

    ```text
    SpecForge ❯ history
    SpecForge ❯ history --project 1
    SpecForge ❯ history --analysis 3
    SpecForge ❯ history --analysis 3 --status truncated --since 2026-08-01 --limit 5
    ```

    Navigates everything the fuzzer has persisted, in the three levels the storage
    schema is built around: with no flags it lists every **project** (with its
    analysis count); `--project <id>` lists that project's **analyses** — the
    replayable recipes, each with its label, strategy mode, whether it was stateful,
    engine version and run count; `--analysis <id>` lists that analysis's **runs** in
    ordinal order.

    The run listing is where the model pays off: an **original** run (`●`) is
    visually distinct from a **replay** (`↺`), and a run whose counters would
    mislead if compared against another's carries a **not-comparable mark** with
    its reason — `truncated` (it stopped early against its own limits, so its counters
    are a budget prefix), `aborted` (a fault stopped it: the target stopped responding,
    or a state link could not be honored), `reduced fidelity` (the replay ran against a
    changed environment), or an unknown status vocabulary from an older database.

    `--status`, `--since <YYYY-MM-DD>` (UTC), `--endpoint <path>` ("runs that
    exercised this endpoint") and `--limit <n>` filter the run listing and require
    `--analysis`. Identifiers are always the numeric ids the previous level shows —
    project names are not unique, ids are.

    Without the `storage` install the command warns and returns instead of failing.

??? "`inspect` — the full detail of one run, or of one crash"

    ```text
    SpecForge ❯ inspect --run 7
    SpecForge ❯ inspect --crash 12
    ```

    `--run <id>` renders one run in full, in five sections: a **header** with its
    context (project, analysis, ordinal, origin, execution time, duration, status,
    fidelity and the comparability mark); the **metrics** funnel (requests, raw →
    confirmed → unique → flaky → **Unverified** findings — never shrunk because the
    run was cut short) with the per-phase and per-category breakdowns;
    **per-endpoint stats** including the latency percentiles (p50/p95/max — a dash
    when the endpoint was never timed); every recorded **crash** — with its id, the
    same plain-English invariant labels the fuzz report uses, the identity it was
    found under (**Identity**; shown when at least one crash recorded one), and the
    **minimal payload that reproduces it**, so a saved run shows no less than the
    report printed when the fuzzing finished; and the run's **artifacts** (the
    execution trace and any run-level files).

    `--crash <id>` answers *what actually failed*, taking the id from the crash
    table above. It shows the request's **minimal payload** broken down by zone,
    its **sanitized headers**, the **identity it was found under**, and the
    **body the API responded with** — which is usually where the error message
    lives. When the crash carries them, it also shows the **stack trace** and the
    **transition sequence**: the chain of requests that produced a stateful
    finding. The two flags are mutually exclusive.

    Payload values keep the spelling they travelled the wire with (`null` and
    `true`, not Python's `None` and `True`), so anything copied out of the CLI is
    still valid JSON.

    Two rules keep the output readable no matter what the API returned:

    - An **empty response body is reported as such** — never as the `—` that
      means "no data recorded" everywhere else. An API answering `500` with no
      message is a different fact from a field that was never saved, and telling
      them apart is often the first clue.
    - **Long values never flood the terminal.** Each one is cut to a bounded
      length, and the block's footer says how many characters it is hiding, so a
      truncated body is never mistaken for a short one.

??? "`replay` — re-send an analysis's recorded trace against a live API"

    ```text
    SpecForge ❯ replay --analysis 3
    SpecForge ❯ replay --analysis 3 --no-save
    SpecForge ❯ replay --analysis 3 --no-preserve-timing
    SpecForge ❯ replay --analysis 3 --identities identities.toml
    ```

    Re-sends the exact requests recorded in an analysis's execution trace —
    verbatim: no regeneration, no shrinking, no seed. The trace is the
    **analysis's recipe** (all of its runs share it), which is why the command
    takes an analysis id, not a run id; `inspect --run <id>` shows the analysis
    id in its header, and `history --project <id>` lists them.

    Every request that violated an invariant when recorded gets its own
    **verdict**:

    - **present** (✖) — the API answered with the same status, or a different
      one that still violates (a `500` turned `502` is still broken).
    - **possibly resolved** (✓) — the response changed cleanly *and* the replay
      ran with **exact** fidelity: every other request answered as recorded.
    - **inconclusive** (⚠) — the response changed, but the surrounding trace
      diverged (reduced fidelity) or the request got no response at all.

    "Possibly resolved" is never "resolved", by design. A replay re-sends one
    recorded stimulus: a clean answer proves *this request* no longer triggers
    the defect, not that the defect's class is gone. And the negative claim
    needs a clean context — under **reduced fidelity** the environment
    observably changed, so a defect that stopped answering `500` is
    *inconclusive*, never resolved; the report states this explicitly.

    The command refuses recipes it cannot replay whole, **before sending a
    single request**: an empty trace, a missing or tampered trace artifact
    (content is hash-verified on read), a trace recorded under an identity label
    that `--identities <file>.toml` does not declare — the stored recipe keeps
    labels only, never credentials, so the check comes first — and, once every
    label resolves, traces that still need a credential header value no declared
    identity carries; stored recipes keep header *names* only, never values.
    Header values set for the whole run (`config.headers`) cannot be re-supplied
    yet — only an `--identities` file can.

    `--identities <file>.toml` re-supplies the identities the run was recorded
    under, from the same file shape `fuzz` reads. A missing label surfaces as a
    **Missing Identities** panel naming every label the trace needs, before
    anything is sent.

    `--save` (default on) appends the replay to the same analysis as a new run
    with the next ordinal, so `history --analysis <id>` shows original and
    replays side by side. `--no-preserve-timing` skips the recorded pacing
    between requests, which can change the outcome of timing-sensitive defects.

??? "`!` — run system commands"

    ```text
    SpecForge ❯ !git status
    SpecForge ❯ !pytest -q
    ```

    Prefix any line with `!` to run it as a system command from the same session.
    The escape is **explicit on purpose**: a line without `!` is always resolved as
    an internal command (and a typo gets a fuzzy suggestion, never an accidental
    system call), so internal-vs-system resolution stays unambiguous.

    - **Streaming output.** `stdout` and `stderr` are shown live as the command
      runs, so long commands (`pytest`, `docker build`) show progress instead of
      going silent. `stderr` is visually differentiated and a non-zero exit code is
      reported clearly.
    - **Shared working directory.** Commands run in the REPL's current directory, so
      the internal `cd` and `!ls` / `!git` stay in sync.
    - **Never breaks the loop.** A missing executable, an unparsable line or a
      failing command are reported and the REPL keeps going. The child's stdin is
      closed, so an interactive program gets EOF instead of hanging the session.
    - **Disable in CI/CD.** Set `SPECFORGE_SYSTEM_COMMANDS=0` (or `false` / `no` /
      `off`) to turn the escape off in non-interactive environments.

    The executor is decoupled from rendering behind a `CommandExecutor` seam: it
    streams typed output events that the Rich CLI renders today and a future desktop
    frontend can consume directly.

    > Scope: the primary target is Linux/Docker (Windows is best-effort). v1 runs a
    > single program without a shell (no pipes, redirection or built-ins like `dir`)
    > and is not interactive (no `vim` / `rebase -i`); a PTY-backed executor for full
    > interactivity is a planned follow-up.

??? "`theme` — switch the UI color theme"

    ```text
    SpecForge ❯ theme          # list themes, marking the active one
    SpecForge ❯ theme mono     # switch at runtime
    ```

    Switching the theme re-skins **everything** — console output, the banner and the
    REPL prompt — because each is rendered through semantic tokens, not raw colours.
    Bundled themes: `default`, `mono`, `nord`, `dracula`, `solarized`, `matrix`. They
    are token→style maps in `ui/theme.py`; the active theme can also be chosen at
    startup with `SPECFORGE_THEME=<name>`.

## Example workspace — `examples/ast_demo`

`examples/ast_demo/` is a self-contained *Dummy Bank API* used to exercise the
commands end to end and see each renderer against one consistent project. It pairs
a handful of source handlers with the matching `openapi.yaml`:

```text
examples/ast_demo/
├── openapi.yaml   # POST /transfer · GET /account/{account_id}
├── handlers.py    # the FastAPI handlers (the trace targets)
├── rules.py       # business validators called by the handlers
├── models.py      # request/response DTOs
└── data.py        # in-memory account fixtures
```

`transfer` carries the canonical Spec Forge bug: a non-positive `amount` escapes as
an unhandled error and surfaces a `500` where the schema implies a clean `4xx` — a
business invariant the OpenAPI alone never states.

Run the demo from the repository root:

```bash
# 1. Validate the spec
SpecForge ❯ contract-engine --validate -f core/examples/ast_demo/openapi.yaml

# 2. List the endpoints and their engine readiness
SpecForge ❯ contract-engine --analyze -f core/examples/ast_demo/openapi.yaml

# 3. Trace the transfer handler against the example source
SpecForge ❯ trace -c core/examples/ast_demo/openapi.yaml -p core/examples/ast_demo --operation-id transfer

# 4. Inspect the extracted code and the LLM context for transfer
SpecForge ❯ ast-extract -c core/examples/ast_demo/openapi.yaml -p core/examples/ast_demo --operation-id transfer --payload

# 5. Fuzz the live API — start it first in another terminal:
#    uvicorn handlers:app --app-dir core/examples/ast_demo --port 8000
SpecForge ❯ fuzz -f core/examples/ast_demo/openapi.yaml --base-url http://localhost:8000
```

Step 3 locates `transfer` in `handlers.py` and follows its calls into `rules.py`
and `data.py`, so the trace report lists the helper functions it walked across
files. Step 4 prints the actual extracted source and the packaged LLM context for
the same endpoint. Point `--project` at `core/examples/ast_demo` (not the whole
repo) so the locator resolves a single, unambiguous handler. Step 5 serves those
same handlers and fuzzes them: the schema-only run reaches the `500` (whenever
Hypothesis happens to generate a valid `account_id`) and also flags the `422`s the
spec never declares.

## Tests

Tests live under `tests/`, grouped into subpackages that mirror `src/`
(`config/`, `ui/`, `services/`, `repl/`). Setup and test commands are in
[Development & Testing](../../getting-started/development.md#module-commands).
