# Spec Forge Engine — Decision records — Sessions

Part of the [Spec Forge Engine decision records](index.md). Decisions about the
credentials a run sends: how it tells a dead credential from a refused request,
how it renews a declared session, what it does with the operations that end one,
how it keeps the secrets it learns out of what it stores, and what it confirms once
an identity is lost. The behaviour is described in
[Identities and sessions](../sessions.md),
[Operations that end the session](../session-endings.md) and
[Secrets a run knows](../run-secrets.md).

---

## ADR-224 — A credential is judged on a witness: a streak of `401`s sends a request it once passed, and only that request's refusal retires the identity { #adr-224 }

**Status:** accepted · `constants.py`, `runtime/sessions/answer.py`, `runtime/sessions/check.py`, `runtime/sessions/witness.py`, `runtime/sessions/watch.py`, `runtime/sessions/watched.py`, `runtime/sessions/cut.py`, `models/runtime/sessions.py`; in the core, `services/fuzz/identity_check.py`

### Context

A credential that stops working mid-run turns every later request into a `401`.
A run that kept sending it would spend its budget, and report the endpoints behind
the access check as tested when nothing past it was reached. The opposite mistake is as
costly: a fuzzed request is refused with `401` for reasons that have nothing to do
with the credential (a malformed header the target reads as a bad token, a route
that authenticates differently), and an identity retired on such answers loses the
rest of the run for nothing.

The same doubt holds before the run: unchecked, an identities file with a stale
token shows up only as a run whose every authenticated endpoint answered `401`.

### Decision

**A response is read for what it says about its credential.** On an endpoint that
requires authentication, a `401` refuses the credential; a `2xx`, `3xx` or `403`
shows the target knows the caller, since a `403` forbids the action, not the
credential; anything else, `5xx` and `429` included, says nothing.

**Each identity is checked before the first request on a witness:** a safe read
that requires authentication and takes no input, preferably one whose path names
the caller (`/me`, `/account`). Up to three candidates are tried. A run whose
identity every candidate answers with `401` is refused before it sends anything
(`IDENTITY_REJECTED`); an identity no candidate could judge goes in `unchecked`,
with the reason. A run with a producer is checked before its contracts are
produced, so a stale token costs no inference.

**During the run, five `401`s in a row send the witness again.** Only its answer
decides: refused, the identity is retired (or renewed, [ADR-225](#adr-225)); alive,
the endpoints of the streak are exempt from that identity's streaks, their `401`
being about the request; no verdict (a `3xx`, which may lead to a sign-in page
the client does not follow, a `5xx`, a `429`, no answer), nothing changes. An
identity without a
witness learns one from the first safe authenticated read the run gets a `2xx`
for, and is never retired before it has one.

**A retired identity sends nothing more, in any mode**, and once no identity is
left the run stops exploring with the cut `credentials_lost`, rather than go on
anonymously. The run names as the suspect the identity's latest successful write
sent before the streak, or any identity's when it sent none, and announces the loss as a `credential_lost` event.

### Rejected

- **Retiring on the streak alone.** A run of `401`s from one endpoint that checks
  credentials differently would retire a working identity. The witness costs one
  request and settles it.
- **Taking a witness's redirect as proof the credential lives.** A read that
  requires a login and redirects may be sending the caller to sign in; counting
  it alive would keep a dead credential for the rest of the run.
- **Treating `403` as a dead credential.** A `403` is the target saying it knows
  the caller; reading it as a refusal would retire every identity the first time
  the run probes an endpoint it may not use, which is most of what an access test
  does.
- **Sending the rest of the run anonymously.** The run would report, under the
  identities' names, results no identity produced, and an access check would see
  an anonymous success where it expects an authenticated one.
- **Checking only when the run starts.** A run with a producer would pay its
  inference before learning the identities file is stale.

### Consequences

A dead credential costs at most a streak of five requests and a witness before the
run stops spending on it, and a run whose every identity died says so with
`credentials_lost` instead of a run of `401`s. The witness requests are counted
apart, as `session_requests`, never in `total_requests` nor in the trace. A
credential the target refuses only on some endpoints keeps its identity. An API
with no safe authenticated read that takes no input gives no witness: its
identities run `unchecked` and are never retired.

## ADR-225 — An identity may declare its login: the run logs it in, binds the credential on every attempt, and renews it when its witness is refused { #adr-225 }

**Status:** accepted · `models/runtime/login.py`, `models/runtime/execution.py`, `runtime/sessions/login.py`, `runtime/sessions/credentials.py`, `runtime/sessions/watch.py`, `runtime/http/orchestrator.py`, `runtime/replay/renewals.py`, `models/runtime/trace.py`

### Context

A token pasted into the identities file expires, and a fuzzed logout revokes it.
Retiring the identity ([ADR-224](#adr-224)) stops the waste but loses the rest of
the run. The identities file is also the wrong place for a short-lived token: the
user would have to log in by hand before every run.

### Decision

**An identity may declare a `login`**: the request that issues its credential
(method, path relative to the base URL, body, media type), where the answer
carries the token (`token_at`, a dotted path in the JSON body, or `token_cookie`),
and the header it is sent in (`send_as`, by default `Authorization: Bearer
{token}`). The run sends every login before its first request, in every mode; a
login that answers other than `2xx`, or without a token, refuses the run with
`IDENTITY_REJECTED`.

**When the witness is refused, an identity with a login logs in again** and the
witness is re-sent with the new credential; only if that one is refused too is the
identity retired. An identity is renewed at most fifty times in a run.

**The credential is bound to each attempt as it goes on the wire**, not to the
request when it is built, so a request drawn before a renewal or retried after it
sends the current credential. No cookie jar is kept between requests, so one
identity's session never reaches another's request.

**The trace keeps the renewals, never the tokens.** It records each renewal's
identity and moment, and a replay logs that identity in again before the first
request recorded after it, once per identity however many renewals fell there. A
replay checks, watches and retires nothing.

**A token the fuzzed login operation hands out is a secret, never the session.**
When a fuzzing request to the login's own operation is answered with a token, the
run records it as issued and blanks it from what it keeps, but the identity goes
on sending the credential its own login gave it.

### Rejected

- **Recording the issued token in the trace.** The trace is stored and shared; a
  token in it is a credential leaked. A replay can log in itself.
- **Renewing on every `401`.** A login per refused request would multiply the
  requests on a target that refuses one endpoint for other reasons, and hide that
  refusal.
- **Keeping the client's cookie jar.** Every identity shares one client, so a
  session cookie one identity received would ride on the next identity's request,
  and an access test would compare a user with itself.
- **Switching to a token a fuzzed login request was granted.** That request was
  drawn by the fuzzer, with a body that may name another user; the identity would
  silently become someone else.
- **Renewing without a bound.** A fuzzed logout that ends the session on every
  success would log the identity in for the whole run.

### Consequences

A run whose logout is fuzzed keeps its identity, at the cost of a login and a
witness per sign-out, and reports how many times with `renewals`. A login the
target refuses mid-run retires the identity like any dead credential. The token
never reaches the store, and the run blanks it out of every response it reads
([ADR-227](#adr-227)).

## ADR-226 — An operation that ends the session runs last, or never when the project says so, and the project's word outranks the model's and the names' { #adr-226 }

**Status:** accepted · `models/contracts/session_ending.py`, `runtime/ordering.py`, `runtime/runners/rounds.py`, `runtime/runners/loop.py`, `runtime/fuzzers/stateful/final_passes.py`, `runtime/safety_guard/policy.py`, `runtime/facade.py`; in the core, `services/fuzz/projection/session_ending.py`, `services/contract/session_ending.py`, `services/config/sessions.py`, `services/hold_lifters.py`

### Context

Renewal ([ADR-225](#adr-225)) and retirement ([ADR-224](#adr-224)) repair a lost
session after the fact. The cheaper fix is not to lose it: a logout explored first
kills the credential for everything explored after it. Some operations should not
be sent at all against a shared account: a password change, deleting one's own
user. The engine can do neither without knowing which operations end a session.

### Decision

**Each endpoint carries a session ending**: a disposition (`last`, `skip`, `keep`)
and its source. The project's `sessions.operations` option says it first; then the
producer's contract (`risk.ends_session`); then the core assumes it from the
operation's method and names (`logout`, `revoke`, a `POST` whose path or
`operationId` says `password`, a `DELETE` on `me`). Only the project may say `skip`
or `keep`.

**`last` runs after everything else** when an identity sends a credential: a final
round of its own in `stateless` and `performance`, explored and confirmed after
every other round; final passes on a budget of their own in `stateful`; the end of
the order in `auth` and `resilience`, which confirm in line. The run re-sends every
identity's witness before that round and before confirming it; a re-check that
leaves no identity cuts the run `credentials_lost` before any of those operations
is sent.

**The hold names who asked, not what the operation does.** A skipped operation is
held as `skipped_by_project`, while the endpoint's `ends_session` keeps saying what
the run took it for; the two answer different questions.

**`skip` is a hold of the safety guard, `skipped_by_project`,** in every mode but
replay, on the operation wherever it stands (compiled, excluded or outside the
selection) and on every transition to it. `allow_side_effects` does not lift it:
only the project's own option sends what the project asked to skip. A client is
told which lifts what: `parameter` `allow_side_effects` for a risk, `option`
`sessions.operations` for a skip.

**The option belongs to the project**, keyed `"<METHOD> /path"` as the contract
spells the operation, and refused when it names one the contract lacks.

### Rejected

- **Leaving session endings to the model.** A run without a producer would have
  none, and a model that misses a logout would cost the run its identities. The
  names catch the common ones; the project corrects both.
- **Excluding a session ending from the run.** It is part of the API and has its
  own defects; running it last tests it without costing the rest.
- **Letting `allow_side_effects` send a skipped operation.** That parameter is
  consent to writes; a skip is the project naming one operation it never wants
  sent. A run allowed to write would quietly change the user's password.
- **Reading `password` in a summary.** A login or a sign-up describes the password
  it takes; assuming it ends the session would push the login itself to the end.
- **A run parameter for the dispositions.** They are facts about the API, the
  same on every run; a parameter would have to be repeated on each one and would
  differ between clients.

### Consequences

An endpoint that ends the session is explored with a live credential, and nothing
before it is confirmed on a credential it killed. A stateful run with such
endpoints may spend up to ten more passes. An operation wrongly taken for a
session ending runs last rather than in its risk order, until the project marks it
`keep`. A run whose every endpoint is skipped is refused `NOTHING_VERIFIED`, and
its `data.option` names `sessions.operations`. An identity with a fixed credential
cannot outlive the first operation of the final round that ends its session, so
the rest of that round may go unexplored (`credentials_lost`,
`endpoints_unreached`); a declared login lets the run renew it and go on.

## ADR-227 — The run withholds every secret it knows from what it reads, and a login's secret travels as a reference resolved only on the wire { #adr-227 }

**Status:** accepted · `runtime/sessions/secrets.py`, `runtime/sessions/declared_secrets.py`, `runtime/sessions/wire_secrets.py`, `shared/secret_references.py`, `models/runtime/secret_ledger.py`, `runtime/findings/redaction/echo_patterns.py`, `runtime/findings/redaction/echo_scrub.py`; in the core, `services/fuzz/login_seeds.py`, `services/replay/server_logs.py`

### Context

Redaction by field name and by what a finding's own request sent cannot see a
token the run was issued mid-run, nor a password the identities file declares,
when a server echoes them into an unrelated response, an error message or a log
line. And a declared login is the best example the run has of a
valid request to the login operation, yet sending it as a seed would put the
password in the contract, the trace and every reproducer.

### Decision

**Every response is read with the run's secrets withheld**: the declared
credentials, every credential a login issued, and each secret field of a login's
body, in each form they travel in, replaced by `***` wherever the server echoed
them and however it encoded them, unless the request itself sent them. A finding
can only keep what the run read.

**A login's secret becomes a reference.** The core adds each declared login to its
operation as the seed case `declared_login.<label>`, with every secret value
replaced by `specforge-secret(/<label>/<path>)`. The engine resolves it as the
request is encoded, and only for a request to that login's method and URL.
Everything stored keeps the reference.

**A replay's server log is blanked of what its logins sent and were issued**, by
a ledger the replay hands the engine.

### Rejected

- **Sending the declared login as written.** The password would be stored with the
  contract and shown in every finding on the login operation.
- **Resolving the reference wherever it appears.** A mutation that moves the
  reference into another field, or a transition that copies it to another
  operation, would send the password where it does not belong.
- **Withholding only from the findings.** An oracle would judge a response
  holding the secret and could build a finding's evidence around it before
  redaction.

### Consequences

The login operation is fuzzed from a request that works, without the password
leaving the identities file. A login whose fields have no secret name is not
seeded, and the run says so with `declared_login_unseeded`. A secret shorter than
eight characters is not withheld from responses: too short a text matches
ordinary content.

## ADR-228 — A finding is never re-sent under a retired identity, and one that rests on refused re-sends is unverified, not flaky { #adr-228 }

**Status:** accepted · `runtime/runners/confirmable.py`, `runtime/runners/shrink_phase.py`, `runtime/sessions/live.py`, `models/runtime/results.py`, `runtime/fuzzers/stateful/retired_outcomes.py`, `runtime/runners/resilience/confirmation.py`, `runtime/runners/performance/latency_control.py`

### Context

A finding is confirmed by re-sending it. Under a credential the target no longer
accepts, every re-send answers `401`, and the finding reads as `flaky`: a verdict
about the API drawn from evidence about the credential. Stopping confirmation for
the whole run as soon as one identity is lost would throw away what the other
identities can still confirm.

### Decision

**Confirmation goes on with the live identities.** What the run found
anonymously, under a live identity or under one it does not watch is confirmed,
even after a `credentials_lost` cut, which stops exploring, not confirming. A
finding sent under a retired identity is never re-sent; a group none of whose members can be re-sent is
`unverified`; within a group, the members of live identities are tried first.

**A group whose every miss was a credential refusal is unverified** when the
identities refused are retired by the end of the run, and when its identity was
retired while it was being confirmed. A group that got real answers keeps its
verdict. Every runner that confirms follows the same rule.

### Rejected

- **Calling such a group flaky.** Flaky says the API answered differently; here it
  never answered the question.
- **Re-sending it anonymously or under another identity.** Who sent a request is
  part of an access finding, and a body or a resource may belong to that identity
  alone; a re-send under someone else confirms something else.

### Consequences

A run that loses one identity still confirms what the others found, and its
`unverified` count says how much rests on the lost credential. A server error
reproduced on every re-send stays confirmed whatever the identity.
