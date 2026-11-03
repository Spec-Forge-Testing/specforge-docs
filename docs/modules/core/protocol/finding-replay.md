# Finding replay verdicts

`replay_finding`, and the replay `verify_finding_fix` runs after a build, answer
one verdict about one finding: `present`, `possibly_resolved` or `inconclusive`.
This page explains how that verdict is reached: what the replay sends, the order in
which the core turns a verdict it cannot vouch for into `inconclusive`, what each
reason asks of you, and what the answer shows of the exchange. The fields of the
answer are listed on [Replay and fixes](replay-and-fixes.md#replay-finding); the
reasons, as a closed vocabulary, on
[Result vocabularies](vocabularies.md#inconclusive-reason).

## What a finding's replay sends { #what-it-sends }

Before the finding's request, the replay sends its **witnesses**: up to two
recorded requests that show whether the server still answers as it did when the
finding was recorded.

```mermaid
sequenceDiagram
    participant C as Core
    participant A as API under test
    participant L as Server log
    C->>A: witness 1 (recorded GET or HEAD, answered 2xx)
    C->>A: witness 2
    alt no witness answered
        C-->>C: inconclusive, no_answer; the finding's request is not sent
    else a witness answered
        C->>L: start watching
        C->>A: the finding's request
        C->>L: stop watching
        C-->>C: the engine's verdict, then the reasons in order
    end
```

A witness is a safe request (`GET` or `HEAD`) the recording sent with valid values
and saw answered with a 2xx, under the finding's identity. The core ranks the
candidates and keeps the first two with distinct URLs:

1. the ones that name the finding's resource (the same path parameter value under
   the same name: `shares_path_params` is `true`);
2. the ones on the finding's path template;
3. any other.

A witness the live identities or host cannot send is skipped; it never refuses the
replay. Witnesses go on their own, at once, before the server's log is watched, and
ask for no consent of their own: they are reads the recording already made.

!!! note "Not the engine's witnesses"
    A replay witness is a recorded read sent again. It is unrelated to the
    [inferred-rule witnesses](../../specforge-engine/witnesses.md) the engine draws
    while fuzzing.

The answer reports what the witnesses did:

| Field | Holds |
| --- | --- |
| `witnesses` | One entry per witness, in the order sent: `method`, `path` (the endpoint's template), `identity_label`, `recorded_status`, `observed_status` (`null` when it got no answer), `diverged` (it answered otherwise than recorded, or not at all) and `shares_path_params`. `[]` when the trace held none, and for a cancelled replay. |
| `judged` | `oracle_scope` (`contract_free`, as [`run.oracle_scope`](vocabularies.md#oracle-scope)), `requests_sent` (the witnesses plus the finding's request; the witnesses alone when it was not sent) and `controls_resent` (whether the finding's control requests were sent again; always `false`). `null` only for a cancelled replay. |
| `run_status` | The worse of how the witnesses' run and the finding's ended. |
| `fidelity` | `reduced` when a witness diverged, otherwise the finding's request's own. With no witnesses it vouches for nothing. |
| `server_log` | `unavailable` when no witness answered (the log is not read) or a witness diverged (the window may hold the witness's own trace); `server_log_detail` says why. |

## How the verdict is reached { #verdict }

The engine first rules the finding's request as it rules any replayed request,
with its contract-free oracles ([Replay verdicts](vocabularies.md#replay-verdicts)).
Then:

- **`present` stands.** The defect reproduced. Whatever the witnesses answered, it
  reads "present in the environment and the build that answered".
- **Anything else is checked against six reasons, in order.** The first that holds
  makes the verdict `inconclusive` and is given as `inconclusive_reason`.
- **When none holds, the engine's verdict stands.** That is the only way to read
  `possibly_resolved`.

| Order | `inconclusive_reason` | Holds when | What to do |
| --- | --- | --- | --- |
| 1 | `no_answer` | The finding's request got no answer (down, timed out, connection dropped), or it was not sent because no witness answered. | Bring the API up (`service` and [`inspect_service`](replay-and-fixes.md#inspect-service) say what answers on the port) and replay again. |
| 2 | `stale_target` | The server runs the code from before a fix applied over the finding's handler files: `stale_reason` or `stale_target` is set. | Replay with `rebuild: true`, or rebuild and restart the service yourself, then replay again. |
| 3 | `credentials_refused` | The request was recorded with credentials, now gets a `401` or `403` where the recording got neither, and nothing proves those credentials still pass: no witness, or a witness diverged. | Regenerate the identities file or the configured headers, and replay again. |
| 4 | `witness_diverged` | A witness no longer answers as recorded: the server's data, or the credentials, are not the ones the finding was recorded against. | Read `witnesses`. Restore the data the finding was recorded against (a rebuild that empties the database removes the recorded resources), or record a new run against the current data. |
| 5 | `unwitnessed` | The engine ruled `possibly_resolved`, but the trace held no witness to vouch that the server still answers as recorded. | Record a run whose trace holds a successful `GET` or `HEAD` under the finding's identity, ideally on its resource, and replay that run's finding. |
| 6 | `not_observable_without_contract` | The engine ruled `inconclusive`: the server answered otherwise, but the finding's invariant can only be judged against a contract the replay does not check. | Run the endpoint again with `fuzz`, which judges against the contract, and set the runs side by side with `compare_runs`. |

A witness that diverged gives `witness_diverged` also where the engine ruled
`inconclusive`: it is the more actionable reason. `inconclusive_reason` is `null`
whenever the verdict is not `inconclusive`, and for a replay cancelled before its
request was sent.

## Why `possibly_resolved` is earned { #earned }

A changed answer is not a fix. A server that is down, a build from before the fix,
an expired token and an emptied database all change the answer the finding's
request gets. `possibly_resolved` therefore needs all of these at once:

- the server answered the finding's request;
- it runs the code with the fix in it;
- its credentials pass, or are proven by witnesses;
- witnesses were sent, and every one answered as recorded;
- the finding's invariant is one a contract-free judgement can observe.

Only then does a replay with a fix in the tree record a `resolution`. A replay is
the finding's newest: an `inconclusive` one takes any earlier `resolution` away
([ADR-194](../adr/core.md#adr-194)).

### Credentials { #credentials }

A finding's request recorded with credentials (an identity's, the configuration's
headers or the URL's userinfo) that now gets a `401` or `403`, where the recording
got neither, may have judged only the live credentials. While those credentials are
unproven (no witness was sent, or one diverged), a verdict other than `present` is
`inconclusive` with `credentials_refused`, and `acceptance.met` is `false` even for
a `401` or `403` the contract declares, so the replay resolves nothing.

Behind witnesses that answered as recorded, sent under the same identity, the
credentials are proven: the server accepted them a moment before. A `403` is then
judged as an ordinary answer, and `acceptance` reads it as any other status.

### Fixes in the tree and stale builds { #stale }

A finding's replay runs on the fixes applied over its handler's files: its own and
other findings'. Its `resolution` is kept against the finding's own applied fix,
else the newest other finding's. Whether the server runs the code from before them
is measured against the newest of all of them:

- `fix_applied_at` is when that fix was applied;
- `stale_reason` says why the server predates it: `trace_before_fix`, else
  `image_before_fix`, else `started_before_fix`;
- `stale_target` names whichever of the two fixes, the newest first, the server's
  trace shows it skipped.

[`inspect_service`](replay-and-fixes.md#inspect-service) with `finding_id` answers
`fix_applied_at` and `stale_reason` the same way, before any replay. A `present`
verdict stands against a stale build: it reads "present in the build that
answered", which may not carry the fix. A resolution is kept against the fix as it
was applied when the replay was decided: a fix applied again meanwhile leaves it
resolving nothing.

## The exchange { #exchange }

The answer carries `exchange`: what the finding's request sent and got back this
time, in the shape [`get_finding`](operations.md#finding-fields) shows the
recording in, so a client can set the two side by side.

| Field | Holds |
| --- | --- |
| `status_code` | The status received; `null` with no answer. |
| `request` | `url`, `poisoned_zone`, `poisoned_field`, `attack_family`, `trigger_fields`. |
| `payload` | What the request sent, by zone: the whole recorded request, not a minimal payload. |
| `sanitized_headers` | The request's headers, credentials blanked. |
| `response` | `content_type`, `headers`, `latency_ms`. |
| `response_body` | The body as text; `null` with no answer. |

It is redacted as the finding's evidence is: the fields the analysis's contract
declares sensitive, and the live credentials the request was sent with, wherever
the request or the response carries them. The witnesses' exchanges are not
answered.

`exchange` is `null` when:

- the finding's request was not sent: no witness answered, or the replay was
  cancelled;
- the stored contract cannot be read. The replay is still sent and judged, but an
  exchange is never answered without the contract's sensitive fields redacted.

## What a witness cannot see { #limits }

- **Witnesses compare statuses only.** A change in the server's state that no
  witness's status shows still lets the replay read `possibly_resolved`. When no
  witness names the finding's resource, a same-path witness on another resource or
  a collection `GET` still answers `200` on an emptied database, while the
  finding's resource is gone and its `500` turns into a `404`. A witness with
  `shares_path_params: true` closes most of that gap.
- **The verdict stays "possibly".** A defect that did not trigger this once, or a
  change that hides the defect without fixing it, also reads `possibly_resolved`.
- **Controls are not resent.** `controls_resent` is `false`: a finding's control
  requests are not part of its replay.
- **An analysis-wide replay has no witnesses.** `replay` re-sends a whole recorded
  run and rules each recorded request on its own
  ([Replay verdicts](vocabularies.md#replay-verdicts)). When every recorded request
  violated something, nothing in it plays the witnesses' part.
