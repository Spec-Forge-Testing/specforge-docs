# Identities and sessions

A run sends its requests as the identities you declare in an identities file
(`--identities <file>.toml`, or the file your project names). This page covers
what Spec Forge does with their credentials: how an identity can log itself in,
how the run checks and watches each credential, what it does with the operations
that end a session, and what you see in the report. The rest of the identities
file (`role`, `tenant`, `credential = "invalid"`) is in the
[core REPL reference](cli-reference.md#commands).

## Let an identity log in { #login }

An identity can carry a fixed credential in `[identities.headers]`, or declare how
it logs in. With a `login` table, the run logs the identity in before its first
request and sends the token the answer carries:

```toml
[[identities]]
label = "alice"

[identities.login]
path = "/v1/auth/login"
body = { email = "alice@acme.test", password = "alice-password" }
token_at = "access_token"
```

| Key | Default | What to write |
| --- | --- | --- |
| `path` | required | The login's path, relative to the run's base URL, starting with `/`, with no path parameter. |
| `method` | `POST` | Any standard HTTP method. |
| `body` | none | The login's body, as a TOML inline table. |
| `media_type` | `application/json` | `application/json`, or `application/x-www-form-urlencoded` for a form whose fields are text, numbers or booleans. |
| `token_at` | — | Where the answer's JSON body holds the token, keys joined by dots (`data.token`). |
| `token_cookie` | — | The cookie the answer sets the token in, instead of `token_at`. Declare exactly one of the two. |
| `send_as` | `Authorization: Bearer {token}` | The header the token is sent in, with `{token}` where it goes: `X-Auth-Token: {token}`, `Cookie: sid={token}`. |

An OAuth2 password login is a form:

```toml
[[identities]]
label = "bob"

[identities.login]
path = "/oauth/token"
media_type = "application/x-www-form-urlencoded"
body = { grant_type = "password", username = "bob", password = "bob-password" }
token_at = "access_token"
```

Keep `role` and `tenant` above `[identities.login]`, as above `[identities.headers]`.
An identity that logs in may still declare other headers, but not the one its
login fills. Only an identity with valid credentials may log in.

A client can propose the `login` table from your specification: the protocol's
[`propose_login`](../modules/core/protocol/operations.md#propose-login) names the
operations that look like a login, their body fields and where their token is,
never a value.

**Your password stays in the file.** The run uses your declared login as an
example of the login operation itself, so that operation is fuzzed from a request
that works; the password travels in it as a reference,
`specforge-secret(/alice/password)`, that the run fills in only on a request to
that login. The contract, the trace, the findings and the report keep the
reference. A login none of whose fields is named like a secret (`password`,
`token`, `secret`, `passcode`, …) is not used as an example, and the run says so
with a `declared_login_unseeded` note. See
[Secrets a run knows](../modules/specforge-engine/run-secrets.md).

## Before the run: each credential is checked { #check }

Before the first request, the run sends each identity one harmless request it
must pass, a **witness**: a `GET` (or `HEAD`) that requires a login and takes no input,
preferably one that answers about the caller, such as `/me`.

- A `2xx`, or a `403`, shows the target knows the identity: it is **accepted**.
- A `401` on every request tried stops the run before anything else is sent, with
  `IDENTITY_REJECTED`: *"The target rejected identity 'alice' (credential_refused):
  GET /me answered 401."* A failed login stops it the same way
  (`login_refused`, `login_token_missing`, `login_unanswered`).
- Anything else (a `5xx`, a `429`, no witness at all) lets the identity in
  **unchecked**, and the report says why.

A run with a producer checks before it produces any contract, so a stale token
costs no inference. [Troubleshooting](troubleshooting.md#identity-rejected) says
what to do about a rejected identity.

## During the run: each credential is watched { #watch }

When an identity gets five `401`s with no `2xx`, `3xx` or `403` between them (a
`404`, `422` or `5xx` neither counts nor breaks the streak), the run sends its
witness again.

- The witness passes (`2xx` or `403`): those `401`s were about the requests, and
  the run goes on.
- The witness answers a redirect, a `5xx`, a `429` or nothing: that proves
  nothing, and the run goes on with the identity as it was.
- The witness is refused and the identity has a `login`: the run logs it in again
  and goes on with the new token (**renewed**).
- The witness is refused and the identity cannot log in: the run **retires** it
  and sends nothing more under it, in any mode. It names the operation it
  suspects ended the session: that identity's last successful write before the
  `401`s, or any identity's when it made none.

A client watching the run sees a `credential_lost` event for each renewal and
retirement. When every identity is retired, the run stops exploring and ends
`truncated` with the reason `credentials_lost`: your API may be perfectly healthy.
What the run found anonymously or under a live identity is still confirmed, even
after that cut. A finding found under a retired identity is never re-sent on the
dead credential: unless another identity's occurrence of it can be confirmed, it
stays **unverified**.

## Operations that end a session { #session-endings }

A logout, a token revocation or a password change ends the session of whoever
sends it. Spec Forge runs such an operation after the others, so it cannot kill
the credential the rest of the run needs, and in `stateless`, `performance` and
`stateful` runs re-checks the identities before
it. It recognizes one from what the inference read in your code, or else from its
name (`logout`, `revoke`, a `POST` whose path or `operationId` says `password`, a
`DELETE` of `/me`). A login or a sign-up whose summary merely mentions a password
is not taken for one.

You decide in your project's `specforge.toml`, by operation, as your
specification names it:

```toml
[sessions]
operations = { "POST /auth/logout" = "last", "PUT /users/me/password" = "skip", "DELETE /sessions/{id}" = "keep" }
```

| Value | What the run does |
| --- | --- |
| `last` | Runs it after every other operation. |
| `skip` | Never sends it, in any mode, even with side effects allowed. |
| `keep` | It does not end the session: runs it like any other. |

An operation the specification does not declare is refused. Use `skip` for an
operation you never want sent against your test accounts: the run holds it back
with the reason `skipped_by_project`, and names `sessions.operations` as what
sends it, not `allow_side_effects`. The details are on
[Operations that end the session](../modules/specforge-engine/session-endings.md).

!!! warning "Fixed tokens and the final round"
    An identity whose credential is a fixed header in `[identities.headers]` cannot
    be renewed. Once an operation of the final round ends its session, that
    identity is retired, and the other operations of that round may go unexplored;
    the run says so with `credentials_lost` and `endpoints_unreached`. Declare a
    `login` for the identity, and the run logs it in again and explores them. The
    run's own advice for `identities_retired` reads: *"Declare how each retired
    identity logs in so the run renews its session, or mark the operation the run
    suspects of ending it so it runs last, then run again."*

## What the report shows { #report }

The HTML report has an **Identities** table: each identity, whether its credential
was accepted before the run (or why it went in unchecked), its witness, and
whether it was retired and after which operation. `report.json` carries the same
in [`run.identities`](../modules/core/protocol/vocabularies.md#run-identities),
with how many times each identity was logged in again (`renewals`).

Each endpoint says, in
[`ends_session`](../modules/core/protocol/vocabularies.md#ends-session), whether
the run took it for an operation that ends the session, what it did with it and
who said so: you, the inference, or its name. The HTML report shows it in a
**Session** column.

The run's signal is `degraded` when an identity was retired
([`identities_retired`](../modules/core/protocol/vocabularies.md#signal-causes)).
An endpoint that got ten responses or more and not one success, such as a
`DELETE` whose ids never exist, is listed in
[`coverage.endpoints_never_succeeded`](../modules/core/protocol/vocabularies.md#endpoints-never-succeeded)
and in the HTML report's **Endpoints that never succeeded**: it informs, and does
not degrade the run.

## Replaying a run { #replay }

A replay logs your identities in again and renews each session where the recorded
run renewed it, at most once per identity before each replayed request, so the
requests after a recorded sign-out meet a live token. It checks, watches and
retires nothing.
