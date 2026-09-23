# The core↔frontend protocol

The core is a black box: **no frontend imports anything from it**, not even the
CLI, which is the same language. Everything a frontend needs travels over one
line-delimited JSON channel. This section defines that channel; this page
defines how a message travels, the pages beside it define what the messages say.

| Page | Covers |
| --- | --- |
| This page | Transport, framing, the four message shapes, ordering, endpoint naming, payload policy |
| [Handshake and versioning](handshake.md) | `hello`, capabilities, the catalog, versioning and the changelog |
| [Events and cancellation](events.md) | The 13 event kinds, the progress token, state vs fact, `$/cancelRequest` |
| [Operations](operations.md) | The 31 operations by family, what each requires and emits |
| [Errors](errors.md) | The two codes per error and the 40 error codes |
| [Fixtures](fixtures.md) | Recorded sessions: how they are captured and how a client uses them |

## Transport and framing

**NDJSON over stdin/stdout**: one JSON object per line, UTF-8, separated by
`\n`. No header, no length prefix, no start marker. It works because JSON never
contains a raw line break — inside a string it is escaped — so every line is a
self-delimited frame and the reader is just `for line in stdin`.

Three non-negotiable rules:

1. **stdout belongs to the protocol, exclusively.** One stray `print` corrupts
   the stream, so the server claims the descriptor at startup and sends any
   loose write to stderr.
2. **stderr stays free** for logs and tracebacks. A crash never dirties the
   channel.
3. **Backpressure.** If the frontend stops reading, the pipe fills and the core
   blocks on write. A client must always be reading, on a thread or task
   separate from rendering.

**Order is guaranteed.** Being a single pipe, messages arrive in emission
order: all of an operation's notifications arrive **before** its response. The
frontend never reorders anything.

> **A trap for a future non-Python client.** Go's `bufio.Scanner` cuts off at
> 64 KB per line, and payloads reach ~99 KB. A streaming decoder is required.

## Semantics: JSON-RPC 2.0

NDJSON says how messages are separated; **what they say** is JSON-RPC 2.0. Four
shapes, and no more:

| Shape | Direction | Structure |
| --- | --- | --- |
| Request | client → core | `{"jsonrpc":"2.0","id":N,"method":"…","params":{…}}` |
| Response ok | core → client | `{"jsonrpc":"2.0","id":N,"result":{…}}` |
| Response error | core → client | `{"jsonrpc":"2.0","id":N,"error":{"code":I,"message":"…","data":{…}}}` |
| Notification | both | `{"jsonrpc":"2.0","method":"…","params":{…}}` — **no `id`** |

**Batching is not used.** A core that receives an array answers
`-32600 Invalid Request`; the surface is left narrow on purpose.

**The `id` is chosen by the client and never reused across the whole session.**
Integer or string; the core returns it verbatim. Reuse looks harmless and is
not: cancellation travels by `id`, so a reused id would let a delayed
`$/cancelRequest` cancel the wrong operation. A counter that only goes up avoids
this entirely.

**Every operation is request/response, short or long.** A long operation has no
distinct shape: it emits notifications while it runs and ends in its response —
from success, an error, or cancellation. The frontend has one read loop and one
way to correlate.

## How an endpoint is named

Two forms, discriminated by JSON type; operations accept both, and both always
come back in results so the frontend never translates:

- **String** — the canonical identity `"{METHOD}:{path}"`, e.g. `"POST:/articles"`:
  the engine's own key and the one storage saves under. A graphical frontend
  sends this — it clicks a row, it never types.
- **Integer** — the short number, so a person can type `detail 12` instead of
  the full identity.

```json
{"number": 12, "id": "POST:/articles"}
```

**In events, `number` is absent only when the run's catalog does not number
that endpoint** — a contract reloaded between compiling and running. `id` still
travels: painting a finding by id beats dropping it. The number is assigned by
the core in deterministic order and is never renumbered when filtering.

## Payload policy

| Size | How it travels |
| --- | --- |
| Up to the threshold | **Inline**, in the `result` |
| Above it | **Id + pagination** — the large result stays on the core, the message carries an id and a summary, the frontend requests the parts it will show |
| Large artifacts | **File path** — the core writes the file and sends its path; zero copies through the pipe |

The file handoff has a fixed shape:

```json
{"path":"/…/payload.xml","bytes":184320,"media_type":"application/xml"}
```

This is only valid because both processes are local and share a disk — part of
why stdio was chosen over the network. The threshold is **read from the
handshake** (`capabilities.payload.inline_max_bytes`), never hardcoded.

**Hygiene.** Anything with an id is cached client-side and never resent — safe
because objects with an id (runs, traces) are immutable once created. **No
credential ever comes back**: not in a response, an event or a log — not a
provider key, not a base URL's userinfo.
