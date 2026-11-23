# Operations that end the session

Some operations end the session of the caller who sends them: a logout, a token
revocation, a password change, deleting one's own account. Fuzzed like any other
endpoint, such an operation succeeds early, kills the credential, and leaves every
endpoint explored after it answering `401`. The engine therefore takes each
endpoint's **session ending** as part of its input, and either runs it after the
endpoints that keep the session or never sends it at all.

A session ending is a `SessionEnding` (`models/contracts/session_ending.py`) on the
endpoint's `EndpointSpec`, `CompiledExecutionEndpoint` and `EndpointStats`:

| Field | Values | What it says |
| --- | --- | --- |
| `disposition` | `SessionDisposition` | What the run does with the endpoint (below). |
| `source` | `SessionEndingSource` | Who said the endpoint ends the session (below). |

An endpoint nobody says anything about carries `None`, and is fuzzed like any
other.

## Who says an endpoint ends the session { #sources }

The core resolves each endpoint's session ending from three sources, the first
with an opinion winning (`services/fuzz/projection/session_ending.py`):

| `SessionEndingSource` | Where it comes from | Disposition it gives |
| --- | --- | --- |
| `user` | The project's [`sessions.operations`](../core/configuration.md#the-options) option | `last`, `skip` or `keep`, as declared |
| `model` | The producer's contract: `risk.ends_session` | `last` when `true`; `false` says the endpoint does not end it, and the names are not asked |
| `assumed` | The operation's method and names, when nothing else says | `last` |

**What the names suggest.** The core reads the words of the operation's literal
path segments, its `operationId` and its `summary` (each word lowercased and
singular, and each two adjacent words joined) and assumes a session ending when
one of these rules matches:

| Words | Read in | Methods |
| --- | --- | --- |
| `logout`, `logoff`, `signout`, `log out`, `sign out`, `revoke`, `invalidate`, `deactivate`, `terminate` | path, `operationId`, `summary` | any |
| `password`, `passwd` | path and `operationId` only | `POST`, `PUT`, `PATCH` |
| `session`, `token`, `credential`, `api key`, `apikey` | path, `operationId`, `summary` | `PUT`, `PATCH`, `DELETE` |
| `me`, `self`, `account`, `user`, `member`, `profile` | path, `operationId`, `summary` | `DELETE` |

`password` is not read in the summary: a login or a sign-up describes the password
it takes ("Log in with email and password") without changing it, and is not
assumed to end the session (`operation_name_terms`,
`core/.../services/contract/operation_terms.py`).

The inference prompt asks the model for `ends_session` on every endpoint: `true`
when a successful call invalidates the credential the caller sent (it logs the
caller out, revokes its token or key, changes or resets its password, or deletes or
disables its own user or membership).

## What the run does with it { #dispositions }

| `SessionDisposition` | Meaning |
| --- | --- |
| `last` | The endpoint ends the session and runs after the endpoints that keep it. What the model or the names say, unless the project says otherwise. |
| `skip` | The endpoint ends the session and the project asked for it never to be sent: the safety guard holds it back. Only the project declares it. |
| `keep` | The project said the endpoint does not end the session: it is sent like any other. Only the project declares it. |

`SessionEnding.ends_session` is `true` for `last` and `skip`. An endpoint that ends
the session is never chosen as a credential's [witness](sessions.md#check), and a
response it gets never teaches one.

### `last`: after everything else { #last }

Ordering only matters when a credential can be lost, so every rule below applies
only when a valid identity of the run sends a credential, declared or issued by a
login (`has_credentialed_identity`). Without one, the order and the rounds are
unchanged.

| Mode | What `last` does |
| --- | --- |
| `stateless` | The endpoints run in **rounds**: the endpoints that keep the session, then the `DELETE` endpoints, then the ones that end it. Each round is explored and its findings confirmed before the next starts; a `DELETE` that ends the session goes in the last round. |
| `performance` | The endpoints that keep the session, then a final round with the ones that end it, each confirmed before the next. |
| `stateful` | The rules of the endpoints that end the session stay out of the normal passes and the reach passes. Once those are done, **final passes** run with every rule, the held ones included, on a budget of their own: at most `STATEFUL_MAX_FINAL_PASSES` (10), stopping after `STATEFUL_NO_PROGRESS_PASSES` (4) passes in a row without progress. The run's `max_passes` rises by those 10. |
| `auth`, `resilience` | They confirm each finding as they find it, so the endpoints that end the session are only ordered last. |

**The run re-checks its identities before the final round.** Before exploring the
endpoints that end the session, and again before confirming what that round
found, the run re-sends every live identity's witness (`CredentialWatch.revalidate`):
a credential the earlier rounds killed is renewed or retired before it is trusted.
In a stateful run the same check runs before the first final pass and before each
final pass is settled. The earlier rounds are confirmed before any endpoint that
ends the session is sent, so nothing they found is ever confirmed on a credential
the final round killed. `auth` and `resilience`, which only order, run no such
re-check.

**A re-check that leaves no identity ends the run there.** When the re-check
before the final round retires the last identity, the run explores none of the
endpoints that end the session and is cut `credentials_lost`, on the last endpoint
it sent to before the re-check.

!!! warning "A fixed credential does not survive the final round"
    An identity whose credential is a fixed header cannot be renewed. Once an
    operation of the final round ends its session, the identity is retired, and the
    other operations of that round may go unexplored: the run says so with the cut
    `credentials_lost` and the signal cause `endpoints_unreached`. An identity that
    declares a [login](sessions.md#login) is logged in again, and the round goes on.

The `tick` of a `stateless` run with such a round says `generating` while the
earlier rounds are confirmed, and `confirming` only for the last one, as with the
`DELETE` round ([events](../core/protocol/events.md)).

### `skip`: never sent { #skip }

A `skip` endpoint is held by the safety guard with the hold reason
`skipped_by_project` (`RiskFlag.SKIPPED_BY_PROJECT`, `runtime/safety_guard/policy.py`).
The hold names who asked for it; the endpoint's `ends_session` field still says
what the run took it for:

- in **every mode** but `replay`, which re-sends what an earlier, already guarded
  run sent;
- whatever `allow_side_effects` says: it is the one hold that parameter does not
  lift (`lifted_by_allowing_side_effects=False`), since the project asked for it in
  so many words;
- **wherever the operation stands**: compiled into the run, excluded by the
  compiler, or outside the run's endpoint selection (passed as a `SkippedOperation`
  on `CompilerInput.skipped`). Its route is vetoed like any held one, so no
  stateful transition reaches it either, and a transition to it is held as
  `skipped_by_project`.

Its flag ranks second in the guard's precedence: below `external_side_effects`,
which cannot be undone, and above `write_operation` and `assumed_write`. A held
endpoint is reported with `held_back_by` `skipped_by_project`, as any hold is
([Engine internals](engine-internals.md)); a run whose every endpoint is held is
refused (`AllEndpointsHeldError`).

`held_reasons(mode)` lists `skipped_by_project` for every mode but `replay`, and
`held_reasons_allowing_side_effects(mode)` keeps it: the core publishes both in
each mode's and each preset's [`holds_back`](../core/protocol/fuzz-options.md#holds-back).

### `keep`

The project's word that an operation the model or the names took for a session
ending does not end it. The endpoint keeps its `SessionEnding` with source `user`,
so the report says the project overrode the detection, and it runs like any
other.

## What the run reports { #report }

`annotate_session_endings` puts every endpoint's `SessionEnding` on its
`EndpointStats` row, whether it was probed, held back or never reached. The core
publishes it as [`endpoints[].ends_session`](../core/protocol/vocabularies.md#ends-session)
(`{disposition, source}`), and a retired identity's `suspect` says whether the
operation suspected of killing it was already `marked` as ending the session.

## Where to change what { #where-to-change }

| To change | Where |
| --- | --- |
| The words and methods the names are read by | `_SESSION_ENDING_RULES`, `core/.../services/contract/session_ending.py` |
| The order of the sources | `resolve_session_ending`, `core/.../services/fuzz/projection/session_ending.py` |
| Which modes run a final round | `session_ending_round` (`runtime/runners/rounds.py`), wired per runner; `_ORDERS_SESSION_ENDINGS_LAST` in `runtime/facade.py` for the modes that only order |
| The stateful final passes' budget | `STATEFUL_MAX_FINAL_PASSES`, `runtime/fuzzers/stateful/constants.py` |
| Where `password` is read | `operation_name_terms`, `core/.../services/contract/operation_terms.py` |
| What the `skip` hold applies to | the `SKIPPED_BY_PROJECT` row of `_FLAG_POLICIES`, `runtime/safety_guard/policy.py` |

The decision behind this page is [ADR-226](adr/sessions.md#adr-226).
