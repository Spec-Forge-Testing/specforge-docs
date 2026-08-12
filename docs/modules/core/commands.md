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
    ```

    `fuzz` runs the execution engine end to end **without the LLM or source analysis**:
    it parses the contract, compiles Hypothesis strategies straight from the schema,
    fuzzes the live API at `--base-url` and shrinks every failure to its minimal
    reproducer. The schema constraints alone (`type`, `minimum`, `enum`, `pattern`, …)
    are enough to surface `5xx` crashes and undeclared responses.

    The command prints:

    - **Run summary** — total requests and the finding funnel (raw → confirmed after
      shrinking → unique after de-duplication → flaky).
    - **Category breakdown** — requests grouped by outcome (success, client/server
      error, timeout, availability).
    - **Crashes** — one row per minimal reproducer: method, endpoint, phase, the
      violated invariant, the status code and the smallest failing payload.

    Narrow the run with `--endpoint <path>` and/or `--method <verb>`, and tune execution
    with `--timeout` / `--max-concurrency`. The target API must already be running;
    infrastructure failures (server down, timeout) are reported, never fatal.

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
    and any `user:pass@` in the base URL is stripped (a replay re-injects the real
    values from the live config). The run also records its outcome `status`
    (`completed`/`truncated`), the replay `fidelity` when it is one, and the engine
    version as provenance.

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
