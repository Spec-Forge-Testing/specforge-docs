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
