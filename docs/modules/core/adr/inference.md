# Core — Decision records — Inference

Part of the [Core decision records](index.md). Decisions about how the core
produces a run's contracts with a model: when a produced contract is used, how
inferences are cached, how spend is approved and capped, how production is
watched and stopped, and what each rule a model gives rests on. The mechanism is described in [Inference](../inference.md).

---

## ADR-098 — A produced contract is adopted only if it names, fuses and projects for its endpoint { #adr-098 }

**Status:** accepted · Extended by [ADR-201](#adr-201) · `services/fuzz/adoption.py`, `services/fuzz/production_loop.py`, `services/fuzz/models.py`

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

**Status:** accepted · Superseded in part by [ADR-197](#adr-197) · `services/fuzz/producers/cost/`, `services/fuzz/estimate.py`, `services/config/definitions.py`

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

---

## ADR-197 — The cost cap holds an inference's worst case { #adr-197 }

**Status:** accepted · Supersedes in part [ADR-100](#adr-100): what the cap holds · Supersedes in part [ADR-092](../../llm/adr/llm.md#adr-092): re-asks and fallbacks are estimated · `services/fuzz/producers/cost/`, `services/fuzz/estimate.py`, `services/fuzz/producers/inference.py`, `lib/llm/src/llm/estimation/`, `lib/semantic_inference/src/ai/engine.py`

### Context

The cap admitted an inference against its estimate: one answer, on the primary
model. A contract call may be re-asked twice on a model when its answer cannot be
parsed or validated, and then move on to every fallback model of the chain. One
admitted inference could therefore spend about three times its estimate on the
primary model alone, and more with each fallback, none of it counted when it was
admitted. The estimate also assumed one output length for every profile, below
what either profile produces.

### Decision

**The worst case is priced with the estimate.** An inference's worst case is
every re-ask on every model of the chain, the primary first, each at the
expected answer length and resending the rejected answers with their validation
errors. `estimate_inference` reports it as `worst_case_cost_usd` beside the
expected `cost_usd`, and `exceeds_cap` judges the worst case.

**The cap reserves the worst case at admission.** An inference is admitted only
if what was spent, plus the worst cases still held by the inferences in flight,
plus its own, stays within `producer.max_cost_usd`. A settled inference replaces
its hold with what it really cost. An endpoint the cap refuses runs
schema-only, as before.

**A cap needs a priced worst case.** A capped `fuzz` or `run_pipeline` whose
pending inferences have no price on some model of the chain, a fallback
included, is refused `INVALID_PARAMS` naming that model, before any inference.

**The expected output is measured per profile.** `EXPECTED_CONTRACT_OUTPUT_TOKENS`
holds one value per profile, the mean output of a measured sample of live
inferences: `qa` 656 tokens, `security` 928.

### Rejected

- **Refusing the whole run when its worst case passes the cap.** A cap trims a
  run to what it can pay for and runs the rest schema-only; that is the
  documented contract of `producer.max_cost_usd`, and refusing the run would
  change it into an all-or-nothing gate.
- **A strict bound: `max_tokens` on every call and a reservation per attempt.**
  It makes the worst case a ceiling, but it truncates long contracts and moves
  admission into every attempt of the LLM client. It is a redesign of the cost
  contract, not a correction of what the cap holds.

### Consequences

The same cap admits fewer inferences, and more endpoints of a capped run run
schema-only, listed in `producer_exclusions` and named `contracts_unproduced` in
the run's signal. An approval figure now shows both the expected cost and what
the run may cost if the model has to be asked again. The worst case is not a
strict ceiling: it assumes the expected answer length, so an answer longer than
that, or a transport retry, can still spend past it; `run.inference_cost.actual`
records what was spent.

---

## ADR-201 — A model's rule is stated only when its quote is found in what the model was shown, and a keyword's quote is about that keyword { #adr-201 }

**Status:** accepted · Extends [ADR-098](#adr-098) · `services/fuzz/grounding/`, `services/fuzz/adoption.py`, `services/fuzz/producers/inference.py`, `services/fuzz/producers/fixture.py`, `services/fuzz/projection/grounds.py`; kernel `specforge_contracts.grounds`; `contract_assembly/fusion/merger.py`; `semantic_inference` `prompts/templates/partials/grounds.j2`

### Context

A model reading a handler gives two kinds of rule. Some the code or the
operation states: a guard `if len(password) < 12`, a rejection message, a
sentence of the description. Others nothing states: the model assumes them from
what the field means, a quantity ordered is at least one, a date of birth is not
in the future. Both are worth sending, since an API that does not enforce a rule
its owner wants is a bug only the model can point at. But a finding against the
second kind says only that the server does not do what the model guessed, and a
reader has to know which kind of rule a finding stands on before treating it as
a defect.

The model's own word cannot settle that. A model asked to say whether a rule is
stated says so for rules it made up, and quotes text that is not there.

### Decision

**Each rule carries its grounds.** A schema keyword (`minimum`, `maximum`,
`minLength`, `maxLength`, `minItems`, `maxItems`, `pattern`, `format`, `enum`,
`required`), a business rule, the access policy and a seed case's `expects` each
carry `grounds`: `{basis: "stated", quote}` or `{basis: "assumed"}`. The kernel's
`Grounds` rejects a quote on an assumed rule; a quote is at most 200 characters.

**The core checks the quote, not the model.** `ModelGrounding` looks for the
quote in what the model was shown, in order: the code blocks of the prompt
context (the handler first, then its dependencies, types and file), then every
key and string of the operation. The comparison folds what a model copies
differently (Unicode compatibility forms, typographic quotes and dashes, runs of
blanks, case, a wrapping quote or backtick) and needs at least 8 non-blank
characters, so a quote points at one place. A quote found keeps the rule
`stated` and records where it is: `{kind: "code", file, function, start_line,
end_line}`, the lines counted from 1 in the analysis' tree, or `{kind: "spec",
pointer}`, a JSON Pointer into the operation.

**A rule the model calls stated and cannot back is taken as assumed.** Without a
quote it is `downgraded` `no_quote`; with a quote nowhere in what it was shown,
`quote_not_found`. Either way the producer notes it (`producer_notes[].kind`
`unverified_quote`) and the rule stays in the contract.

**A keyword's quote must be about that keyword.** A quote found in the code can
still be about something else: a model grounding `minLength: 8` on `title` in a
line that checks `password`. For a schema keyword, the quote holds the rule only
when it names the keyword's field (its words in a row, or an identifier spelling
it, `snake_case` and `camelCase` split), sits in a place that names it (the function
or the spec pointer it was found in), or carries the keyword's value: a number
within `BOUND_TOLERANCE` (1) of a bound (`len(x) < 12` states `minLength: 12`),
the pattern or one of its counts, an `enum` member, the format's name. Otherwise
the rule is taken as assumed, `downgraded` `quote_unrelated`, and noted
`unverified_quote`. A keyword of a body with no field name is never ruled out. A
business rule, an access policy and a seed case's `expects` are checked for being
found, not for relevance: their quotes rarely spell one field.
**An assumed keyword never replaces a declared one.** Fusion keeps the keyword
the specification declares on the same field, and notes the model's
(`assumed_over_declared`). A keyword the specification already declares with the
same value needs no grounds.

**An author's contract is taken at its word.** `DeclaredGrounding` grounds a
`fixture` contract: a rule without grounds is `stated`, and its origin is
`{kind: "fixture", file, pointer}`, where the file writes it. A contract that
grounds nothing at all (an inferred contract cached before grounds existed, or a
model that gave none) gets no grounds, and its findings read as they always did.

### Rejected

- **Trusting the model's `basis`.** It is the claim under test; a quote that is
  not in the code is the most common way a model overstates a rule.
- **Dropping assumed rules.** They are the rules no other source gives. The
  prompt asks for them generously, and the run reports what they find apart
  ([ADR-202](../../specforge-engine/adr/findings.md#adr-202)).
- **Checking every rule for relevance.** A business rule or an access check is
  quoted from a guard that compares several fields or none by name; a relevance
  test would downgrade the very rules a quote states best.
- **A fuzzy match on the quote.** A near match finds a line that says something
  else; the folding covers what copying changes and nothing more.

### Consequences

A finding's `grounds` says what its rule rests on and where to read it, and
`inspect_finding_source` answers `rule_source`, the file and lines, so a client
opens the code at the rule in one call. A rule taken as assumed is visible
twice: in `grounds.downgraded` on every finding citing it, and in the run's
`producer_notes`. The prompt grows by its grounds section, so every cached
inferred contract is inferred once more on its endpoint's next run.
