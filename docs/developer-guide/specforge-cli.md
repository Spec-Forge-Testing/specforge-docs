# Working on the Spec Forge CLI

This page is for changing **`specforge-cli`**, the client that ships to users. For what it does
for them, see [Spec Forge CLI](../user-guide/specforge-cli.md); for what it talks to, the
[protocol](../modules/core/protocol/index.md). The CLI lives in its own repository and imports
nothing from the core: everything it knows about an operation comes from the catalog the core
publishes in its handshake.

## How it is organised

```text
src/specforge_cli/
├── __main__.py        # routing only: update, delete, credentials, one-shot or interactive
├── cli/               # the command-line modes: one-shot, interactive, argv parser, CI outcome, `--fix`
├── startup/           # which core to launch, startup timeout, clean exit on SIGTERM
├── maintenance/       # looking after the install: credentials, update, uninstall
├── protocol/          # the client: transport, handshake, requests, events, cancellation
├── catalog/           # the core's catalog: models, validation, completion, local commands
├── session/           # what the REPL and the TUI share: controller, parsing, history, header
├── repl/              # the text interface: a line reader over the session controller
├── tui/               # the full-screen interface (see below)
├── approval/          # confirmations: destructive calls, inference cost, replay, applying a fix
├── shell/             # the `!<command>` escape
├── views/             # operation results, error codes and progress events as terminal output
└── ui/                # theme, design tokens, components, banner
```

Two rules keep it this way. Dependencies point one way: `protocol` and `catalog` know nothing
of the interfaces, `session` knows nothing of which interface is on top, and `views`/`ui` only
render. And the CLI never declares an operation or a flag by hand — a new core operation
completes, validates and gets a `--flag` without a CLI release.

### One session, two interfaces

`session.SessionController` is everything a session *does*: it decides what a line is (a local
command, a system command or an operation), validates it against the catalog, asks the
approver, sends it and reports what happened to a **surface**. The text REPL
(`repl/`) and the full-screen interface (`tui/`) are two surfaces over the same controller, so a
behaviour added to the controller reaches both.

The full-screen interface is built in layers, each testable alone:

| Package | Role |
| --- | --- |
| `tui/terminal/` | The gate (`SPECFORGE_TUI`, `SPECFORGE_MOUSE`), window title, prompt glyph, clipboard. |
| `tui/model/` | The transcript: header, blocks (one per typed line), their items and snapshots. No terminal in it. |
| `tui/render/` | Turns a snapshot into lines for a given width: capture of the Rich output, the `└` branch, `×N`, the live activity line. Pure. |
| `tui/layout/` | The prompt_toolkit application: transcript control (scroll, selection), the input between two rules, the command menu, the notice, key bindings. |
| `tui/screens/` | Panels and viewers that sit over the conversation: `help`, the long-table viewer, and the stack that opens and closes them. |
| `tui/runtime/` | `TuiSession` and the surface that connect the controller to the model. |

## Adding things

### A local command (like `help` or `clear`)

Add a `LocalCommand` to `LOCAL_COMMANDS` in `catalog/commands.py` — its names, usage, one-line
summary and whether it takes arguments or runs alone — and handle it in
`session/controller.py`. The menu, `help`, the "did you mean" notice and the line classification
all read that one list, so nothing else needs to learn about it.

### How an operation's result looks

Results are rendered by **views** registered per operation, never by a branch:

```python
from specforge_cli.views.registry import register_view

@register_view("list_runs")
def _list_runs(runs: list[dict]) -> None:
    ...
```

An operation with no view still renders, as a plain dump. Put the view in the module of its
family under `views/` (`views/results/` has one module per kind of record: runs, findings,
comparisons, retention…) and make sure the package imports it. Errors register with
`register_error_view("CODE")` and progress events with `register_event_view("kind")` in the
same way. A view prints with the helpers of `ui/` (`show_rows`, `key_values`, `heading`…) and
never touches stdout directly, so it works in every interface and in `--json-output`.

### How a result gets what it needs to be read

A view only draws the result it is handed, so a fact the core did not put in it is fetched
before drawing, by `session/enrichment.py`, for the REPL, the full-screen app and a one-shot
call alike. Today that is the model in use beside a `list_llm_models` listing (the
`llm.primary_model` option, read with `get_config`), the configuration as it was before a
`set_config` or `reset_config`, and the finding an applied fix was for (read with `get_finding`,
so the next steps can name the endpoint to run again and the run to compare against). It is an extra: if the core cannot answer it, the result is
drawn without it. `--json-output` never gets it, and the extra request is not made.

### How an approval leads to the next step

Anything that must be asked before it happens is an `ApprovalRequest` (`approval/request.py`):
the `operation` to send once approved (which need not be the one that produced the request),
its `retry_params`, the `question`, and a `show` that draws what is being approved. Three flags
say who may answer it: `needs_spending_cap` (money is at stake, so an answer given up front is
valid only under a cap), `explicit_flag` (it must be asked for by its own flag, as with a
replay's side effects) and `needs_person` (only someone looking at the question; not even
`--yes` stands in). `decide()` is the one place those are enforced.

A request comes from one of two places, and which one is the design decision when adding a step:

- **A detector in `approval/`**, when the core's own answer asks for it. Each is a pure
  `request_from(operation, params, error, result)` returning a request or `None` — `cost.py`
  (the core refused a paid call and sent its estimate), `fixes.py` (a proposed fix that has
  files to change and is not applied), `consent.py` and `overwrite.py`. `detect()` in
  `negotiation.py` tries them in order, on a refusal and also on a result that succeeded, so
  a detector can answer a good result with the next step. Register a new one there.
- **An offer in `session/offer.py`**, when the CLI is the one proposing, because nothing was
  refused. `fix_offer(operation, result, request)` reads a run that found a server error, asks
  the core for the finding's price (an extra request, like `enrichment`, silent if it fails) and
  returns the same `ApprovalRequest`, which the controller holds for `approve`. It stays out of
  `detect` on purpose: `detect` also runs in a one-shot call, and a one-shot
  `estimate_finding_fix` has to stay a free read that asks nothing.

Sending is `run_with_approvals(send, operation, params, approver, on_result=…)` with
`send(operation, params)`: each time a request is approved it sends *that request's* operation,
so a chain (`estimate` → `propose_fix` → `apply_finding_fix`) is a loop of detect, decide and
send. `on_result` is given the result of a step that led to a question, before it is asked —
that is how `--fix` shows the diff before asking whether to apply it. The REPL does the same
with `approve`: the controller holds the request, and each `approve` sends one step, draws its
result and holds the next request.

`cli/fix_flow.py` is `--fix`: `misuse_of_fix` rejects, before anything is sent, a call that
could never finish (not `fuzz` or `run_pipeline`, or no one to ask), and `run_fix_flow` walks
the chain after the run was drawn. Declining any step is not a failure; a core error is.

Whatever touches the target uses `needs_person`. A step that writes to the user's code must
never be answerable by a flag, and a new one that does should say so the same way and add its
row to the table in the user guide.

### Explaining a section once

The words a view uses live in `views/vocabulary.py` (`problem`, `×N`, `possible problem`) next
to the sentence that explains each section (`About`), the next step after each error code
(`ERROR_NEXT_STEPS`) and which sections each operation explains (`OPERATION_SECTIONS`). A
session's `Explainer` (`views/guidance.py`) hands each view the sections it has not explained yet
when its result is created, and the view is drawn with that set (`render_result(…, explain=…)`),
so a window resized or a result drawn again says the same as the first time. Call
`heading(title, ABOUT_…)` for a section that explains itself; one the operation does not declare
in `OPERATION_SECTIONS` is explained every time.

### A panel or a viewer in the TUI

A screen is a small object the `ScreenStack` in `tui/screens/` shows over the conversation:
it draws itself, owns its keys and closes with `Esc`. Look at `table_viewer.py` for the
smallest one and `help.py` for one with tabs; open it from the controller through the surface
(`show_help` is the model) so the text REPL can answer the same request in its own way.

### A theme or a color

Colors are **tokens** (`success`, `error`, `muted`, `accent`…), never literal styles; a theme in
`ui/theme.py` maps each token to a color. Spec Forge's violet is the default theme's `accent`.
Add a theme by adding one more mapping and its name to the registry.

## Versioning and releases

The version has one source in code: `__version__` in `specforge_cli/__init__.py`, which the
banner shows. It must equal `version` in `pyproject.toml` — the release workflow compares the
tag against the latter, and a test fails if the two drift. The numbers follow
`MAJOR.MINOR.PATCH`; while the first is `0` the interface may still change between minors.

## Tests and checks

```bash
cd specforge-cli
python -m pytest -m "not real_core"      # the suite, against the core's recorded sessions
python -m ruff check src tests
python -m ruff format --check src tests
```

The recorded sessions come from the core's `protocol/fixtures`; when the core bumps the protocol
version they change, and `docs/operations.md` (generated from `describe`) must be regenerated
with `scripts/generate_operation_reference.py` — a test fails if it drifts. The `real_core`
tests start an actual core and run only where it is installed. The full-screen interface is
tested against a virtual terminal (`pyte`), so its tests need no real console; coverage of
`tui/` is expected to stay at 95 % or above.

No recorded session holds the fix flow, because an estimate carries a model's price and would go
stale. The shapes its tests use (`finding_estimate`, `finding_refusal` in
`tests/approval/estimates.py`) come from the core's code and were checked once against a real
core, so when the core changes `estimate_finding_fix`, `propose_fix` or `apply_finding_fix`,
that is where to update them.
