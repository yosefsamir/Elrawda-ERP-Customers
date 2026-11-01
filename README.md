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
  - Automated PowerShell deployment (`scripts/windows/install.ps1`) creating a monitored Windows Scheduled Task under `LOCAL SERVICE` with auto-restart on crash.
  - Online consistent backups using the SQLite Online Backup API scheduled daily at 03:00 AM.
  - Secure state directory isolation under `C:\ProgramData\WhatsApp-ERP`, writable only by `SYSTEM`, `Administrators`, and the service's task SID in its working folders.

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

## Windows Customer Deployment & Quick Start Guide

### Prerequisites
- **Operating System:** Windows 10, Windows 11, or Windows Server 2016+ (64-bit / x64).
- **Permissions:** Windows Administrator privileges.
- **Internet Connection:** Active connection for initial setup (needed to fetch Chromium and runtime packages).
- **Node.js:** Node.js 22 LTS (x64) is automatically downloaded and installed if not already present.

---

### Option 1: One-Click Windows Installer (`Setup.exe`) — Recommended

1. **Download & Transfer:**
   Copy `WhatsAppERP-Setup-1.0.0-rc.1.exe` to the customer machine (via USB or remote transfer).
2. **Run as Administrator:**
   Right-click `WhatsAppERP-Setup-1.0.0-rc.1.exe` and select **Run as administrator** (accept the UAC prompt).
3. **Follow the Setup Wizard:**
   - Click **Next** and proceed with the default settings (`C:\WhatsApp-ERP`).
   - The installer verifies the environment, extracts files, installs dependencies, and registers the background services.
   - On the final screen, keep **"Open WhatsApp-ERP Web Interface"** checked and click **Finish**.

*To run silently without user interaction:*
```powershell
.\WhatsAppERP-Setup-1.0.0-rc.1.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

---

### Option 2: Standalone ZIP Archive (No Inno Setup Required)

If you are deploying directly using the pre-packaged ZIP archive:

1. **Download & Extract:**
   Download `whatsapp-erp-windows-1.0.0-rc.1.zip` from the release artifacts and extract it to a temporary folder (e.g. `C:\Temp\whatsapp-erp-windows-1.0.0-rc.1`).
2. **Open PowerShell as Administrator:**
   Press `Win + X`, select **Terminal (Admin)** or **PowerShell (Run as administrator)**.
3. **Run the Automated Installer:**
   Navigate into the extracted `scripts\windows` directory and execute:
   ```powershell
   cd "C:\Path\To\Extracted\whatsapp-erp-windows-1.0.0-rc.1\scripts\windows"
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

#### What Happens Automatically in the Background:
- **Node.js 22 Detection:** If Node.js is missing, the script automatically downloads and silently installs official `Node.js 22 LTS (node-v22.23.4-x64.msi)`.
- **Target Directories:** Copies release files to immutable `C:\WhatsApp-ERP\releases\1.0.0-rc.1`.
- **Protected State:** Creates `C:\ProgramData\WhatsApp-ERP`, writable only by `SYSTEM`, `Administrators`, and the service's task SID in its working folders.
- **Automated Tasks:** Registers two Windows Scheduled Tasks:
  - `WhatsAppERPOperations`: Automatically starts at machine boot under `NT AUTHORITY\LOCAL SERVICE` with a per-task SID and restarts on unexpected exits.
  - `WhatsAppERPOperationsBackup`: Daily consistent SQLite online backup at 03:00 AM.
- **Service Verification:** Starts the service immediately and verifies readiness against `http://127.0.0.1:3211/healthz`.

---

### First-Time Onboarding in the Web Interface

Once installation completes, open your browser on the host machine and navigate to:
👉 **`http://127.0.0.1:3211`**

Perform the following 4 initial configuration steps:

1. **Create Administrator Account:**
   - Enter your administrator username and secure password on the bootstrap screen.
2. **Configure ERP Database Connection:**
   - Navigate to the **Settings / Database** section.
   - Enter your SQL Server host, port (default `1433`), database name, username, and password.
   - Click **Test Connection** to confirm connectivity, then save.
3. **Pair WhatsApp Web:**
   - Go to the **Connections / WhatsApp** tab.
   - A QR Code will appear on screen.
   - On the dedicated business phone, open WhatsApp > **Linked devices** > **Link a device**, and scan the QR code.
   - Status will transition to **Ready** (Green).
4. **Link Branches & Activate Live Processing:**
   - Under **Branches & Groups**, assign each store branch to its corresponding WhatsApp Community Group (or assign to the Unified Global Group).
   - Review incoming customers in **Preview** mode.
   - Switch the operating mode from **Preview / Paused** to **Live** to begin automated sync and onboarding.

---

### Verification & Troubleshooting

- **Check Service Status:**
  ```powershell
  Get-ScheduledTask -TaskName 'WhatsAppERPOperations', 'WhatsAppERPOperationsBackup'
  ```
- **Run Diagnostics:**
  ```powershell
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\WhatsApp-ERP\releases\1.0.0-rc.1\scripts\windows\diagnose.ps1"
  ```
- **Log Locations:**
  - Installation Transcript: `C:\ProgramData\WhatsApp-ERP\logs\install.log`
  - Runtime Service Logs: `C:\ProgramData\WhatsApp-ERP\logs\launcher.log`

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
