#!/bin/bash
set -e

SERVICE_NAME="elrawda-whatsapp"
USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"
mkdir -p "${USER_SYSTEMD_DIR}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cat <<EOF > "${USER_SYSTEMD_DIR}/${SERVICE_NAME}.service"
[Unit]
Description=ElRawda Customer WhatsApp Operations Service
After=network.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
ExecStart=/usr/bin/npx tsx apps/server/index.ts
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3211

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "${SERVICE_NAME}"
loginctl enable-linger "${USER}" 2>/dev/null || true

echo "=========================================================="
echo "تم تثبيت وتفعيل خدمة التشغيل التلقائي بنجاح!"
echo "الخدمة ستعمل تلقائيًا عند إقلاع الجهاز في الخلفية."
echo "للتشغيل الآن: systemctl --user start ${SERVICE_NAME}"
echo "للحالة:      systemctl --user status ${SERVICE_NAME}"
echo "للإيقاف:     systemctl --user stop ${SERVICE_NAME}"
echo "=========================================================="

