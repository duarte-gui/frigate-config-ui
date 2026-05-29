#!/usr/bin/env bash
# Frigate Config UI — instalador
#
# Uso:
#   sudo bash install.sh                # instala ou atualiza
#   sudo bash install.sh --uninstall    # remove o serviço e os arquivos
#
# Instalação direta (sem clonar):
#   curl -fsSL https://raw.githubusercontent.com/duarte-gui/frigate-config-ui/master/install.sh | sudo bash
#
# Roda no MESMO host do Frigate (o proxy fala com http://127.0.0.1:5000).
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/duarte-gui/frigate-config-ui/master"
INSTALL_DIR="/opt/frigate-ui"
UNIT="/etc/systemd/system/frigate-ui.service"
FILES=(server.py index.html app.js)
PORT=8000

log()  { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[aviso]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[erro]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "rode como root (use: sudo bash install.sh)"

# ---------- desinstalar ----------
if [ "${1:-}" = "--uninstall" ]; then
  log "parando e removendo o serviço frigate-ui..."
  systemctl disable --now frigate-ui 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  rm -rf "$INSTALL_DIR"
  log "removido. (a config do Frigate não foi tocada)"
  exit 0
fi

# ---------- pré-requisitos ----------
command -v python3   >/dev/null || die "python3 não encontrado."
command -v systemctl >/dev/null || die "systemd (systemctl) não encontrado."
command -v curl      >/dev/null || die "curl não encontrado."

# diretório deste script (permite instalar a partir de um clone local)
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo .)"

fetch() { # fetch <arquivo> <destino>
  local f="$1" dest="$2"
  if [ -f "$SRC_DIR/$f" ]; then
    cp -f "$SRC_DIR/$f" "$dest"
  else
    curl -fsSL "$REPO_RAW/$f" -o "$dest" || die "falha ao baixar $f"
  fi
}

# ---------- backup de instalação anterior ----------
if [ -d "$INSTALL_DIR" ]; then
  bk="$INSTALL_DIR.bak-$(date +%Y%m%d-%H%M%S)"
  log "backup da instalação atual em $bk"
  cp -a "$INSTALL_DIR" "$bk"
fi

# ---------- instalar arquivos ----------
log "instalando arquivos em $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
for f in "${FILES[@]}"; do fetch "$f" "$INSTALL_DIR/$f"; done

log "instalando unidade systemd em $UNIT"
fetch frigate-ui.service "$UNIT"

# ---------- ativar serviço ----------
log "habilitando e iniciando o serviço"
systemctl daemon-reload
systemctl enable --now frigate-ui
sleep 1
if systemctl is-active --quiet frigate-ui; then
  log "serviço frigate-ui ativo"
else
  warn "frigate-ui não subiu — investigue com: journalctl -u frigate-ui -e"
fi

# ---------- checagens informativas ----------
if curl -fsS -o /dev/null --max-time 4 "http://127.0.0.1:5000/api/config" 2>/dev/null; then
  log "Frigate detectado em http://127.0.0.1:5000"
else
  warn "Frigate não respondeu em http://127.0.0.1:5000 — o proxy precisa do Frigate no mesmo host."
fi

ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; ip="${ip:-localhost}"
log "pronto → http://$ip:$PORT"
