# ChronosUI

> Bring Order to Time — a modern, cross-platform desktop GUI for managing your OS's native job schedulers.

English | [繁體中文](./README.zh-TW.md)

[![CI](https://github.com/AugustusW/chronos-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/AugustusW/chronos-ui/actions/workflows/ci.yml)

ChronosUI manages the schedulers you already use — **crontab** (macOS/Linux) and **Windows Task
Scheduler** — in place, and adds what they lack: run history, captured output, durations, and
on-demand manual runs. It is a management + observability layer, **not** a new scheduler daemon.

## Status

Early development. See the design spec for the architecture and roadmap.

## Develop

```bash
git clone https://github.com/AugustusW/chronos-ui.git
cd chronos-ui
npm install
npm run dev      # launch the app
npm test         # unit tests
npm run lint     # lint
npm run build    # production build
```

Requires Node 20+.

## How it works (preview)

ChronosUI reads your native scheduler and shows a clean GUI. To record the output of _scheduled_
runs, it can "adopt" a job by wrapping its command with a small bundled binary (`schedmgr`) —
fully transparent (same working dir, env, and exit code) and one-click reversible. Details and the
exact `crontab` rewrite are documented before release.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Contributions require a DCO sign-off
(`git commit -s`); see [CONTRIBUTING](./CONTRIBUTING.md).
