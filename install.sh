#!/usr/bin/env bash
# Установка доски на свой сервер (Ubuntu 24.04 или Debian 12). Запускать от имени root.
# Запуск: bash <(curl -fsSL https://raw.githubusercontent.com/davidmkrtican8-create/board-app/main/install.sh)
set -euo pipefail
REPO="${REPO:-https://github.com/davidmkrtican8-create/board-app.git}"
APP=/opt/board
DATA=/var/lib/board

say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
die(){ printf '\n\033[31mОшибка: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "запустите от имени root (на новом сервере вы обычно уже root)."
command -v apt-get >/dev/null || die "нужна Ubuntu или Debian."

say "Шаг 1 из 6. Два вопроса"
read -rp "Адрес сайта (домен, например board.example.ru). Если домена нет, просто нажмите Enter: " DOMAIN
DOMAIN="${DOMAIN// /}"
while :; do
  read -rp "Придумайте пароль преподавателя (латинские буквы и цифры, не короче 8 знаков): " PASS
  [[ "$PASS" =~ ^[A-Za-z0-9._-]{8,}$ ]] && break
  echo "Пароль должен состоять из латинских букв и цифр (можно . _ -) и быть не короче 8 знаков."
done
IP="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
[ -n "$IP" ] || IP="$(hostname -I | awk '{print $1}')"
if [ -z "$DOMAIN" ]; then
  DOMAIN="${IP//./-}.sslip.io"
  echo "Домена нет, будет временный адрес: $DOMAIN"
fi

say "Шаг 2 из 6. Устанавливаю программы (несколько минут)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates
node_ok(){ command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; }
if ! node_ok; then
  apt-get install -y nodejs || true
  if ! node_ok; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
fi
node_ok || die "не удалось установить Node.js"
if ! command -v caddy >/dev/null; then
  apt-get install -y caddy || {
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
  }
fi

say "Шаг 3 из 6. Скачиваю доску"
id board >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin board
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q
  git -C "$APP" reset -q --hard '@{u}'
else
  git clone -q "$REPO" "$APP"
fi
mkdir -p "$DATA" /var/backups/board
chown -R board:board "$DATA"

say "Шаг 4 из 6. Настраиваю запуск"
( umask 077; printf 'ADMIN_KEY=%s\nPORT=3000\nHOST=127.0.0.1\nDATA_DIR=%s\n' "$PASS" "$DATA" > /etc/board.env )
cat > /etc/systemd/system/board.service <<EOF
[Unit]
Description=Доска репетитора
After=network.target

[Service]
User=board
WorkingDirectory=$APP
EnvironmentFile=/etc/board.env
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
}
EOF
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

say "Шаг 5 из 6. Автообновление и копии"
cat > /usr/local/bin/board-update <<'EOF'
#!/usr/bin/env bash
# Подтягивает новые файлы с GitHub и перезапускает доску; данные не трогает.
set -e
cd /opt/board
git fetch -q
if [ "$(git rev-parse HEAD)" != "$(git rev-parse '@{u}')" ]; then
  git reset -q --hard '@{u}'
  systemctl restart board
fi
EOF
chmod +x /usr/local/bin/board-update
cat > /etc/cron.d/board <<EOF
*/5 * * * * root /usr/local/bin/board-update >/dev/null 2>&1
0 4 * * * root tar czf /var/backups/board/board-\$(date +\%F).tgz -C /var/lib board && find /var/backups/board -name 'board-*.tgz' -mtime +14 -delete
EOF
systemctl daemon-reload
systemctl enable --now board
systemctl restart board
systemctl enable caddy
systemctl restart caddy

say "Шаг 6 из 6. Проверка"
sleep 4
curl -fsS http://127.0.0.1:3000/health >/dev/null || die "доска не запустилась. Покажите текст команды: journalctl -u board -n 30"
echo "Сервер доски работает."
DNSIP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')"
if [ "$DNSIP" != "$IP" ]; then
  echo "ВНИМАНИЕ: адрес $DOMAIN пока указывает на «${DNSIP:-ничего}», а не на этот сервер ($IP). Проверьте A-запись у регистратора домена; защищённое соединение заработает само, когда DNS обновится."
fi
say "Готово!"
echo "Сайт:                  https://$DOMAIN"
echo "Кабинет преподавателя: https://$DOMAIN/t   (пароль: тот, что вы только что придумали)"
echo "Сертификат HTTPS выдаётся автоматически, это занимает до минуты. Обновления с GitHub подтягиваются сами каждые 5 минут."
