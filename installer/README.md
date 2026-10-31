# WhatsApp-ERP Windows Installer (Inno Setup)

This directory contains the Inno Setup packaging configuration and automation for creating the standalone Windows installer:

`WhatsAppERP-Setup-1.0.0-rc.1.exe`

---

## 1. Architecture & Deployment Model

The installer packages the pre-built, verified release payload and integrates directly with the existing production deployment pipeline:

- **Application Binaries:** `C:\WhatsApp-ERP\releases\<version>`
- **Persistent State & Databases:** `C:\ProgramData\WhatsApp-ERP` (contains SQLite WAL database, encryption secrets, WhatsApp sessions, and logs)
- **Windows Scheduled Tasks:**
  - `WhatsAppERPOperations`: Startup task running under `NT AUTHORITY\SYSTEM` via `launcher.ps1`
  - `WhatsAppERPOperationsBackup`: Daily offline backup task running at 03:00
- **Process Isolation:** Invokes `scripts\windows\install.ps1` with process-scoped execution policy bypass:
  ```powershell
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "install.ps1"
  ```
- **Security & ACLs:** Restrictive Windows ACLs ensure only `SYSTEM` and `Administrators` have access to `C:\ProgramData\WhatsApp-ERP`.
- **Zero Data Loss Upgrades:** Re-running the installer on an existing machine triggers the safe upgrade pipeline (`update.ps1`), taking an offline snapshot before migrating without deleting user state.

---

## 2. Prerequisites

### For Building the Installer (Development / Build Machine):
1. **Windows 10 / 11 / Server (x64)**
2. **Node.js 22 LTS (>= 22.22.0, x64)**
3. **Inno Setup 6**:
   - Via winget:
     ```powershell
     winget install JRSoftware.InnoSetup
     ```
   - Or download directly from [JRSoftware Inno Setup](https://jrsoftware.org/isdl.php).

### For Installing at the Customer Machine:
1. **Windows 10 / 11 or Windows Server 2016+ (64-bit)**
2. **Administrator Rights** (the installer requests UAC elevation)
3. **Internet Access** (required for `npm ci --omit=dev` and downloading Chromium via Puppeteer)
4. **Node.js 22 LTS (x64)**:
   - If Node.js is already installed, the installer validates the version (`>= 22.22.0`).
   - If Node.js is missing, the installer will **automatically download and silently install Node.js 22 LTS (`node-v22.23.4-x64.msi`)**.
   - If the machine is completely offline and lacks Node.js, pre-install Node.js 22 x64 before running setup.

---

## 3. How to Build `Setup.exe`

Run the automated build script in PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "installer\build-installer.ps1"
```

### What the build script does:
1. Executes `npm run release` to compile the web bundle, build runtime JavaScript, and compute SHA-256 hashes in `release-manifest.json`.
2. Locates the Inno Setup Compiler (`ISCC.exe`) in standard directories and registry keys.
3. Compiles `installer\WhatsAppERP.iss`.
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
2. Right-click and choose **Run as administrator** (or double-click and accept the UAC prompt).
3. Follow the wizard steps:
   - The installer verifies prerequisites (64-bit architecture, Node.js, internet connectivity).
   - The installer executes `install.ps1` in the background with marquee progress.
   - Upon completion, the Finish page provides a checkbox to immediately open:
     `http://127.0.0.1:3211`
4. In the web interface, initialize the administrator credentials and proceed with ERP SQL Server connection.

### Option B: Silent / Unattended Installation
For automated or remote management deployments:

```powershell
.\WhatsAppERP-Setup-1.0.0-rc.1.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

### Option C: Debug Mode (Show PowerShell Console)
To see live console output from `npm ci`, Chromium downloads, and scheduled task registration:

```powershell
.\WhatsAppERP-Setup-1.0.0-rc.1.exe /SHOWCONSOLE=1
```

---

## 5. Upgrade Mechanics

When `WhatsAppERP-Setup-1.0.0-rc.1.exe` is run on a machine where WhatsApp-ERP is already installed:
1. The installer detects `C:\ProgramData\WhatsApp-ERP\service.json`.
2. It invokes `install.ps1 -Upgrade`, which automatically delegates to `update.ps1`.
3. The background service is stopped gracefully.
4. An offline snapshot backup is created under `C:\ProgramData\WhatsApp-ERP\backups\before-1.0.0-rc.1-...`.
5. An isolated schema probe validates database compatibility.
6. The service pointer is atomically updated and restarted.
7. Existing scheduled tasks, encryption keys, SQLite data, and WhatsApp authentication sessions are fully preserved.

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
- The installer displays an explicit error dialog with the return code.
- It displays the full path to `install.log`.
- It aborts immediately and **never** displays the "Finished" page.
- No changes to existing persistent state are committed.
