# mytube 백그라운드 재생 서버

이 서버를 켜두면 mytube 앱에서 **화면을 꺼도, 다른 앱을 써도 오디오가 계속 재생**됩니다.
(서버 없이 앱만 쓰면 유튜브 임베드로 재생되어 화면을 꺼야 소리가 끊깁니다.)

## 원리
- 앱은 videoId 를 서버에 요청합니다.
- 서버는 `yt-dlp` 로 유튜브 오디오(m4a) 주소를 뽑아 **바이트를 그대로 중계**합니다.
- 앱은 그걸 일반 `<audio>` 로 재생 → 브라우저가 백그라운드 재생을 허용합니다.
- 유튜브 오디오 주소는 "추출한 기기의 IP" 에 잠기므로, URL 을 넘기지 않고 서버가 직접 흘려보냅니다.

> ⚠️ 서버는 **가정용 인터넷(집 와이파이)** 에서 돌리세요. 클라우드/VPS(데이터센터 IP)는
> 유튜브 봇 차단에 걸려 불안정합니다. 항상 켜둘 수 있는 안 쓰는 안드로이드폰이 이상적입니다.

---

## A. 안드로이드폰으로 (권장)

### 1. Termux 설치
- **F-Droid** 에서 Termux 를 설치하세요: https://f-droid.org/packages/com.termux/
- (구글 플레이스토어 버전은 낡아서 동작하지 않습니다.)

### 2. 한 줄로 설치
Termux 를 열고 아래를 붙여넣고 실행:
```sh
curl -sL https://raw.githubusercontent.com/DustinKang60/mytube/main/server/setup.sh | bash
```
python · yt-dlp · nodejs · cloudflared 를 자동으로 설치합니다. (몇 분 걸립니다.)

### 3. 서버 켜기
```sh
bash ~/mytube-server/run.sh
```
잠시 뒤 `https://xxxx.trycloudflare.com` 같은 주소가 나옵니다.

### 4. 앱에 주소 등록
mytube 앱 → 오른쪽 위 ⚙️ 설정 → **"백그라운드 재생 서버"** 칸에 그 주소를 붙여넣고 **저장**.
`✓ 서버 연결됨` 이 뜨면 완료. 이제 화면을 꺼도 재생됩니다.

### 배터리로 안 꺼지게 (중요)
- 폰을 **충전기에 연결**해 두세요.
- 안드로이드 설정 → 앱 → **Termux → 배터리 → 제한 없음**.
- `run.sh` 는 자동으로 `termux-wake-lock` 을 걸어 화면을 꺼도 CPU·네트워크를 유지합니다.

---

## B. PC(윈도우)로 (PC 를 켜두는 동안만)

파이썬과 yt-dlp 가 설치돼 있어야 합니다.
```powershell
pip install -U yt-dlp
python mytube-server.py            # 포트 8080 으로 시작
```
그 다음 [cloudflared](https://github.com/cloudflare/cloudflared/releases) 로 터널을 엽니다:
```powershell
cloudflared tunnel --url http://localhost:8080
```
나오는 `https://xxxx.trycloudflare.com` 주소를 앱 설정에 등록하면 됩니다.
PC 를 끄면 앱은 자동으로 유튜브 임베드로 폴백합니다.

---

## 참고
- `trycloudflare.com` 주소는 서버를 다시 켤 때마다 **바뀝니다**. 바뀌면 앱 설정에서 주소만 다시 저장하세요.
  (고정 주소가 필요하면 Cloudflare 계정 + 도메인으로 named tunnel 을 쓰면 됩니다.)
- 서버 상태 확인: 브라우저에서 `<주소>/health` → `{"ok":true}` 가 나오면 정상.
- 개인용(본인 시청)으로만 쓰세요.
