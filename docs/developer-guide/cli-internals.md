# CLI Internals

Interactive REPL orchestrator for the Spec Forge pipeline. Commands self-register
through the `@command` decorator (`repl/registry.py`) and are dispatched by
`repl/dispatcher.py`. Presentation is a small design system under `ui/`
(tokens → theme → components); business logic lives in pure `services/`.

The CLI delegates to `contract-engine`, `core-ast` and Custom Schemathesis; see
their module pages for the corresponding implementation details. For how to use
the commands themselves, see the [CLI Reference](../user-guide/cli-reference.md).

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

## Seams that keep logic testable

Every command computes a result DTO in `services/` and renders it in
`repl/views/`; the split is what lets the logic run under test with no terminal
and no network. Three seams are worth knowing:

- **`diagnostics/` (`doctor`, `doctor --fix`)** — the check catalog and
  severities are data in `requirements.py`, so adding or re-rating a check is a
  table edit. `run_diagnostics` returns a `DiagnosticReport`; `planner.py` turns
  that into a `FixPlan`; `fixer.py` applies it over an injectable
  `CommandExecutor`. Nothing installs or prints on the tested path.
- **`shell/` (`!`)** — the same `CommandExecutor` seam streams typed output
  events. The Rich views render them today; another frontend could consume them
  directly.
- **`ui/theme.py` (`theme`)** — each bundled theme is a token→style map and no
  raw colour exists outside it, so a re-skin is a one-file change.

## The fuzz seam (`services/fuzz/`)

`core` is the only layer allowed to know both the Contract Engine and the
execution engine at once, and `services/fuzz/` is where that seam lives.
`runner.run_fuzzing` loads and selects the endpoints, derives the state links
from the spec (`state_link.build_state_links`, over the full declared list so a
producer and its consumer still chain when the filter keeps only one), asks the
optional contract producer for each selected endpoint, fuses what it returns
over the OpenAPI base (`services/contract.fuse_endpoint_contract`, a thin seam
over the Contract Engine's `fuse_contract`) and hands everything to
`adapter.endpoints_to_compiler_input`.

The producer is a `Protocol` — `produce(endpoint, *, agent_profile) ->
EndpointContract | None`, `None` leaving that endpoint schema-only — so where
an enriched contract comes from is swappable. One implementation exists today:
`FixtureContractProducer(directory)`, behind `fuzz --contracts <dir>`, which
loads every `*.json` directly under the directory as a kernel `EndpointContract`
and indexes it by the `method`/`path_url` it declares. The `agent_profile` a
producer is asked for derives from the chosen strategy
(`constants.STRATEGY_TO_AGENT_PROFILE`: `DEFAULT → "qa"`, `HACKER →
"security"`); the producer never selects the mode itself. The runner checks
the produced contract's identity against the endpoint before fusing, since
fusion stamps the endpoint's own identity onto its result. An LLM-backed
producer is a follow-up, and produced contracts are not persisted with the
analysis.

The adapter's fused path (`_contract_to_info`) projects the kernel sections onto
the engine's own types: `risk` as is; `attack`'s five endpoint-level fields into
`EndpointAttackContract`; each `field_hints["zone.field"]` — in
`StrategyMode.HACKER` only, since the default profile rejects hacker contracts —
promotes the addressed parameter or dotted body field to a
`HackerStrategyContract` carrying the hint's profiles and toggles (a nested body
path re-types its ancestors as knob-less containers; an unset toggle is left out
so the engine's default applies); and each `transitions` entry is re-bound to
the deterministic `StateProduction` whose bundle name, or `response_field` leaf,
matches its `bundle` — exact name first — and appended to the deterministic
`StateLinkContract`. `semantic_properties` are validated for field references
and carried through.

Failures are typed and stop the run before any request: a hint on an undeclared
zone or field, or a transition with no match or an ambiguous one, is an
`UnsupportedSchemaConstructError` naming the endpoint and the offending key; a
fixture that fails to load, a duplicate for one endpoint, a contract served for
another endpoint, or a fusion the Contract Engine rejects is a
`ContractProducerError(source, detail)` (JSON error code
`fuzz_contract_producer`).

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

## Tests

Tests live under `tests/`, grouped into subpackages that mirror `src/`
(`config/`, `ui/`, `services/`, `repl/`). Setup and test commands are in
[Contributing & Testing](contributing.md#exceptions).
