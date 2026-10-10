#!/bin/bash
# DocuVault Oracle VM bootstrap (Ubuntu 22.04/24.04, Ampere A1 free tier).
# Run as ubuntu user. App code is copied separately (see deploy/README below).
set -euo pipefail

# Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# cloudflared (for stable HTTPS tunnel -> Meta webhooks)
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared jammy main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

cd /home/ubuntu/docuvault
npm ci --omit=dev

# .env must already be in place (copy from laptop, then set OCI_USE_INSTANCE_PRINCIPAL=true on the VM)
sudo cp deploy/docuvault.service /etc/systemd/system/docuvault.service
sudo systemctl daemon-reload
sudo systemctl enable --now docuvault
echo "--- status ---"
systemctl is-active docuvault
tail -n 5 /home/ubuntu/docuvault/*.log 2>/dev/null || journalctl -u docuvault --no-pager -n 5
