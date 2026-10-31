# WhatsApp-ERP — Customer Operations & WhatsApp Automation

A secure, local multi-company customer operations platform built with **React**, **Fastify**, and **SQLite (WAL mode)**. It connects directly to retail and ERP Microsoft SQL Server databases in strictly read-only mode to ingest customer phone numbers, validate formats, and automate onboarding into WhatsApp community groups.

Current Candidate Release: **`1.0.0-rc.1`**

---

## Key Features

- **Strictly Read-Only ERP Integration**: Executes parameterized queries on SQL Server with zero triggers, schema modifications, or write permissions required.
- **Dual-Strategy Sync Pipeline**:
  - **Fast Incremental Sync (Every 30 Seconds)**: Clustered index seeks based on branch watermarks to ingest new customer registrations near-instantly.
  - **Smart Lookback Buffer & Recheck List**: Catches edge cases where a cashier presses `Enter` on the name before typing the phone number seconds later. Customers without valid phones are automatically tracked and promoted to the WhatsApp queue as soon as the phone is saved in the ERP.
  - **Full Periodic Reconciliation (Every 60 Minutes)**: Performs an automatic hourly scan to capture historical customer updates, phone number corrections, or manual database changes, plus a manual **"Reconcile All Customer Changes"** button in the dashboard.
- **WhatsApp Automation Engine**:
  - Standalone worker running headless Chromium via Puppeteer.
  - Supports both **Per-Branch Groups** and a **Unified Global Group**.
  - **Automatic Group Rollover**: Automatically provisions and transitions to the next group counter (e.g. `Main Branch 2`) when participant thresholds are reached.
  - **Privacy-Safe Handling**: Automatically falls back to sending a personalized 1:1 direct WhatsApp message containing the invite link when a user has restricted group privacy settings (Code 403).
  - **Working Hours & Backlog Throttling**: Restricts historical backlog additions to Cairo working hours with configurable daily limits, while allowing brand-new customer registrations to be processed immediately.
  - **Idempotency & Operations Ledger**: Durable SQLite tracking table ensures no customer receives duplicate invites or repeated addition attempts.
- **Enterprise-Grade Windows Deployment**:
  - Self-contained, precompiled JavaScript runtime (`dist/runtime`) and bundled frontend (`dist/web`) — no TypeScript compiler (`tsx`) or devDependencies required in production.
  - Automated PowerShell deployment (`scripts/windows/install.ps1`) creating a monitored Windows Scheduled Task under `SYSTEM` with auto-restart on crash.
  - Online consistent backups using the SQLite Online Backup API scheduled daily at 03:00 AM.
  - Secure state directory isolation under `C:\ProgramData\WhatsApp-ERP` restricted to `SYSTEM` and `Administrators`.

---

## Architecture & Directory Layout

```text
C:\WhatsApp-ERP\
├── releases\
│   └── 1.0.0-rc.1\               # Immutable versioned release files
│       ├── dist\
│       │   ├── runtime\          # Compiled Fastify server & WhatsApp worker JS
│       │   └── web\              # Pre-built React production frontend
│       ├── scripts\windows\      # PowerShell management scripts (install, backup, update)
│       └── package.json
└── (future releases...)

C:\ProgramData\WhatsApp-ERP\       # Persistent state across upgrades
├── data\
│   ├── app.sqlite                # Application database (companies, branches, queue, audit)
│   └── secret.key                # AES-256-GCM key for encrypted SQL Server credentials
├── chromium\                     # Downloaded Chromium browser binaries
├── backups\                      # Consistent SQLite online backups
├── logs\                         # Process output & rotation logs
└── service.json                  # Runtime configuration and active release pointer
```

---

## Windows Production Deployment

### Prerequisites on the Host Machine
1. **Windows 10 / 11 (x64)** or **Windows Server 2016+ (x64)**.
2. **Node.js 22 LTS (22.22.0 or newer 22.x)** installed from [nodejs.org](https://nodejs.org).
3. Internet access during initial setup to download production NPM dependencies and the Chromium browser binary.

### Installation Steps

1. Download `whatsapp-erp-windows-1.0.0-rc.1.zip` from the release artifacts.
2. Extract the archive into a temporary folder on the target machine.
3. Open **PowerShell as Administrator** and navigate to the extracted directory:
   ```powershell
   cd "C:\Path\To\Extracted\whatsapp-erp-windows-1.0.0-rc.1"
   ```
4. Run the automated installer:
   ```powershell
   .\scripts\windows\install.ps1
   ```
   *Customizable parameters:*
   ```powershell
   .\scripts\windows\install.ps1 -InstallRoot 'C:\WhatsApp-ERP' -StateRoot 'C:\ProgramData\WhatsApp-ERP' -Port 3211
   ```
5. The installer will:
   - Validate file checksums against `release-manifest.json` (SHA-256).
   - Copy files to `C:\WhatsApp-ERP\releases\1.0.0-rc.1`.
   - Install production-only dependencies (`npm ci --omit=dev`) and Chromium.
   - Secure `C:\ProgramData\WhatsApp-ERP` with restrictive ACLs.
   - Register and launch the `WhatsAppERPOperations` Windows Scheduled Task.
   - Register the daily 03:00 AM backup task (`WhatsAppERPOperationsBackup`).
6. Open your browser on the server:
   👉 **`http://127.0.0.1:3211`**
7. Complete initial onboarding:
   - Create the administrator username and password.
   - Create your company profile.
   - Configure the SQL Server read-only database connection.
   - Link WhatsApp via the QR code under the **Connections** tab.
   - Map branches to their respective WhatsApp groups under **Branches & Groups**.
   - Review your customers in **Preview** mode, then click **Activate Live** when ready.

---

## Operations & Maintenance Scripts

All scripts are located in `scripts\windows\` within the release folder:

| Task | Command | Description |
| --- | --- | --- |
| **Manual Online Backup** | `.\scripts\windows\backup.ps1` | Takes a live, consistent snapshot using SQLite Online Backup API without downtime. |
| **Full Offline Backup** | `.\scripts\windows\backup.ps1 -Offline` | Gracefully stops the service to back up the WhatsApp session folder as well. |
| **Health Diagnostics** | `.\scripts\windows\diagnose.ps1` | Inspects process status, listening ports, last sync timestamps, and recent error logs. |
| **Verify Backup** | `node .\dist\runtime\scripts\maintenance\admin.js verify-backup --input '<path>'` | Verifies backup database integrity and matching encryption keys without restoring. |
| **Disaster Restore** | `.\scripts\windows\restore.ps1 -BackupPath '<path>'` | Restores a backup safely, resetting company processing to `Preview & Paused` for validation. |
| **Version Upgrade** | `.\scripts\windows\update.ps1` | Upgrades to a new version zero-data-loss, running schema migrations on a staging copy first. |
| **Version Rollback** | `.\scripts\windows\rollback.ps1` | Rolls back code execution pointer to the previous release while preserving current data. |

---

## Local Development & Testing

```sh
# Install dependencies
npm ci

# Typecheck code
npm run typecheck

# Run core logic, lifecycle, and queue tests (38 tests)
npm run test:core

# Run WhatsApp lab integration tests (20 tests)
npm test

# Build production runtime (Fastify + Worker) and frontend (Vite)
npm run build

# Run production release smoke tests (Isolated clean-room execution)
npm run test:release

# Package production release archive (ZIP + SHA-256)
npm run release

# Start pre-compiled production server locally
npm start
```

---

## Security & Verification

- **Read-Only Database Permissions**: Dedicated database credentials should only possess `db_datareader` membership on the target ERP database.
- **Localhost Boundary**: The web application and API bind strictly to `127.0.0.1` and reject non-local Host headers and Cross-Origin requests.
- **Zero-Vulnerability Baseline**: Production runtime dependencies maintain `0 vulnerabilities` under `npm audit --omit=dev`.
- **Credential Storage**: Database passwords and connection details are encrypted at rest with AES-256-GCM using a locally generated machine key.
