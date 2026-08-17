# EMB corpus

36 real open-source REST APIs, packaged to be attacked by a fuzzer. It's the
[EvoMaster](https://github.com/WebFuzzing/EvoMaster) team's corpus (Arcuri et
al.), the benchmark the papers in this field publish against.

Here it's used to **measure detection capability**: how many real bugs Spec
Forge finds. Language coverage is [RealWorld](real-world.md)'s job; EMB is
all JVM.

The upstream repo used to be `EMResearch/EMB` and is now
[`WebFuzzing/Dataset`](https://github.com/WebFuzzing/Dataset). The exact SHA
in use is in `MANIFEST.tsv`.

## Starting from scratch

```bash
./bootstrap.sh 8 maven       # fetch upstream and build 20 of the 36 SUTs
./up.sh features-service     # leaves it on http://localhost:8000
./down.sh
```

`./bootstrap.sh` with no arguments builds all 7 compile groups — all 36
SUTs — in about **1h50** total, because each group pulls its own dependency
tree. To start testing sooner, `8 maven` alone gets you 20 SUTs ready in
about 26 minutes.

`./up.sh` with no arguments lists all 36 and marks which ones are already
compiled.

## What each SUT gives you

`up.sh` prints the four things Spec Forge needs when it boots one:

| | |
| --- | --- |
| `HOST` | `http://localhost:8000` — fixed, only one SUT at a time |
| `SPEC` | the SUT's OpenAPI contract, under `specs/` |
| `AUTH` | credentials and login flow, under `auth/` (15 of the 36 have one) |
| traffic | a CSV with every request the SUT received |

It also leaves the **JaCoCo** agent listening on `localhost:6300` in
tcpserver mode: code coverage can be pulled on demand without instrumenting
anything. That's the number that answers "is Spec Forge actually reaching
anything?" with evidence instead of impressions.

The `auth/` files matter more than they look: without credentials, a fuzzer
against `blogapi` bounces off 401 and never touches the app. They're in *Web
Fuzzing Commons* format, which declares the login endpoint, where to extract
the token from, and how to send it:

```yaml
auth:
  - name: admin
    loginEndpointAuth:
      payloadRaw: "{\"usernameOrEmail\": \"admin\", \"password\": \"bar123\"}"

authTemplate:
    loginEndpointAuth:
        endpoint: /api/auth/signin
        verb: POST
        contentType: application/json
        token:
            extractFrom: body
            extractSelector: /accessToken
            sendName: Authorization
            sendIn: header
            sendTemplate: "Bearer {token}"
```

## Consumers

Today, the `specs/`: [`tests/contract_engine/`](suite.md) uses them as a
corpus of contracts — 36 of the 37 — **without booting anything**. 19 of them
are Swagger 2.0, which the Contract Engine now accepts and translates into
OpenAPI 3.x on the way in.

The running SUTs are only needed once the fuzzing stage exists.

## Pending: a Python API

`real-world/` has `corpus.py`, the same thing from Python, for tests. **EMB
doesn't yet.** It's needed once the fuzzing stage lands — the only stage that
needs a live SUT, since contract/AST/LLM analysis is static and needs only
the files already in the repo.

The rule is the same as upstream: **tests talk to a class, not to scripts.**
A test that shells out `subprocess.run(["./up.sh", sut])` and parses its
output is fragile glue in the harness — it breaks the day the script changes
one `echo`.

It needs to expose the same shape as `RealWorld`: the catalog of all 36
without booting anything, `levantar(sut)` that returns once the SUT
responds, and `host`, `spec`, `auth` and `sha` for whichever one is up. Like
`RealWorld`, it shouldn't reimplement anything — it should delegate to
`up.sh`, which stays the single source of truth for how each SUT boots. Two
things specific to EMB: `auth` only exists for 15 of the 36, and it needs to
be able to ask whether a SUT is compiled before trying to boot it.

## The 36 SUTs

The catalog lives in `SUTS.tsv`, and `up.sh` reads it: which group compiles
each SUT, which spec it maps to, whether it has auth, and what extra
services it boots.

Breakdown by compile group:

| Group | SUTs |
| --- | --- |
| `8 maven` | 20 |
| `11 maven` | 6 |
| `17 maven` | 4 |
| `21 maven` | 3 |
| `8 gradle`, `11 gradle`, `17 gradle` | 1 each |

15 need extra services: MongoDB (8), MySQL (3), PostgreSQL (2), Redis (2),
Elasticsearch, Keycloak, and an OAuth2 mock. Each SUT's own compose file
boots them, and **all of it runs on tmpfs**: upstream independently reached
the same conclusion we did about ephemeral state.

## Status: all 36 boot

Verified SUT by SUT, each one from a clean `--reset`. The column is the
`GET /` status code, which is only a liveness signal — `404` and `401` both
count, since they mean the application answered.

| SUT | | SUT | | SUT | |
| --- | --- | --- | --- | --- | --- |
| `bibliothek` | 302 | `market` | 404 | `rest-scs` | 404 |
| `blogapi` | 401 | `microcks` | 200 | `restcountries` | 404 |
| `catwatch` | 200 | `ocvn` | 404 | `scout-api` | 404 |
| `cwa-verification` | 403 | `ohsome-api` | 404 | `session-service` | 404 |
| `erc20-rest-service` | 404 | `pay-publicapi` | 404 | `spring-actuator-demo` | 200 |
| `familie-ba-sak` | 404 | `person-controller` | 404 | `spring-batch-rest` | 404 |
| `features-service` | 404 | `proxyprint` | 200 | `spring-ecommerce` | 401 |
| `genome-nexus` | 200 | `quartz-manager` | 200 | `spring-rest-example` | 404 |
| `gestaohospital` | 404 | `reservations-api` | 404 | `swagger-petstore` | 200 |
| `http-patch-spring` | 404 | `rest-ncs` | 404 | `tiltaksgjennomforing` | 404 |
| `languagetool` | 400 | `rest-news` | 404 | `tracking-system` | 404 |
| `user-management` | 404 | `webgoat` | 404 | `youtube-mock` | 404 |

**36 alive, 0 failing.** Startup between 1 and 42 seconds; the slowest are
`familie-ba-sak` (42s), `webgoat` (41s) and `microcks` (35s), which boots
Keycloak and a Postman runtime on top of Mongo. `up.sh`'s 180s
`READY_TIMEOUT` has plenty of margin.

Compiling all 7 groups took **~1h50** and produced 47 jars (2.4 GB): more
than 36 because the groups also produce the GraphQL and RPC SUTs, which we
don't use.

It was also verified that the databases are wired correctly and not just
that the app responds: `gestaohospital` returns hospitals seeded from Mongo,
`user-management` returns users from MySQL, `bibliothek` and
`person-controller` answer their collections. The `401`s from `microcks`,
`pay-publicapi`, `reservations-api` and `tiltaksgjennomforing` are expected —
those four have an `auth/` file.

## What to expect when attacking them

These are real applications with real defects — that's the point. But it's
worth knowing that **some `500`s are already there before Spec Forge touches
anything**, coming from seeded state, not from application logic.

Two cases showed up, and both are the same idea: the profile EMB boots the
application with produces a schema that doesn't cover everything the
application queries.

**`blogapi`** runs with `ddl-auto: none`, so the entire schema comes from the
initialization SQL EMB ships — and that SQL never creates the `categories`
table, which the application does use. Anything that touches it returns
`500` from boot.

**`familie-ba-sak`** is the opposite: it boots with the `dev` profile, which
disables Flyway and lets Hibernate create the schema with
`ddl-auto: create`. That produces 59 tables, but `task` isn't one of them —
it's created by a Flyway migration (`V9__prosessering.sql`) belonging to a
library whose entities this application doesn't map. Anything that goes
through the task framework returns `500`.

**This is not fixed.** It's what upstream publishes, and touching the seeded
state would make our results incomparable with EvoMaster's published
numbers — a large part of the reason to use EMB at all. What matters is
keeping it in mind when reading results: a flood of `500`s on one SUT can be
the corpus, not a finding.

## Why the upstream isn't committed

Upstream is 545 MB and 18,500 Java source files we'll never read.
Committing it wouldn't save the expensive step, which is compiling: EMB's
compose files don't build from source, they do `COPY ./dist/<sut>-sut.jar`.
A clone with the source inside would still need the same build.

And the jars themselves can't be committed either: a single group is 1.2 GB,
and `languagetool-sut.jar` alone is 182 MB, above GitHub's hard 100 MB
per-file limit.

So what's committed is what Spec Forge actually consumes, which is 4 MB:
`specs/`, `auth/`, `SUTS.tsv` and the scripts. Everything else is rebuilt by
`bootstrap.sh` from the SHA `MANIFEST.tsv` pins, which is what makes the
corpus reproducible.

## Stack notes

**No JDK or Maven needed on the host.** `bootstrap.sh` delegates to
upstream's `scripts/dist-docker.py`, which compiles inside containers. Only
docker, git, python3 and curl are needed.

**SUT-only mode.** Only `cs/` (the applications) is compiled, not `em/` (the
EvoMaster drivers). That's not a minor detail: the drivers depend on
artifacts published to GitHub Packages, which require a personal token in
`~/.m2/settings.xml`. We attack over HTTP from the outside, so that entire
authentication step is skipped.

**A mitmproxy in front of every SUT.** It's the only thing published on the
port — the SUT itself doesn't expose one. That's why the liveness probe
distinguishes three states instead of two: no response (the proxy hasn't
booted), `502` (the proxy is up but the SUT behind it isn't answering yet),
any other code (the SUT is alive — `404` and `401` both count).

**Explicit project name: `-p emb_<sut>`.** Same reason as in `real-world/`:
compose infers the project name from the directory, and all 36 compose files
live under `upstream/dockerfiles/`.

**`up.sh` registers `.active` before booting, not after.** With the reverse
order, a failed `up` aborts the script via `set -e` without leaving a
record, and `down.sh` has nothing to tear down — every failed attempt leaves
an orphaned database running.
