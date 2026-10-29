#!/usr/bin/env bash
# Prepares a DEDICATED Linux VM so Miki runs 24/7 in a persistent, auto-logged-in X11 desktop
# session (needed by the computer_* tools) and can be watched remotely.
#
#   sudo deploy/linux/setup-desktop-session.sh [--dry-run]
#
# Settings (environment): MIKI_DESKTOP_USER (default: $SUDO_USER), MIKI_DESKTOP_SESSION (default: xfce),
# MIKI_VNC_PORT (default: 5900), MIKI_VNC_PASSWORD_FILE (default: <home>/.vnc/miki-passwd).
# Run it on the VM only; after a reboot the desktop logs in by itself, agent-miki.service starts after it
# and the remote view (x11vnc, localhost only) comes up. Reach it through an SSH tunnel:
#   ssh -L 5900:localhost:5900 <user>@<vm>   then open a VNC viewer on localhost:5900
set -Eeuo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h) sed -n '2,13p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

DESKTOP_USER="${MIKI_DESKTOP_USER:-${SUDO_USER:-}}"
SESSION="${MIKI_DESKTOP_SESSION:-xfce}"
VNC_PORT="${MIKI_VNC_PORT:-5900}"
fail() { echo "setup-desktop-session: $*" >&2; exit 1; }
[[ -n "$DESKTOP_USER" && "$DESKTOP_USER" != "root" ]] || fail "set MIKI_DESKTOP_USER to the desktop user (not root)"
getent passwd "$DESKTOP_USER" >/dev/null || fail "user $DESKTOP_USER does not exist"
HOME_DIR="$(getent passwd "$DESKTOP_USER" | cut -d: -f6)"
VNC_PASS_FILE="${MIKI_VNC_PASSWORD_FILE:-$HOME_DIR/.vnc/miki-passwd}"
if (( ! DRY_RUN )); then [[ "$(id -u)" == "0" ]] || fail "run as root or use --dry-run"; fi

run() {
  printf '+ '; printf '%q ' "$@"; printf '\n'
  if (( ! DRY_RUN )); then "$@"; fi
}
write_file() { # write_file <path> <mode>; content on stdin
  local target="$1" mode="$2" content
  content="$(cat)"
  echo "+ write $target"
  if (( ! DRY_RUN )); then
    install -d "$(dirname "$target")"
    printf '%s\n' "$content" > "$target"
    chmod "$mode" "$target"
  fi
}

# 1) Packages: X11 desktop + display manager, xdotool/ImageMagick for computer_*, x11vnc for the remote view.
if command -v apt-get >/dev/null 2>&1; then
  run apt-get update
  DESKTOP_PKGS=()
  # The default session is Xfce; for another session install its desktop packages yourself first.
  if [[ "$SESSION" == "xfce" ]]; then DESKTOP_PKGS=(xfce4); fi
  run apt-get install -y lightdm "${DESKTOP_PKGS[@]}" xdotool imagemagick x11vnc x11-xserver-utils
else
  echo "setup-desktop-session: apt-get not found; install an X11 desktop, LightDM, xdotool, ImageMagick and x11vnc manually" >&2
fi

# 2) Auto-login into an X11 session (Wayland is not supported by computer_*).
write_file /etc/lightdm/lightdm.conf.d/50-miki-autologin.conf 0644 <<CONF
[Seat:*]
autologin-user=$DESKTOP_USER
autologin-user-timeout=0
autologin-session=$SESSION
user-session=$SESSION
CONF
run systemctl set-default graphical.target

# 3) Never blank, lock or power off the screen (a locked/blank screen breaks screenshots).
write_file "$HOME_DIR/.config/autostart/miki-no-blank.desktop" 0644 <<DESKTOP
[Desktop Entry]
Type=Application
Name=Miki: keep the screen awake
Exec=sh -c "xset s off; xset -dpms; xset s noblank"
X-GNOME-Autostart-enabled=true
DESKTOP
run chown -R "$DESKTOP_USER:" "$HOME_DIR/.config/autostart"

# 4) Remote view: x11vnc on localhost only, password from a file (create it once with x11vnc -storepasswd).
if [[ ! -f "$VNC_PASS_FILE" ]]; then
  echo "NOTE: create the VNC password file once:  sudo -u $DESKTOP_USER x11vnc -storepasswd $VNC_PASS_FILE"
fi
write_file /etc/systemd/system/miki-x11vnc.service 0644 <<UNIT
[Unit]
Description=Remote view of the Miki desktop (x11vnc, localhost only)
After=display-manager.service
Wants=display-manager.service

[Service]
User=$DESKTOP_USER
Environment=DISPLAY=:0
Environment=XAUTHORITY=$HOME_DIR/.Xauthority
ExecStartPre=/bin/sh -c 'for i in \$(seq 1 60); do [ -e $HOME_DIR/.Xauthority ] && exit 0; sleep 2; done; exit 1'
ExecStart=/usr/bin/x11vnc -display :0 -auth $HOME_DIR/.Xauthority -rfbport $VNC_PORT -localhost -rfbauth $VNC_PASS_FILE -forever -shared -noxdamage
Restart=always
RestartSec=5s

[Install]
WantedBy=graphical.target
UNIT
run systemctl daemon-reload
run systemctl enable miki-x11vnc.service

echo
echo "Done. Next: sudo deploy/linux/install-systemd.sh (installs agent-miki.service for $DESKTOP_USER with DISPLAY=:0),"
echo "then reboot and check: systemctl status agent-miki miki-x11vnc; node bin/miki-doctor.mjs"
if (( DRY_RUN )); then echo "Dry run: nothing was changed."; fi
