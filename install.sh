#!/usr/bin/env bash
# Установка доски на свой сервер (Ubuntu 24.04 или Debian 12). Запускать от имени root.
# Запуск: bash <(curl -fsSL https://raw.githubusercontent.com/davidmkrtican8-create/board-app/main/install.sh)
set -euo pipefail
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
# у части провайдеров IPv6 не работает, и apt висит на «Waiting for headers»: качаем по IPv4 и не ждём бесконечно
printf 'Acquire::ForceIPv4 "true";\nAcquire::http::Timeout "25";\nAcquire::https::Timeout "25";\nAcquire::Retries "3";\n' > /etc/apt/apt.conf.d/99board-net
apt-get update -y
apt-get install -y curl git ca-certificates openssl coturn
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
# Файлы берём по одному с raw.githubusercontent.com с повторами: из части российских дата-центров
# git clone с github.com обрывается по таймауту, а raw-адрес работает.
cat > /usr/local/bin/board-update <<'EOF'
#!/usr/bin/env bash
# Подтягивает новые файлы доски с GitHub и перезапускает доску; данные (/var/lib/board) не трогает.
set -euo pipefail
RAW="https://raw.githubusercontent.com/davidmkrtican8-create/board-app/main"
APP=/opt/board
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
get(){ curl -4 -fsS --retry 4 --retry-delay 3 --retry-all-errors --connect-timeout 15 --max-time 180 "$RAW/$1?t=$(date +%s)" -o "$T/$1"; }
get files.txt
FILES="$(grep -E '^[A-Za-z0-9._-]+$' "$T/files.txt" || true)"
[ -n "$FILES" ] || exit 1
changed=0
for f in $FILES; do get "$f"; cmp -s "$T/$f" "$APP/$f" || changed=1; done
[ "$changed" = 1 ] || exit 0
mkdir -p "$APP"
for f in $FILES; do install -m 0644 "$T/$f" "$APP/$f"; done
[ "${1:-}" = "--no-restart" ] || systemctl restart board
EOF
chmod +x /usr/local/bin/board-update
/usr/local/bin/board-update --no-restart || die "не удалось скачать файлы доски с GitHub. Запустите установку ещё раз через пару минут."
[ -f "$APP/server.js" ] || die "файлы доски не скачались"
mkdir -p "$DATA" /var/backups/board
chown -R board:board "$DATA"

say "Шаг 4 из 6. Настраиваю запуск"
TURN_SECRET="$(sed -n 's/^TURN_SECRET=//p' /etc/board.env 2>/dev/null || true)" # секрет ретранслятора звонков сохраняем при переустановке
[ -n "$TURN_SECRET" ] || TURN_SECRET="$(openssl rand -hex 32)"
( umask 077; printf 'ADMIN_KEY=%s\nPORT=3000\nHOST=127.0.0.1\nDATA_DIR=%s\nTURN_SECRET=%s\nTURN_HOST=%s\n' "$PASS" "$DATA" "$TURN_SECRET" "$DOMAIN" > /etc/board.env )
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
  ufw allow 3478 >/dev/null; ufw allow 5349/tcp >/dev/null; ufw allow 49160:49260/udp >/dev/null
fi
# ретранслятор звонков (coturn): если напрямую соединиться нельзя, звук и видео идут через этот сервер
TIP="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"
TLS=""
if [ -f /etc/board-cert/cert.pem ]; then # сертификат, выпущенный board-cert (DNS-проверка), подходит и для turns:
  usermod -aG caddy turnserver
  TLS="tls-listening-port=5349
cert=/etc/board-cert/cert.pem
pkey=/etc/board-cert/key.pem
no-tlsv1
no-tlsv1_1"
fi
cat > /etc/turnserver.conf <<EOF
listening-port=3478
listening-ip=$TIP
relay-ip=$TIP
min-port=49160
max-port=49260
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=$DOMAIN
$TLS
no-cli
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
total-quota=60
stale-nonce=600
syslog
EOF
chown root:turnserver /etc/turnserver.conf; chmod 640 /etc/turnserver.conf
[ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn

say "Шаг 5 из 6. Автообновление и копии"
cat > /etc/cron.d/board <<EOF
*/5 * * * * root /usr/local/bin/board-update >/dev/null 2>&1
0 4 * * * root tar czf /var/backups/board/board-\$(date +\%F).tgz -C /var/lib board && find /var/backups/board -name 'board-*.tgz' -mtime +14 -delete
EOF
systemctl daemon-reload
systemctl enable --now board
systemctl restart board
systemctl enable caddy
systemctl restart caddy
systemctl enable coturn >/dev/null 2>&1
systemctl restart coturn || echo "ВНИМАНИЕ: ретранслятор звонков (coturn) не запустился: journalctl -u coturn -n 20"

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
