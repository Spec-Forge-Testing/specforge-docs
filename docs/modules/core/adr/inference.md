# Core — Decision records — Inference

Part of the [Core decision records](index.md). Decisions about how the core
produces a run's contracts with a model: when a produced contract is used, how
inferences are cached, how spend is approved and capped, and how production is
watched and stopped. The mechanism is described in [Inference](../inference.md).

---

## ADR-098 — A produced contract is adopted only if it names, fuses and projects for its endpoint { #adr-098 }

**Status:** accepted · `services/fuzz/adoption.py`, `services/fuzz/production_loop.py`, `services/fuzz/models.py`

### Context

A model answers with a contract that is valid against the kernel's model but may
still be wrong for the endpoint it was asked about: it may name another route,
contradict the OpenAPI definition it is fused onto, or use a construct the engine
cannot compile. Failing the run on one such answer throws away every other
endpoint's contract, already paid for. Ignoring the bad part silently fuzzes an
endpoint under rules nobody checked.

### Decision

A produced contract passes three checks in order before the engine sees it: its
`method` and `path_url` name the endpoint, it fuses onto the endpoint's
definition, and the fused result projects into what the engine compiles. A
failure leaves the endpoint in `producer_exclusions` with its reason, and the run
goes on. The endpoint runs schema-only, unless the contract was validated and
declared a risk flag: then it is withheld, never fuzzed as a target, and its flag
still vetoes its route. A failure before any validated contract exists — an
inference error, an invalid output, an untraced handler, the cost cap — is
schema-only. The fixture producer, an explicit request, aborts instead.

### Rejected

Failing the run on the first unusable contract, which makes one bad answer cost
every endpoint. Fuzzing every failed endpoint schema-only, which would send
writes to a route whose own contract said it has side effects. Trusting the
model's identity and fusing whatever it returns, which can attach one endpoint's
rules to another.

### Consequences

An inference run always reaches the engine with what could be used, and the run
says per endpoint what it did without the rest
([`disposition`](../protocol/vocabularies.md#producer-exclusion-disposition)).
The cost is a third disposition every reader of a run branches on, and coverage
counting a withheld endpoint as `excluded`.

---

## ADR-099 — The inference cache is a proxy in front of the model, keyed by what shapes the prompt { #adr-099 }

**Status:** accepted · `services/fuzz/producers/cache/`, `services/fuzz/producers/inference_factory.py`; storage `inferred_contracts`

### Context

An inference costs money and seconds, and two runs over unchanged code ask the
same question. A cache keyed loosely — by endpoint, or by endpoint and model —
serves a stale contract after a template, the spec, the kernel or the traced
code changed. A cache the producer consults by hand at each call site has as many
rules for "is this still valid?" as it has callers.

### Decision

A caching engine wraps the inference engine behind the same interface: it looks
the request up before the model is asked and stores every fresh answer under its
key as soon as it arrives. The key is the SHA-256 of a canonical document holding
the agent profile, the partial-context flag, the kernel version, the method, the
path, the endpoint's OpenAPI definition, the prompt fingerprint, the state hints,
and the system context with its paths made relative to the repository root.
Entries live in the store, global across projects. `producer.refresh` skips the
lookup and replaces what it infers; an entry the current kernel cannot parse
counts as absent.

### Rejected

A key of endpoint and model, which survives edits that change the answer. A
time-to-live, which expires valid entries and keeps invalid ones. A per-project
cache, which pays twice for the same handler. Keying on absolute paths, which
makes the same code miss on another machine.

### Consequences

A second identical run asks the model nothing, and any edit that changes the
prompt invalidates exactly the entries it touches. The run reports
`contract_cache {hits, misses}`. A change to how a prompt is rendered that edits
no template does not move the key, so such a change goes with a template edit.
The key is also what an approval names ([ADR-100](#adr-100)).

---

## ADR-100 — No inference without an approved estimate, and a predictive cap { #adr-100 }

**Status:** accepted · `services/fuzz/producers/cost/`, `services/fuzz/estimate.py`, `services/config/definitions.py`

### Context

A run with the inference producer spends money on a provider's account, and how
much depends on what the cache already holds. A client that starts such a run
should know the price first and agree to it, and the agreement must not carry
over to a different run. A limit on spend that is only checked after each call
lets a run pass it by however much the calls in flight cost.

### Decision

`estimate_inference` builds the same plan a run would — trace, key, look up,
price the pending prompts — and calls no model. Its `approval_token` is the
SHA-256 of the sorted cache keys of the pending inferences. While
`inference.require_approval` is on, a run with inferences to pay for is refused
`INFERENCE_APPROVAL_REQUIRED` (`missing` or `stale`, with the estimate) unless it
carries the token of exactly its own pending set; a run the cache answers whole
needs none. `producer.max_cost_usd` is predictive: each inference is admitted
only if what was spent plus the estimates still held, plus its own, stays within
the cap; when it does not fit, admission waits for the inferences in flight and
decides on the actual spend. A cap on an unpriced model is refused when anything
is still pending: without a price nothing can be compared to it.

### Rejected

A confirmation flag with no content, which approves whatever the run turns out
to send. A token over the selection or the price, which survives a code edit
that changes what is sent. A cap checked only on actual spend, which overruns by
every call in flight. A default model or a default budget, which spends money on
a choice nobody made.

### Consequences

Nothing is paid for without a matching estimate, and an approval goes stale the
moment the pending set changes. `run.inference_cost` records `estimated` beside
`actual`, `null` when a cost is unknown, never `0`. With several workers the cap
can admit up to `inference.max_workers − 1` more inferences when one in flight
pays above its estimate; `actual` shows what they cost.

---

## ADR-101 — Production is visible, bounded and cancellable, and a cancelled production leaves no run { #adr-101 }

**Status:** accepted · Supersedes in part [ADR-072](core.md#adr-072) · `services/fuzz/production_loop.py`, `services/fuzz/production.py`, `services/fuzz/observer.py`, `controllers/execution/running.py`

### Context

Producing the contracts of a large selection one after the other takes minutes
before the engine sends its first request, and a client watching the run sees
nothing in that time and cannot stop it short of killing the process. Running
every inference at once overruns provider rate limits and writes the provider's
prompt cache once per call instead of once. A run cancelled before the engine
started has no evidence to keep, so the rule that a cancelled run is persisted
does not fit this phase.

### Decision

Endpoints are admitted in selection order onto a pool of
`inference.max_workers` workers (default 4, at most 16). The first inference
whose estimate writes the prompt cache leads: it runs alone, and the rest start
after it. Each endpoint emits `contract_started`, then `contract_finished` or
`contract_failed` with its disposition. A cancellation during production starts
no new inference, lets the ones sent finish and reach the cache, and ends the
operation: `fuzz` answers `cancelled` with no `run`, and `run_pipeline` marks its
`inference` stage `stopped`. `run.production_duration_ms` times the phase apart
from the engine run.

### Rejected

One unbounded pool, which trades rate-limit failures for speed. Strictly
sequential production, which keeps the minutes of silence. Persisting an empty
run on a cancellation during production, which records a run that sent nothing.
Dropping inferences in flight on cancel, which pays for answers and throws them
away.

### Consequences

A client shows production as it happens, pairing events by endpoint because they
end out of order. A cancellation can take as long as the slowest inference in
flight, and what was paid for serves the next run from the cache. The spend is
`run.inference_cost.actual`, never a sum of event fields. On a run cancelled
after production, [ADR-072](core.md#adr-072) still applies.
