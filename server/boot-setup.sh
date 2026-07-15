#!/data/data/com.termux/files/usr/bin/bash
#
# mytube 서버 부팅 자동시작 설정 (안드로이드 Termux 용)
# ------------------------------------------------------
# 폰을 재부팅해도 서버 + 터널이 저절로 켜지게 만듭니다.
#
# 사전 준비: F-Droid 에서 "Termux:Boot" 앱을 설치하고 한 번 실행해 두세요.
#            https://f-droid.org/packages/com.termux.boot/
#
# 실행:
#   curl -sL https://raw.githubusercontent.com/DustinKang60/mytube/main/server/boot-setup.sh | bash
#
# 설정 후에는:
#   myurl   → 현재 터널 주소를 출력 (앱 설정에 붙여넣을 주소)

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
HOME_DIR="${HOME:-/data/data/com.termux/files/home}"
APP_DIR="$HOME_DIR/mytube-server"
BOOT_DIR="$HOME_DIR/.termux/boot"
PORT="${PORT:-8080}"

echo "==> 사전 확인"
if [ ! -f "$APP_DIR/mytube-server.py" ]; then
  echo "!! $APP_DIR/mytube-server.py 가 없습니다."
  echo "   먼저 서버 설치를 실행하세요:"
  echo "   curl -sL https://raw.githubusercontent.com/DustinKang60/mytube/main/server/setup.sh | bash"
  exit 1
fi
command -v cloudflared >/dev/null 2>&1 || echo "   (경고) cloudflared 가 없습니다 — 터널 없이 로컬로만 동작합니다."

echo "==> 부팅 스크립트 생성: $BOOT_DIR/start-mytube.sh"
mkdir -p "$BOOT_DIR"
cat > "$BOOT_DIR/start-mytube.sh" <<'BOOTEOF'
#!/data/data/com.termux/files/usr/bin/bash
# 부팅 시 Termux:Boot 가 이 스크립트를 실행합니다.
# 화면이 꺼져도 CPU/네트워크를 유지하도록 wake lock 을 겁니다.
termux-wake-lock 2>/dev/null || true

APP_DIR="$HOME/mytube-server"
LOG_DIR="$APP_DIR/logs"
PORT=8080
mkdir -p "$LOG_DIR"

export PORT
# node 가 있으면 yt-dlp 서명 해독에 사용 (추출 안정성)
if command -v node >/dev/null 2>&1; then export YTDLP_JS_RUNTIME=node; fi

# 중복 실행 방지 — 이미 떠 있으면 정리하고 새로 시작
pkill -f "mytube-server.py" 2>/dev/null
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1

echo "[$(date)] 서버 시작" >> "$LOG_DIR/server.log"
python "$APP_DIR/mytube-server.py" >> "$LOG_DIR/server.log" 2>&1 &
sleep 3

if command -v cloudflared >/dev/null 2>&1; then
  : > "$LOG_DIR/tunnel.log"
  cloudflared tunnel --url "http://localhost:$PORT" >> "$LOG_DIR/tunnel.log" 2>&1 &

  # 터널 주소가 로그에 나타나면 파일로 기록해 둔다 (myurl 로 확인)
  for i in $(seq 1 40); do
    URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG_DIR/tunnel.log" | head -1)
    if [ -n "$URL" ]; then
      echo "$URL" > "$APP_DIR/current-url.txt"
      echo "[$(date)] 터널 주소: $URL" >> "$LOG_DIR/server.log"
      break
    fi
    sleep 2
  done
fi
BOOTEOF
chmod +x "$BOOT_DIR/start-mytube.sh"

echo "==> 주소 확인 명령(myurl) 생성"
cat > "$PREFIX/bin/myurl" <<'URLEOF'
#!/data/data/com.termux/files/usr/bin/bash
# 현재 터널 주소를 출력합니다. 앱 → 설정 → 백그라운드 재생 서버 에 붙여넣으세요.
F="$HOME/mytube-server/current-url.txt"
if [ -s "$F" ]; then
  cat "$F"
else
  echo "(아직 주소가 없습니다. 서버가 켜지는 중이거나 터널이 실패했을 수 있습니다.)"
  echo "로그: ~/mytube-server/logs/tunnel.log"
fi
URLEOF
chmod +x "$PREFIX/bin/myurl"

echo ""
echo "########################################################"
echo "# 설정 완료!"
echo "#"
echo "# 남은 일 (한 번만):"
echo "#  1) F-Droid 에서 'Termux:Boot' 설치 후 한 번 실행"
echo "#     https://f-droid.org/packages/com.termux.boot/"
echo "#  2) 안드로이드 설정 → 앱 → Termux → 배터리 → '제한 없음'"
echo "#  3) 폰을 충전기에 연결해 두기"
echo "#"
echo "# 이제 재부팅하면 서버와 터널이 저절로 켜집니다."
echo "#"
echo "# 주소 확인:   myurl"
echo "# 지금 바로 켜기: bash ~/.termux/boot/start-mytube.sh"
echo "########################################################"
