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

## License of contributions

By contributing, you agree your contributions are licensed under Apache-2.0, including its patent
grant.
