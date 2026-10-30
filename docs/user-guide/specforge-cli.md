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
    one is documented on the [Core REPL Reference](cli-reference.md) page. This page
    is about the client that ships to users of the packaged tool.

## Running it

```bash
specforge                       # interactive: one core process, many operations
specforge <operation> [flags]   # one operation, then exit
```

With no arguments, `specforge` opens an interactive session against a freshly
started core: type an operation name, its flags, read the result, repeat. In a
capable terminal that session is the [full-screen interface](cli/interactive.md#the-full-screen-interface);
anywhere else it is a plain text [REPL](cli/interactive.md#the-text-repl) with the same commands.
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


## Choose a path

Use the page that matches what you want to do:

- [Interactive use](cli/interactive.md) ? the full-screen interface, text REPL, command syntax and interactive conveniences.
- [Scripts, CI and approvals](cli/scripts-and-ci.md) ? one-shot calls, machine-readable output, CI exit codes and approvals.
- [Fixing findings](cli/fixing-findings.md) ? proposing and applying fixes from the CLI.
- [Run Report](reports.md) ? how the CLI presents run results and the complete report model.
- [CLI operation reference](specforge-cli-reference.md) ? every operation, flag, default and CLI-specific rendering detail.

The [Core REPL Reference](cli-reference.md) is a different page under the Developer Guide. It documents the core's internal testing REPL, not this packaged client.
