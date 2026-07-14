#!/data/data/com.termux/files/usr/bin/bash
#
# mytube 서버 설치 스크립트 (안드로이드 Termux 용)
# -------------------------------------------------
# Termux 앱에서 아래 한 줄만 실행하면 됩니다:
#
#   curl -sL https://raw.githubusercontent.com/DustinKang60/mytube/main/server/setup.sh | bash
#
# python + yt-dlp + cloudflared(터널) 를 설치하고, 서버 실행 헬퍼(run.sh)를 만듭니다.
# nodejs 는 있으면 추출 안정성이 좋아지므로 "가능하면" 설치합니다(실패해도 계속).

# 대화형 프롬프트(y/n, 설정파일 유지 여부 등)로 멈추지 않도록.
export DEBIAN_FRONTEND=noninteractive

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
HOME_DIR="${HOME:-/data/data/com.termux/files/home}"
APP_DIR="$HOME_DIR/mytube-server"
PORT="${PORT:-8080}"

echo "==> 패키지 목록 갱신"
yes | pkg update -y >/dev/null 2>&1 || true

echo "==> 필수 패키지 설치 (python, curl)"
yes | pkg install -y python curl || { echo "!! python 설치 실패"; exit 1; }

echo "==> yt-dlp 설치 (pip)"
pip install -U yt-dlp || { echo "!! yt-dlp 설치 실패"; exit 1; }

echo "==> nodejs 설치 시도 (선택 — 실패해도 계속 진행)"
HAS_NODE=0
if yes | pkg install -y nodejs-lts 2>/dev/null || yes | pkg install -y nodejs 2>/dev/null; then
  HAS_NODE=1
  echo "    nodejs 설치됨"
else
  echo "    nodejs 생략 (없이도 동작)"
fi

echo "==> cloudflared(무료 터널) 설치"
if ! command -v cloudflared >/dev/null 2>&1; then
  if ! (yes | pkg install -y cloudflared 2>/dev/null); then
    ARCH="$(uname -m)"
    case "$ARCH" in
      aarch64|arm64) CF="arm64" ;;
      armv7l|armv8l|arm) CF="arm" ;;
      x86_64) CF="amd64" ;;
      *) CF="arm64" ;;
    esac
    echo "    바이너리 내려받기 (linux-$CF)"
    curl -L -o "$PREFIX/bin/cloudflared" \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CF" \
      && chmod +x "$PREFIX/bin/cloudflared"
  fi
fi
command -v cloudflared >/dev/null 2>&1 || echo "!! cloudflared 설치 실패 — 터널 없이 서버만 동작"

echo "==> 서버 코드 내려받기"
mkdir -p "$APP_DIR"
curl -sL -o "$APP_DIR/mytube-server.py" \
  https://raw.githubusercontent.com/DustinKang60/mytube/main/server/mytube-server.py

echo "==> 실행 스크립트(run.sh) 생성"
cat > "$APP_DIR/run.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# mytube 서버 + Cloudflare 터널을 함께 실행합니다.
termux-wake-lock 2>/dev/null || true
export PORT=$PORT
# nodejs 가 있으면 서명 해독에 사용(안정성). 없으면 생략.
if command -v node >/dev/null 2>&1; then export YTDLP_JS_RUNTIME=node; fi

echo "오디오 서버 시작 (포트 $PORT)..."
python "$APP_DIR/mytube-server.py" &
SERVER_PID=\$!
sleep 2

if command -v cloudflared >/dev/null 2>&1; then
  echo ""
  echo "=================================================================="
  echo " 아래 https://....trycloudflare.com 주소를 mytube 앱 설정에 입력하세요"
  echo "=================================================================="
  cloudflared tunnel --url http://localhost:$PORT
else
  echo "cloudflared 가 없어 로컬로만 동작합니다 (http://localhost:$PORT)"
  wait \$SERVER_PID
fi
kill \$SERVER_PID 2>/dev/null || true
EOF
chmod +x "$APP_DIR/run.sh"

echo ""
echo "########################################################"
echo "# 설치 완료!  서버를 켜려면 아래 명령을 실행하세요:"
echo "#"
echo "#     bash ~/mytube-server/run.sh"
echo "#"
echo "# 실행하면 나오는 https://xxxx.trycloudflare.com 주소를"
echo "# mytube 앱 → 설정 → 백그라운드 재생 서버 칸에 넣고 저장!"
echo "########################################################"
