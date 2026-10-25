# AutoHub Pro — desktop edition (Windows)

One installer (`AutoHub-Pro-Setup-<version>.exe`) that runs the whole system on one Windows PC:
PostgreSQL 16, the API and the web app, inside an Electron window. No Docker, no server, no internet
connection needed. Each installation must be activated with a key bound to that PC.

## How it works

| Part | Where |
|---|---|
| Electron main process (bundled by esbuild into `dist/main.js`) | `src/main.ts` |
| PostgreSQL 16 (`initdb`/`pg_ctl` from `@embedded-postgres/windows-x64`), loopback only, password auth, same roles as `infra/db/bootstrap-roles.sql` (the API never runs as a superuser; RLS applies) | `src/database.ts` |
| API = `apps/api/dist` run by Electron's own Node (`ELECTRON_RUN_AS_NODE`), `HOST=127.0.0.1`, `NODE_ENV=production`; migrations and first-run provisioning run the API's own scripts | `src/api.ts` |
| Local web server on `127.0.0.1:47615`: serves `apps/web/dist` with the same security headers as `apps/web/nginx.conf` and forwards `/api/` | `src/server.ts` |
| Activation (offline, Ed25519) | `src/license.ts`, `src/renderer/activation.*` |
| First run: company, country, main branch, owner account | `src/renderer/setup.*` |
| Backups: cold copy of the database, uploads and keys (`.tar.gz`) on every exit and once a day at start-up; last 14 automatic backups kept; menu: back up now, restore, open folder, change folder | `src/backup.ts` |
| PDF documents | rendered with Microsoft Edge (part of Windows 10/11), or Chrome |

Data lives in `%APPDATA%\AutoHub Pro` (database, uploads, `secrets.json`, `license.key`, logs).
Backups go to `Documents\AutoHub Pro Backups` unless changed from the File menu. Uninstalling keeps
the data folder.

## Selling and activating

1. **Once:** open `tools/license-generator.html` in Edge or Chrome, click «إنشاء مفتاح بائع جديد». It
   downloads `autohub-seller-private-key.txt` (keep it safe and private: it can activate any PC) and
   shows the public key. Put the public key in `resources/license-public-key.txt` and commit it.
   The private key must never be committed.
2. Build the installer (GitHub Actions → "Desktop (Windows)" → artifact `AutoHub-Pro-Windows-Installer`,
   or locally on Windows, below).
3. The customer installs and starts the program; the activation screen shows a machine code such as
   `895E-178D-C68A-92F4-06BC`. They send it to you.
4. In the license generator: load your private key, paste the code, the customer's name, optionally an
   expiry date (trial), and send them the activation key. One key works on that PC only.

A new key pair makes all earlier activation keys invalid for builds made with the new public key.

## Build

On Windows (the installer must be built on Windows: PostgreSQL binaries and native modules are
per platform):

```bash
pnpm install
pnpm --filter @autohub/shared build && pnpm --filter @autohub/api build && pnpm --filter @autohub/web build
cd apps/desktop
pnpm typecheck && pnpm stage && pnpm bundle
pnpm dist:win            # release/AutoHub-Pro-Setup-<version>.exe
```

`.github/workflows/desktop.yml` does this on `windows-latest`, then runs `test/smoke.mjs` against
the packaged program with a throwaway key pair generated in the job.

## Test

`test/smoke.mjs` drives the real program with Playwright: activation (garbage, other-PC and expired
keys refused, valid key accepted), first-run setup (weak password refused), sign-in, a customer with
an Arabic name found by partial-name search, a PDF report, the automatic backup on exit, a restart
without activation, and a restore from the menu. On Linux (development only) PostgreSQL refuses to
run as root, so run it as a normal user under `xvfb-run` with `SMOKE_EXTRA_ARGS=--no-sandbox` and
`AUTOHUB_CHROMIUM_PATH` pointing at a Chromium.

## Limits (see docs/KNOWN_ISSUES.md KI-036, KI-037)

- One PC. Other devices on the network cannot connect (everything listens on 127.0.0.1).
- The digital showroom's public pages and QR codes point to this PC, so customers cannot open them.
- Activation stops a copied installation from running on another PC; it does not stop someone who
  modifies the installed program. The code is not obfuscated.
- No automatic updates: install the new version over the old one (data is kept and migrated on start).
- Backups contain the encryption key: keep them as safely as the data. Copy them off the PC.
