# Secrets a run knows

A run holds secrets: the credentials the identities file declares, the tokens a
login issues it, the password a login sends. A finding keeps the response it was
observed on, and a server that echoes a token or a password into a body, a header
or an error would otherwise carry that secret into the report, the store and a
shared reproducer. The engine keeps every secret it knows out of what it reads
back, and sends a login's password only where it belongs.

Findings were already redacted by field name and by the credentials their own
request sent ([Findings](findings.md)); this page is about the secrets the
run knows beyond the request at hand.

## What the run knows { #known }

`RunSecrets` (`runtime/sessions/secrets.py`) gathers, for one run:

| Secret | Where it comes from |
| --- | --- |
| Declared credential headers | Every identity's headers that name a credential (`Authorization`, `Proxy-Authorization`, `X-Api-Key`, any header whose name names a secret, and a `Cookie` kept to its cookies whose name names a secret), but the header a login fills. |
| Issued credentials | Every header value a login of the run issued, the ones a renewal replaced included, read live as the run renews them; and every token the target granted to a request of the run sent to a declared login's own operation, which the run records as issued without ever sending it as the identity's credential. |
| Login secret fields | Each text value of a declared login's body under a key that names a secret (`password`, `passcode`, `token`, `secret`, `otp`, …), at any depth. |

Each credential is taken in every form it can travel in: the bare token behind a
scheme, a decoded Basic pair, each cookie value, percent-encoded and in either
Unicode normal form.

## Withheld from every response { #withheld }

Every response to a request of the run passes through `withheld_from` before any
oracle reads it; only a session request's answer is read whole, since a login
reads its token off it, and it is never kept. Each known secret the request itself
did not send is replaced by `***` in the response body (every text and every key,
at any depth), in its headers, and in a transport error's detail. A secret is
matched however the server spelled it: raw, as a JSON string escape or a `\u`
escape, or as a numeric or named HTML entity.

A secret the request sent is left alone: an endpoint that echoes what it was given
is judged on that echo by the oracles that look for it. A reference to a secret
(below) sends no text of it, so a login's answer that echoes the password it
received is still blanked.

## A login's secret travels as a reference { #references }

A declared login's body is also a valid example of the login operation itself,
and the core adds it to that operation's contract as the seed case
`declared_login.<label>`. The seed must not carry the password: seed cases are
stored with the contract and the trace, and shrunk and mutated like any value.

So every text or number under a key that names a secret is replaced, before the
seed leaves the core, by a **secret reference** (`with_secret_references`,
`shared/secret_references.py`):

```text
specforge-secret(/alice/password)
```

The reference is the identity's label and the path to the value in its login's
body, as a JSON Pointer (`/alice/credentials/0` for an array item; `~1` and `~0`
escape a `/` and a `~` in a key). Nothing else in the run knows the value.

**It is resolved on the wire only.** `RunCredentials.wire_body`, called as each
attempt is encoded, replaces a text that is exactly a reference with the value the
login declares, and only on a request sent to that login's own operation: its
method, on its URL. Anywhere else, or once a mutation changed the text, the
reference goes out as written. The trace, the findings and the report keep the
reference.

**When a login is not seeded.** A login that cannot become a seed case leaves a
[`declared_login_unseeded`](../core/protocol/vocabularies.md#producer-note-kind)
note on the operation, with one of three reasons:

| Reason | Detail |
| --- | --- |
| no secret | the login declares no field the engine takes for a secret, so its values would go out in the clear |
| no operation | no operation of the contract is the login's method on its path |
| unprojectable | the login's operation cannot be projected from its schema |

A login whose operation the run's selection leaves out is neither seeded nor
noted. A run without a producer seeds and notes the same way.

## The server log of a finding's replay { #server-log }

`replay_finding` and `verify_finding_fix` may read the server's log while the
finding's request is in flight and keep the stack trace it holds. The trace is
blanked of the identities' credentials and the configured headers, and also of
every secret the replay's own logins sent and every credential they were issued,
the witnesses' logins included. `run()` hands them to a caller that passes a
`SecretLedger` (`secrets=`): the ledger follows each run's `RunSecrets` and shows
how many runs it follows, never a value.

## Limits { #limits }

!!! warning "What is not withheld"
    - **Short secrets.** A secret shorter than `MIN_SECRET_LENGTH` (8 characters)
      is not blanked out of responses: so short a text matches too much of an
      ordinary body. It is still sent by reference.
    - **Field names that do not name a secret.** A login field is a secret only
      when its name says so (`password`, `pin` does not). A login whose fields all
      have other names is not seeded (`declared_login_unseeded`, no secret), and
      their values are not blanked.
    - **A numeric secret** is sent by reference, but only a text one is blanked out
      of responses.

## Where to change what { #where-to-change }

| To change | Where |
| --- | --- |
| Which field names count as secrets | `shared/sensitive_names.py` |
| The shortest secret blanked out of a response | `MIN_SECRET_LENGTH`, `runtime/findings/constants.py` |
| The encodings a secret is matched in | `runtime/findings/redaction/echo_patterns.py` |
| The forms a credential is taken in | `runtime/findings/redaction/credential_forms.py` |
| The reference's spelling | `SECRET_REFERENCE_PREFIX`, `SECRET_REFERENCE_SUFFIX`, `shared/secret_references.py` |

The decision behind this page is [ADR-227](adr/sessions.md#adr-227).
