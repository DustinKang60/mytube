# mytube 백그라운드 재생 서버

이 서버를 켜두면 mytube 앱에서 **화면을 꺼도, 다른 앱을 써도 오디오가 계속 재생**됩니다.
(서버 없이 앱만 쓰면 유튜브 임베드로 재생되어 광고가 나오고, 화면을 끄면 소리가 끊깁니다.)

## 원리

1. 앱이 videoId 를 서버에 요청합니다.
2. 서버가 `yt-dlp` 로 유튜브 오디오(m4a) 주소를 뽑고, **16개 연결로 나눠서 통째로 내려받아**
   폰에 저장합니다. (한 번 받은 곡은 캐시되어 다음엔 즉시 응답)
3. 앱은 그 **완성된 파일을 통째로 받아 메모리에 올려두고** 재생합니다.
4. 재생 중엔 네트워크가 전혀 필요 없으므로 **화면을 꺼도 끝까지 재생**됩니다.
   (다운받은 팟캐스트가 백그라운드에서 잘 나오는 것과 같은 원리)

> **왜 통째로 받나?** 유튜브는 **연결 하나당 실시간 배속(~30KB/s)으로만** 오디오를 흘려보냅니다.
> 그래서 스트리밍은 재생보다 앞서 나가질 못하고, 화면을 끄면 브라우저가 네트워크를 멈춰서
> 쌓아둔 2분치 버퍼를 다 쓰는 순간 끊깁니다. 이 제한은 **연결마다** 걸리므로 여러 연결로 나눠
> 받으면 우회됩니다. 실측 **5.5MB/s — 1시간짜리(64.9MB)가 12초**.

> ⚠️ 서버는 **가정용 인터넷(집 와이파이)** 에서 돌리세요. 클라우드/VPS(데이터센터 IP)는
> 유튜브 봇 차단에 걸려 불안정합니다. 항상 켜둘 수 있는 안 쓰는 안드로이드폰이 이상적입니다.

> ⚠️ **라이브 방송은 재생되지 않습니다.** yt-dlp 가 m4a 를 뽑을 수 없어서(`Requested format is
> not available`) 지원하지 않습니다.

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

> 💡 **타이핑이 번거로우면**: 서버 폰의 브라우저로 이 페이지를 열고 위 명령을 **복사** 한 뒤,
> Termux 화면을 **길게 눌러 붙여넣기** 하세요.

### 3. 서버 켜기
```sh
bash ~/mytube-server/run.sh
```
잠시 뒤 `https://xxxx.trycloudflare.com` 같은 주소가 나옵니다.

### 4. 앱에 주소 등록
mytube 앱 → 오른쪽 위 ⚙️ 설정 → **"백그라운드 재생 서버"** 칸에 그 주소를 붙여넣고 **저장**.
`✓ 서버 연결됨` 이 뜨면 완료. 이제 화면을 꺼도 재생됩니다.

### 5. 재부팅해도 자동으로 켜지게 (선택, 권장)
폰을 재부팅해도 서버와 터널이 저절로 켜지게 만듭니다.

**사전 준비**: F-Droid 에서 **Termux:Boot** 를 설치하고 **한 번 실행**해 두세요.
https://f-droid.org/packages/com.termux.boot/

```sh
curl -sL https://raw.githubusercontent.com/DustinKang60/mytube/main/server/boot-setup.sh | bash
```

설정 후에는:
```sh
myurl          # 현재 터널 주소를 출력 (앱 설정에 붙여넣을 주소)
```
```sh
bash ~/.termux/boot/start-mytube.sh    # 재부팅 없이 지금 바로 켜기
```

> ⚠️ 재부팅하면 **터널 주소가 바뀝니다.** `myurl` 로 새 주소를 확인해 앱 설정에 다시 넣으세요.
> (`run.sh` 로 직접 켠 경우엔 주소가 터미널에만 나오므로, 화면을 위로 스크롤해서 찾아야 합니다.)

### 배터리로 안 꺼지게 (중요)
- 폰을 **충전기에 연결**해 두세요.
- 안드로이드 설정 → 앱 → **Termux → 배터리 → 제한 없음**.
- `run.sh` 와 부팅 스크립트는 자동으로 `termux-wake-lock` 을 걸어 화면을 꺼도 CPU·네트워크를 유지합니다.

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

## 설정 (환경 변수)

기본값으로 충분하지만, 필요하면 조절할 수 있습니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `8080` | 서버 포트 |
| `MYTUBE_DL_CONNS` | `16` | 다운로드 병렬 연결 수. 늘리면 빨라지지만 과하면 유튜브가 차단할 수 있음 |
| `MYTUBE_CACHE_DIR` | `~/mytube-server/audio-cache` | 받은 오디오를 저장할 위치 |
| `MYTUBE_CACHE_MAX_MB` | `4096` (4GB) | 캐시 상한. 넘으면 **오래 안 쓴 것부터 자동 삭제** |
| `YTDLP_JS_RUNTIME` | (자동) | `node` 가 있으면 자동 사용. 추출 안정성이 좋아짐 |

예: 캐시를 8GB 로 늘리고 연결을 24개로
```sh
MYTUBE_CACHE_MAX_MB=8192 MYTUBE_DL_CONNS=24 bash ~/mytube-server/run.sh
```

## 서버 코드 업데이트

서버는 git 저장소가 아니라 **파일 하나**(`~/mytube-server/mytube-server.py`)로 설치됩니다.
업데이트하려면 서버를 끄고(`Ctrl+C`) 다시 받은 뒤 재시작하세요.

```sh
curl -sL -o ~/mytube-server/mytube-server.py \
  https://raw.githubusercontent.com/DustinKang60/mytube/main/server/mytube-server.py
bash ~/mytube-server/run.sh
```

---

## 문제 해결

**서버가 살아있는지 확인**
브라우저에서 `<주소>/health` → `{"ok":true}` 가 나오면 정상.

**로그에 이런 게 보이는데 괜찮나요?** — 아래는 **모두 정상**입니다.

| 로그 | 실제 의미 |
|---|---|
| `stream N canceled by remote` | 오류 아님. 새 곡을 탭하면 앱이 이전 다운로드를 취소하는데 그게 이렇게 찍힘 |
| 같은 영상 GET 이 2~3번 | "서버 준비 중" 대기가 길어 다시 탭한 것. 캐시된 뒤엔 즉시 응답 |
| `Failed to refresh DNS local resolver` | cloudflared 의 일시적 DNS 경고. 터널은 계속 동작하며 자동 복구됨 |
| `/fetch ... 502` | 일시적. 앱에 공개 프록시 폴백과 목록 캐시가 있어 거의 영향 없음 |

**진짜 문제**

| 로그 / 증상 | 원인과 대처 |
|---|---|
| `Requested format is not available` | **라이브 방송**입니다. 지원하지 않으니 다른 영상을 고르세요 |
| `[cache] <id> failed (...) — proxy fallback` | 병렬 다운로드 실패 → 느린 스트리밍으로 폴백됨. 화면 끄면 끊길 수 있음 |
| 앱에 `✗ 서버에 연결할 수 없습니다` | 주소가 바뀌었을 수 있음 → `myurl` 로 확인해 다시 입력 |
| 화면 끄면 끊김 | 서버 주소가 비었거나 연결 실패 → 유튜브 임베드로 폴백된 상태. 설정에서 주소 확인 |
| 앱을 고쳤는데 반영이 안 됨 | 서비스워커 캐시 때문. 앱을 **완전히 종료**(최근 앱에서 스와이프) 후 다시 열고 새로고침 |

**저장공간이 걱정되면**: 캐시는 `MYTUBE_CACHE_MAX_MB` 상한(기본 4GB)을 넘으면 자동으로
오래된 것부터 지웁니다. 수동으로 비우려면 `rm -rf ~/mytube-server/audio-cache/*`.

## 참고
- `trycloudflare.com` 주소는 서버를 다시 켤 때마다 **바뀝니다**. 바뀌면 앱 설정에서 주소만 다시 저장하세요.
  (고정 주소가 필요하면 Cloudflare 계정 + 도메인으로 named tunnel 을 쓰면 됩니다.)
- 개인용(본인 시청)으로만 쓰세요.
- 개발 배경과 상세 기록: [`md/`](../md/) 폴더 참고.
