# Contributing to ChronosUI

Thanks for your interest!

## Developer Certificate of Origin (DCO)

All commits must be signed off, certifying you wrote the code or have the right to submit it under
Apache-2.0:

```bash
git commit -s -m "your message"
```

This appends a `Signed-off-by: Your Name <you@example.com>` line. No CLA is required.

## Workflow

1. Open an issue describing the change.
2. Fork, branch, and keep commits focused.
3. `npm run lint && npm run typecheck && npm test` must pass.
4. New behavior needs tests (TDD preferred).
5. Open a PR; CI must be green.

## Running Postgres-backed tests

By default `npm test` runs the SQLite path only (hermetic — no external services). ChronosUI also
supports an optional PostgreSQL backend; to exercise that data-layer path, point the suite at a
throwaway Postgres via `TEST_PG_URL`:

```bash
docker run -d --rm --name chronos-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16
TEST_PG_URL='postgres://postgres:test@localhost:55432/postgres' npm test
docker stop chronos-pg
```

When `TEST_PG_URL` is unset the Postgres cases are skipped. CI runs both paths on every push via a
dedicated Linux job with a Postgres service (see `.github/workflows/ci.yml`).

## License of contributions

By contributing, you agree your contributions are licensed under Apache-2.0, including its patent
grant.
