# WhatsApp-ERP Windows Installer (Inno Setup)

This directory contains the Inno Setup packaging configuration and automation for creating the standalone Windows installer:

`WhatsAppERP-Setup-1.0.0-rc.1.exe`

---

## 1. Architecture & Deployment Model

The installer packages a **completely self-contained portable Node.js runtime and Puppeteer Chromium browser** directly inside Inno Setup:

- **Application Binaries & Runtime:** `C:\WhatsApp-ERP\releases\<version>`
  - Bundled Node.js 22 LTS x64: `runtime\node.exe`
  - Bundled Puppeteer Chromium: `runtime\chromium`
  - Bundled production dependencies: `node_modules` (including pre-compiled `better-sqlite3` native addon)
- **Persistent Customer State & Databases:** `C:\ProgramData\WhatsApp-ERP` (contains SQLite WAL database, SQL Server encryption keys, WhatsApp sessions, and logs)
- **Windows Scheduled Tasks:**
  - `WhatsAppERPOperations`: Startup task running as `NT AUTHORITY\LOCAL SERVICE` with a per-task SID via `launcher.ps1`, with the Chromium sandbox enabled
  - `WhatsAppERPOperationsBackup`: Daily offline backup task running at 03:00
- **Process Isolation:** Invokes `scripts\windows\install.ps1` with process-scoped execution policy bypass:
  ```powershell
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "install.ps1"
  ```
- **Security & ACLs:** Only `SYSTEM` and `Administrators` can change the install folder. In `C:\ProgramData\WhatsApp-ERP`, the service's task SID can write only to `data`, `cache`, `temp` and `logs`. Other `LOCAL SERVICE` processes have no access.
- **Zero Data Loss Upgrades:** Re-running the installer on an existing machine triggers the safe upgrade pipeline (`update.ps1`), taking an offline snapshot before migrating without deleting customer state.

---

## 2. Prerequisites

### For Building the Installer (Development / CI Runner):
1. **Windows 10 / 11 / Server (x64)** (or GitHub Actions `windows-latest` runner)
2. **Node.js 22 LTS (>= 22.22.0, x64)**
3. **Inno Setup 6**:
   - Via winget:
     ```powershell
     winget install JRSoftware.InnoSetup
     ```
   - Or download directly from [JRSoftware Inno Setup](https://jrsoftware.org/isdl.php).

### For Installing at the Customer Machine:
1. **Windows 10 / 11 or Windows Server 2016+ (64-bit)**
2. **Administrator Rights** (the installer requests standard UAC elevation)
3. **NO Internet Access Required** (the installer is 100% offline and self-contained)
4. **NO Development Tools Required** (no Node.js, npm, Python, or Visual Studio Build Tools needed on customer machines)

---

## 3. How to Build `Setup.exe`

Run the automated build script in PowerShell (or trigger the GitHub Actions workflow `.github/workflows/build-windows-installer.yml`):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "installer\build-installer.ps1"
```

### What the build script does:
1. Executes `scripts\release.mjs --bundle-runtime` to build the web bundle, compile runtime JavaScript, bundle portable `node.exe` and `chromium`, prepare production dependencies, and compute SHA-256 hashes in `release-manifest.json`.
2. Locates the Inno Setup Compiler (`ISCC.exe`) in standard directories and registry keys.
3. Compiles `installer\WhatsAppERP.iss` with dynamic version synchronization from `package.json`.
4. Outputs the final executable to:
   ```
   release\WhatsAppERP-Setup-1.0.0-rc.1.exe
   ```
5. Calculates the SHA-256 checksum and saves it to:
   ```
   release\WhatsAppERP-Setup-1.0.0-rc.1.exe.sha256
   ```

---

## 4. How to Install at Customer Machine

### Option A: Standard Interactive Installation (Recommended)
1. Copy `WhatsAppERP-Setup-1.0.0-rc.1.exe` to the customer server.
2. Double-click and accept the UAC prompt (or right-click and choose **Run as administrator**).
3. Follow the wizard steps:
   - The installer verifies 64-bit Windows architecture.
   - Extracts the complete self-contained payload to temporary staging.
   - Executes `install.ps1` in the background with marquee progress.
   - Performs runtime preflight validation (better-sqlite3 read/write and Chromium launch).
   - Upon completion, the Finish page provides an option to immediately open:
     `http://127.0.0.1:3211`
4. In the web interface, initialize the administrator credentials and configure your company ERP database.

### Option B: Silent / Unattended Installation
For automated or remote management deployments:

```powershell
.\WhatsAppERP-Setup-1.0.0-rc.1.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

### Option C: Debug Mode (Show PowerShell Console)
To see live console output during installation:

```powershell
.\WhatsAppERP-Setup-1.0.0-rc.1.exe /SHOWCONSOLE=1
```

---

## 5. Upgrade Mechanics

When `WhatsAppERP-Setup-*.exe` is run on a machine where WhatsApp-ERP is already installed:
1. The installer detects `C:\ProgramData\WhatsApp-ERP\service.json`.
2. It invokes `install.ps1 -Upgrade`, which automatically delegates to `update.ps1`.
3. The new release is staged in an isolated directory and validated with `preflight.js`.
4. The background service is stopped gracefully.
5. An offline snapshot backup is created under `C:\ProgramData\WhatsApp-ERP\backups\before-<version>-...`.
6. An isolated schema probe validates database compatibility.
7. The service configuration is atomically updated and restarted.
8. If startup validation fails and schema is compatible, it automatically rolls back to the previous release.
9. Existing scheduled tasks, encryption keys, SQLite data, and WhatsApp authentication sessions are fully preserved.

---

## 6. Verification & Troubleshooting

### Verification Commands:
- **Web UI:** Navigate to `http://127.0.0.1:3211`
- **Health Endpoint:** Run `curl http://127.0.0.1:3211/healthz`
  Expected response: `{"ok":true,"version":"1.0.0-rc.1",...}`
- **Diagnostic Script:**
  ```powershell
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\WhatsApp-ERP\releases\1.0.0-rc.1\scripts\windows\diagnose.ps1"
  ```

### Log File Locations:
- **Installation Log:** `C:\ProgramData\WhatsApp-ERP\logs\install.log`
- **Runtime Launcher Log:** `C:\ProgramData\WhatsApp-ERP\logs\launcher.log`
- **Inno Setup Internal Log:** Pass `/LOG="C:\WhatsApp-ERP\setup.log"` during installation.

### Failure Handling:
If `install.ps1` exits with a non-zero exit code:
- Setup stops on the Preparing to Install page with the error code and the path to `install.log`.
- Setup exits with code 7 and registers no uninstaller or Apps entry.
- Customer data is not deleted. Rerun Setup after fixing the cause.

If `uninstall.ps1` fails, the uninstaller stops with a non-zero exit code and stays registered so it can be run again. Customer data under `C:\ProgramData\WhatsApp-ERP` is kept in every case.
