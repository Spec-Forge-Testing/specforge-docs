# Polyglot corpus

One real production API per `core_ast`-supported language, chosen for a real
OpenAPI contract, a compatible license and active maintenance. [RealWorld](real-world.md)
covers all 12 languages but with one synthetic contract (Conduit); [EMB](emb.md)
measures real bug detection but is entirely JVM. Neither answers "_does Spec
Forge find real bugs in real code outside the JVM?_" — that's what `polyglot`
exists for.

## Usage

```bash
./bootstrap.sh python          # clone the pinned source into candidates/python/source/
./up.sh python                 # boot the pinned official image on :8000
./down.sh
```

`./bootstrap.sh` with no arguments clones all candidates. `./up.sh` with no
arguments lists them and marks which already have a `compose.specforge.yml`.
Only one candidate at a time, same port 8000 as `real-world/` and `emb/`.

## What's in each folder

* **`candidates/<language>/`** — how to boot that candidate's API:
  `compose.specforge.yml` always, plus whatever else it needs (an nginx
  config, a Mongo init script, ...). `candidates/<language>/source/` is the
  pinned source `bootstrap.sh` clones on demand — never committed, same as
  `emb/upstream`.
* **`specs/<language>.json`** — that candidate's real OpenAPI contract,
  already captured. This is what `contract_engine` consumes; `candidates/` is
  only there to get the API running.
* **`MANIFEST.tsv`** — one row per language: the source commit SHA (for
  `core_ast`) and the Docker image + digest (for `up.sh`). The only record of
  which version each candidate is.

## Status: 9/11 wired, 1 closed without a candidate, 1 blocked by the engine

| Language | Candidate | License | OpenAPI mechanism |
| --- | --- | --- | --- |
| Python | [Mealie](https://github.com/mealie-recipes/mealie) | MIT | Native FastAPI `/docs` — captured live |
| JavaScript | [NodeBB](https://github.com/NodeBB/NodeBB) | GPL-3.0 | Published Write API (v3) spec, split across multiple files — bundled into one document |
| TypeScript | [Directus](https://github.com/directus/directus) *(replaces Medusa — no maintained official image existed)* | MSCL (converts to GPL-3.0 four years after each release; permits internal/research use) | Native `/server/specs/oas` — dynamic by permission, captured authenticated as admin (68 paths vs. 10 unauthenticated) |
| Go | [Gotify](https://github.com/gotify/server) | MIT | Native `/docs` / `swagger.json` — **blocked**: real spec is Swagger 2.0, `contract_engine` only accepts OpenAPI 3.x ([AI-198](https://linear.app/ai-pbt/issue/AI-198)) |
| Java | [Keycloak](https://github.com/keycloak/keycloak) | Apache-2.0 | Captured from Keycloak's official docs site |
| C# | [Jellyfin](https://github.com/jellyfin/jellyfin) | GPL-3.0 | Native Swashbuckle `/api-docs/openapi.json` — captured live (first request takes ~9s, generated on demand) |
| Ruby | [Mastodon](https://github.com/mastodon/mastodon) | AGPL-3.0 | **Not served at runtime** (`/openapi.json`, `/openapi.yaml`, `/api-docs` all 404, verified live) — captured from a community spec sourced from the official docs; no official OpenAPI exists |
| PHP | [InvoiceNinja](https://github.com/invoiceninja/invoiceninja) *(replaces BookStack — its `/api/docs.json` turned out to be a proprietary JSON, not OpenAPI under any angle)* | Elastic License 2.0 (source-available; permits internal/research use) | **Not served at runtime** (checked the full route list, no match) — a real build artifact (`openapi/api-docs.yaml`, generated from the app's own `@OA` annotations), pulled from the running container |
| Rust | [Meilisearch](https://github.com/meilisearch/meilisearch) | MIT | **Not served at runtime** — published as a GitHub release asset, committed static |
| Kotlin | [Komga](https://github.com/gotson/komga) | MIT | Native Springdoc `/v3/api-docs` — captured live |
| Swift | — | — | **Closed without a candidate.** Three real Vapor apps were evaluated (Feather CMS, Penny, SteamPress); none is a standalone REST server with genuine OpenAPI generation, and none has a maintained official Docker image. **10/11 languages is the corpus' final result.** |

Candidate research, license justification and discarded alternatives for
each language: see AI-205 and AI-226 in Linear.

## Rules of the stack

The same spirit as `real-world/`'s and `emb/`'s rules, adapted for
production apps we don't vendor:

**One `compose.specforge.yml` per candidate, pull-only.** Every image is the official one, pinned by digest in `MANIFEST.tsv` — nothing is built from source.

**Source isn't vendored, same as `emb/` and unlike `real-world/`.** These are
real production projects (Keycloak, Jellyfin, Mastodon...), not small demo
apps. `candidates/<language>/source/` is a shallow clone pinned to the SHA
`MANIFEST.tsv` declares, fetched on demand by `bootstrap.sh`, gitignored.

**State is ephemeral, on purpose — with one documented exception.** Every
candidate's database runs on `tmpfs`, same rule as the other two corpora.
PHP/InvoiceNinja is the one exception: nginx and the app run in separate
containers and both need to read the same `public/`/`storage` files, and a
per-service `tmpfs` mount can't be shared across containers. It uses regular
named Docker volumes instead — still local, still torn down on
`docker compose down`, just not `tmpfs`. See the comment in
`candidates/php/compose.specforge.yml` for the full reasoning.

**The spec isn't always captured live.** Three of the nine wired candidates
(Ruby, PHP, Rust) don't serve their OpenAPI contract at runtime at all —
confirmed live, not assumed from documentation. For those, `specs/<language>.json`
comes from the closest real source instead: a community spec sourced from
official docs, a build artifact pulled from the running container, or a
GitHub release asset. Never inferred from examples — if a candidate only
exposed examples with no real type/constraint information (BookStack's case),
it was rejected as a candidate instead of "converting" it into a fake
contract.

## Consumers

Not wired into the suite yet — [AI-228](https://linear.app/ai-pbt/issue/AI-228)
tracks adding `polyglot` to `contract_engine`'s integration suite. Until then,
`specs/*.json` can be validated standalone; booting a candidate is only
needed once the fuzzing stage exists, same as `real-world/` and `emb/`.
