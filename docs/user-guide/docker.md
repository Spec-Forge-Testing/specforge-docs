# Running with Docker

The root `docker-compose.yml` is the entry point for running Spec Forge in
containers. It groups services into profiles, so only the requested workload
starts. The `poe` shortcuts below need [`poethepoet`](https://poethepoet.natn.io/)
on the host (`pip install poethepoet`).

## CLI (`dev` profile)

```bash
poe dev
```

## Demo API (`demo` profile)

Start the dummy API used for manual or demo fuzzing:

```bash
poe demo
```

Working on a module directly — module-specific Compose files, test and lint
commands — is covered in [Contributing & Testing](../developer-guide/contributing.md).
