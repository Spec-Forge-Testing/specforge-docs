# Core — Reference

This page details the core's internal design: the layers and the one-way rule,
how the operation catalog is derived, the session, the busy guard, the
dependency gateways, the doctor, the fuzz seam, and how errors carry their
codes. What a request looks like on the wire, and why the core is shaped this
way, are covered by the pages linked from the [module overview](index.md).

## Layers and the one-way rule

The core is ordered like a web API: a request enters at the façade, descends
through the layers, and nothing jumps a step.

| Layer | Responsibility | Does not |
| --- | --- | --- |
| `adapters/` | The only layer that knows a transport exists — framing, the JSON-RPC envelope, the handshake, the dispatcher, the server. | Hold any pipeline logic. |
| `facade/` | Signatures only, delegating to controllers: the readable list of what a frontend can call. | Contain logic. |
| `controllers/` | One thin function per operation — call services, project the result onto `models/`. | **Call another controller.** |
| `services/` | All the logic, no rendering. The only layer that imports `storage`. | Print, or know about a transport. |
| `schemas/` | Deliberately inert input objects. | Build responses or hold reusable logic. |
| `models/` | Response DTOs and the projections that build them. | Carry input. |
| `errors/` | One class per failure, each owning **both** its codes. | Let the transport decide a code. |
| `domain/` | The state and rules that cross every layer: `Session`, events, endpoint numbering, the live-operation registry, cancellation. | Be input or output. |
| `config/`, `utils/` | Typed definitions; constants and helpers. Leaves of the import graph. | Import another layer. |

The rule that a controller **never calls another controller** is what keeps the
layering honest: when two operations need the same work, that work lives in a
service both reach. `run_pipeline` is the case that proves it — composing four
stages is logic, so the composition lives in `services/pipeline/` and the
controller reads as a single call.

## The façade is the published surface

`facade/` holds signatures and nothing else: it exists so the surface reads at a
glance instead of being deduced from whichever functions ended up public across
several modules. Each façade module is a **family**, and its `__all__` is the
family's operations.

Two decorators annotate a façade function without wrapping it — they only
**label** it, so the catalog derivation still sees the real signature:

- `@requires(...)` records the operation's `Precondition`.
- `@switches_project` marks the two operations that replace the active project.

!!! tip "Adding an operation"
    Add a function to a `facade/` module with its type-hinted parameters, a
    docstring, and its `@requires`. It appears on its own in the catalog, the
    completer and the help — there is no second list to update.

## The catalog is derived, never written

The catalog service walks `facade/` module by module. The module is the
**family**; each exported function becomes an `Operation` built from its own
signature and docstring:

- parameters and their types come from the signature, minus the three
  **protocol parameters** `session`, `progress` and `cancel`, which the wire
  supplies and the catalog hides;
- `emits_progress` is true when the function accepts `progress`;
- `cancellable` is true when it accepts `cancel`;
- `requires` is whatever `@requires` recorded, defaulting to `Precondition.NONE`.

Because there is no hand-written second list, the catalog cannot drift from the
code. `describe` publishes it, and the handshake embeds the same catalog.

## Preconditions

An operation declares the readiness it needs. The set is closed:

| `Precondition` | Meaning |
| --- | --- |
| `NONE` | Callable with nothing open. |
| `PROJECT` | A project must be open. |
| `CONTRACT` | A contract must be loaded — which implies a project. |

## The session

The core holds **one active project at a time** and replaces it wholesale on a
switch. The `Session` carries the project root, what its `specforge.toml`
declares, the parsed and numbered contract, the connection to the store, and the
repository caches. Two locations matter and are not the same: `data_dir` is the
project's own files under `.specforge`, while `database_path` is the **central
store shared by every project** — a project has no database of its own.

## The busy guard

Switching or closing the active project while work is in flight would corrupt
that work, so the server registers in-flight operations and refuses a switch
while any are alive. The registration is selective:

- an operation that takes no `session` is never registered;
- an operation that itself switches the project (`open_project`,
  `close_project`) is never registered — otherwise it would block itself;
- every other operation registers under the request `id` that started it and
  releases however it ends.

A switch attempted while the registry is non-empty is refused with
`PROJECT_SWITCH_REJECTED`, whose data lists the operations still running.

## Dependency gateways

The core boots even when any of its six pipeline libraries is absent —
`storage`, `specforge_engine`, `contract_assembly`, `core_ast`, `ai` and
`specforge_contracts`. Each is imported by **exactly one** module: its gateway
under `services/deps/`.

- A gateway owns the single answer to *"is this installed, and if not, why?"* —
  a `Dependency` value object that is either present or absent with a textual
  reason — and the symbols the core uses from that library.
- Whoever needs the library asks the gateway and raises its **own** typed error
  when it is absent; nobody else wraps an import in `try/except`.
- A library that **raises while importing** counts as absent: an `ImportError`'s
  message is carried through verbatim, any other exception is named by its type.
- Gateways are leaves of the import graph and answer once per process, so a
  library installed while the core is running is only seen after a restart.

Single ownership is not a convention but a test: a suite walks the AST of `src/`
and fails if any library is imported outside its gateway, with its few named
exceptions.

## The doctor's three verdicts

`doctor` reads each component's gateway and tells three states apart:

| Verdict | When | What it says |
| --- | --- | --- |
| Healthy | The library is present. | Nothing to do. |
| Failed | The library is missing. | The import failure's reason, so the fix is actionable. |
| Restart required | The library imports now but the process started without it. | *"{library} is installed, but this process started without it"*, remediated by *"Restart Spec Forge to load it"*. |

The last verdict exists because a gateway answers once per process: a library
added in place reads as blocking as a missing one until the core is restarted.

## The fuzz seam

`services/fuzz/` is the one place that knows both Contract Assembly and the
engine. It loads and selects endpoints, optionally asks a **contract producer**
for each endpoint's enriched contract, and hands everything to the engine. The
producer's failures are handled by intent: a producer that cannot honor an
explicit request aborts the run, while an inference producer that cannot enrich
one endpoint soft-drops it rather than failing the whole run. When a targeted
endpoint draws no requests, the run records **why** as an `unprobed_reason`, so
the report can tell a by-design skip from an endpoint it never reached. The run
itself — its modes, budgets and oracles — belongs to the engine; see
[Execution modes](../specforge-engine/execution-modes.md).

## Errors carry both codes

Every failure is a class under `errors/`, grouped by *what* failed, and each
class carries **both** codes the protocol needs — the integer JSON-RPC `code`
and the stable string in `error.data.code` — and builds its own `error` object,
so the transport decides nothing. The alternative, a translation table in the
adapter, desynchronizes the first time someone adds an error and forgets the
other file. The same registry backs the machine-readable error codes a frontend
can enumerate, so the protocol and any other surface never disagree.
