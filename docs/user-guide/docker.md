# Running with Docker

The root `docker-compose.yml` runs Spec Forge in containers. It groups services into profiles,
so only the requested workload starts. The `poe` shortcuts below need
[`poethepoet`](https://poethepoet.natn.io/) on the host (`pip install poethepoet`) and run from
the repository root.

| Profile | Services | What for |
| --- | --- | --- |
| `dev` | `specforge`, `specforge-core` | Spec Forge itself, built from the core image |
| `demo` | `fixtures-api` | A sample API to fuzz |
| `test` | `contract-assembly`, `storage-engine`, `core-ast` | Those modules' test suites |

## The core image

`core/Dockerfile` builds one image on `python:3.11-slim`, shared by both `dev` services. It
installs every package editable, under `/app`, in dependency order: the shared kernel
(`lib/contracts`), then `lib/contract_assembly`, `lib/core_ast`, `lib/specforge_engine`,
`lib/storage`, and finally `core`. `lib/core_ast` is installed with its `golden-path` extra, so
the image carries the seven grammars it loads on demand (Java, C#, Ruby, PHP, Rust, Kotlin,
Swift) besides the built-in ones; see
[Core AST](../modules/core-ast/index.md#development-requirements).

### `WITH_LLM`: the inference stage

The LLM packages are opt-in. The build argument `WITH_LLM` takes `0` (the default) or `1`; any
other value fails the build.

| `WITH_LLM` | Installs | A run with the inference producer |
| --- | --- | --- |
| `0` | the packages above | fails: the inference engine is not installed |
| `1` | also `lib/llm` and `lib/semantic_inference` | infers contracts, given an LLM model and key |

Compose reads it from the host environment:

```bash
WITH_LLM=1 docker compose --profile dev build specforge-core
```

## The protocol server: `specforge-core`

`specforge-core` runs `specforge --serve`: the core's
[protocol](../modules/core/protocol/index.md) server, which reads JSON-RPC frames on stdin and
writes responses and events on stdout. It keeps stdin open and allocates no terminal, so a
client drives it as a child process.

```bash
poe serve
```

`poe serve` is `docker compose --profile dev run --rm specforge-core`. A client that spawns the
server itself runs the same command with `-T`, which keeps Docker from allocating a terminal
whatever the caller's stdin is:

```bash
docker compose --profile dev run --rm -T specforge-core
```

The server answers `hello` and then serves operations until `shutdown` or the end of its input;
the [handshake](../modules/core/protocol/handshake.md) page describes that exchange. Starting a
container adds to the handshake time: measured on one development machine, `hello` answered in
1.5–3.3 s through `docker compose run`, against 1.3–1.4 s from a local virtualenv. A stateless
run of 3024 requests on a 19-endpoint API took 22–30 s there.

The other `dev` service, `specforge`, runs the same image with a terminal attached
(`stdin_open` and `tty`), for interactive use.

## What the container sees

Both `dev` services mount the repository root at `/app` (`.:/app`), over the code the image
installed. So:

- an edit on the host takes effect at the next start, without rebuilding, unless it changes a
  package's dependencies;
- the data directory is the host's `data/` (the checkout default, `<repo>/data`), so runs,
  analyses and the contract cache survive the container;
- the LLM settings are the host's `lib/llm/.env.local`; see
  [Environment Variables](environment.md#llm-configuration). A variable set in the process
  environment takes precedence over that file, as outside Docker.

### Reaching a target on the host

Inside a container, `localhost` is the container itself. Point the project's base URL at the
host instead: Docker Desktop resolves `host.docker.internal` to it. A Docker Engine on Linux
needs `host.docker.internal:host-gateway` in the service's `extra_hosts` for that name to
resolve.

## Checking the image: `poe docker-smoke`

```bash
poe docker-smoke
```

It runs `scripts/docker_smoke.sh`, which:

1. builds `specforge-core` (with `WITH_LLM` as set in the environment, `0` otherwise);
2. loads every optional grammar inside the image, and fails naming the first one missing;
3. sends `hello` with the core's own protocol version, then `shutdown`, and checks that the reply
   to `hello` carries that version.

`WITH_LLM=1 poe docker-smoke` checks the image with the LLM packages.

## Demo API (`demo` profile)

```bash
poe demo
```

It starts `fixtures-api`, a sample API published on the host's port `8000`. From the host it is
`http://localhost:8000`; from a `dev` container of the same Compose project it is
`http://fixtures-api:8000`.

## Module test suites (`test` profile)

```bash
poe test
```

It runs `docker compose --profile test up`: the `contract_assembly`, `storage` and `core_ast`
suites, each in its own container, with coverage. Working on a module directly is covered in
[Contributing & Testing](../developer-guide/contributing.md).
