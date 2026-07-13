#!/data/data/com.termux/files/usr/bin/bash
#
# mytube 서버 설치 스크립트 (안드로이드 Termux 용)
# -------------------------------------------------
# Termux 앱에서 아래 한 줄만 실행하면 됩니다:
#
#   curl -sL https://raw.githubusercontent.com/DustinKang60/mytube/main/server/setup.sh | bash
#
# python + yt-dlp + nodejs(JS 런타임) + cloudflared(터널) 를 설치하고
# 서버를 실행하는 헬퍼 스크립트(run.sh)를 만들어 줍니다.

set -e

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
HOME_DIR="${HOME:-/data/data/com.termux/files/home}"
APP_DIR="$HOME_DIR/mytube-server"
PORT="${PORT:-8080}"

echo "==> 패키지 업데이트"
pkg update -y && pkg upgrade -y

echo "==> python / nodejs / curl 설치"
pkg install -y python nodejs-lts curl || pkg install -y python nodejs curl

echo "==> yt-dlp 설치 (pip)"
pip install -U yt-dlp

echo "==> cloudflared(무료 터널) 설치"
if ! command -v cloudflared >/dev/null 2>&1; then
  pkg install -y cloudflared 2>/dev/null || {
    echo "    pkg 저장소에 없어 바이너리를 내려받습니다 (aarch64)"
    curl -L -o "$PREFIX/bin/cloudflared" \
      https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
    chmod +x "$PREFIX/bin/cloudflared"
  }
fi

echo "==> 서버 코드 내려받기"
mkdir -p "$APP_DIR"
curl -sL -o "$APP_DIR/mytube-server.py" \
  https://raw.githubusercontent.com/DustinKang60/mytube/main/server/mytube-server.py

echo "==> 실행 스크립트(run.sh) 생성"
cat > "$APP_DIR/run.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# mytube 서버 + Cloudflare 터널을 함께 실행합니다.
# 화면을 꺼도 유지되도록 wake lock 을 겁니다.
termux-wake-lock 2>/dev/null || true

export PORT=$PORT
export YTDLP_JS_RUNTIME=node   # nodejs 로 서명 해독 (안정성)

echo "오디오 서버 시작 (포트 $PORT)..."
python "$APP_DIR/mytube-server.py" &
SERVER_PID=\$!

sleep 2
echo ""
echo "=================================================================="
echo " 아래 https://....trycloudflare.com 주소를 mytube 앱 설정에 입력하세요"
echo "=================================================================="
cloudflared tunnel --url http://localhost:$PORT

kill \$SERVER_PID 2>/dev/null || true
EOF
chmod +x "$APP_DIR/run.sh"

echo ""
echo "설치 완료!  이제 서버를 켜려면 아래 명령을 실행하세요:"
echo ""
echo "    bash ~/mytube-server/run.sh"
echo ""
echo "실행하면 나오는 https://xxxx.trycloudflare.com 주소를"
echo "mytube 앱 → 설정 → '백그라운드 재생 서버' 칸에 붙여넣고 저장하면 됩니다."
