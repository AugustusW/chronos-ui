# Security Policy

## Supported versions

ChronosUI is pre-1.0. Security fixes land on the latest released `0.1.x` and `main`; older
builds are not separately patched — please update to the latest release.

| Version        | Supported          |
|----------------|--------------------|
| latest `0.1.x` | ✅                 |
| older          | ❌ (please update) |

## Reporting a vulnerability

Please report security issues **privately** — do **not** open a public issue.

- Preferred: this repository's **Security** tab → **Report a vulnerability** (a private GitHub
  security advisory).
- We aim to acknowledge within a few days. Coordinated disclosure is appreciated, and we're happy
  to credit you unless you'd prefer otherwise.

## Security model — please read before reporting

ChronosUI is a developer tool for creating and running **scheduled commands**. Some behaviour is
inherent to what it does and is **not** a vulnerability:

- **Arbitrary command execution by design.** Jobs run shell commands *you* specify, at *your own*
  OS privilege, **without a sandbox**. ChronosUI is not a privilege boundary — anyone who can edit
  your jobs (or the underlying OS scheduler) can run code as you.
- **It edits your OS scheduler.** ChronosUI writes and removes entries in your user crontab
  (macOS/Linux) or Task Scheduler (Windows). It only manages entries it created or adopted.
- **Local trust boundary.** Settings and run history live in a local SQLite database in your user
  profile. Treat your OS user account as the trust boundary.

### Secrets — Telegram notifications

If you enable Telegram failure notifications:

- The bot **token** is stored in your OS keychain where ChronosUI supports it — the **macOS
  Keychain** and the **Linux Secret Service** (libsecret). On platforms without keychain write
  (currently **Windows**), or if a keychain write fails, it falls back to a `0600` file in your user
  config directory and the app warns you that the token is stored unencrypted. The token is never
  written to the database, to logs, or returned over IPC.
  - macOS note: the `security` CLI has no stdin-password option, so the token is briefly visible in
    the process argument list (`ps`) for the duration of the keychain write — a lower risk than a
    persistent plaintext file, but not zero.
- A bot token grants full control of that bot — keep it secret, and revoke it via
  [@BotFather](https://t.me/BotFather) if it is ever exposed.
- **Job stderr is not sent to Telegram unless you opt in.** Immediate-notification messages can
  optionally include the tail of a failed job's stderr (off by default). Enabling it may send
  command output — which can contain secrets — to your configured chat. Only enable it for chats you
  control.

### What we DO treat as vulnerabilities

- Secret exposure beyond the above — e.g. a token written in plaintext where the keychain was
  expected, or leaked to logs / telemetry / IPC.
- Command or scheduler injection from data that should be inert — e.g. a job field escaping into an
  extra crontab line.
- Renderer compromise leading to main-process or native code execution (a CSP, navigation, or IPC
  boundary bypass).
- Privilege escalation beyond the invoking user.

Thanks for helping keep ChronosUI users safe.
