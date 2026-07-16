# 서버 폰 배포/운영 메모

실제로 서버 폰(Termux)에 새 코드를 배포하면서 겪은 것들을 정리한다.
설치 안내는 [`server/README.md`](../server/README.md) 참고.

---

## 현재 서버 폰 사양

```
모델: SM-J415N (Galaxy J4+), Android 10
CPU : armeabi-v7a  ← 32비트 전용 (abilist에 arm64 없음)
ADB : 3cb6066a
```

> ⚠️ **32비트 전용**이라는 점이 중요하다. 이 폰의 Termux 환경을 통째로 zip으로 묶어
> 다른 폰에 푸는 방식은 **작동하지 않는다.** 요즘 폰은 대부분 64비트(arm64-v8a)라
> 바이너리가 안 맞는다.

## 코드 업데이트 절차

서버 파일은 git clone이 아니라 **curl로 받은 단일 파일**이다 (`~/mytube-server/mytube-server.py`).
따라서 업데이트 = 파일 다시 받기 + 서버 재시작.

```sh
# 1. 실행 중인 서버 중지 (Ctrl+C)
# 2. 새 코드 받기
curl -sL -o ~/mytube-server/mytube-server.py \
  https://raw.githubusercontent.com/DustinKang60/mytube/main/server/mytube-server.py

# 3. 제대로 받아졌는지 확인 (404 페이지가 저장되는 사고 방지)
grep -c ensure_cached ~/mytube-server/mytube-server.py   # 0보다 크면 OK

# 4. 재시작
bash ~/mytube-server/run.sh
```

**재시작하면 터널 주소가 바뀐다.** 앱 설정에 새 주소를 다시 넣어야 한다.

## ADB로 원격 조작할 때 (PC에서)

Termux는 앱 전용 저장소를 쓰기 때문에 `adb shell`에서 **직접 파일을 못 읽는다**
(`run-as`도 `package not debuggable`로 거부됨). 그래서 화면 캡처로 로그를 읽고,
키 입력을 주입해 조작해야 한다.

```sh
adb devices
adb -s 3cb6066a shell input keyevent 224          # 화면 깨우기 (금방 다시 꺼짐)
adb -s 3cb6066a exec-out screencap -p > screen.png # 로그 읽기
```

### Ctrl+C 보내기 (까다로움)

- ❌ `input keycombination 113 31` → 이 안드로이드 버전엔 **없는 명령**
- ❌ Termux CTRL 키 탭 + 소프트키보드 'c' 탭 → 삼성 키보드 자동완성이 'c'를 삼켜버림
- ✅ **Termux CTRL 키 탭 + `input keyevent 31`** (키 이벤트 주입은 키보드를 우회함)

```sh
adb -s 3cb6066a shell input tap 155 776    # Termux 확장키 행의 CTRL
adb -s 3cb6066a shell input keyevent 31    # KEYCODE_C
```

### 명령어 타이핑

`input text`는 공백을 `%s`로 써야 한다.

```sh
adb -s 3cb6066a shell input text 'bash%s~/mytube-server/run.sh'
adb -s 3cb6066a shell input keyevent 66    # Enter
```

### 스크롤

- ❌ PGUP/PGDN 확장키 → 스크롤이 아니라 **이스케이프 코드가 입력됨** (`^[[5~`)
- ✅ **터치 스와이프**: 아래로 스와이프 = 이전 로그 보기

```sh
adb -s 3cb6066a shell input swipe 360 300 360 720 300   # 위로 스크롤(과거 로그)
adb -s 3cb6066a shell input swipe 360 720 360 200 300   # 아래로(최신 로그)
```

## 터널 주소 확인

`run.sh`로 띄우면 주소는 **터미널 스크롤백에만** 남는다 (파일로 안 씀).
위로 스와이프해서 이 배너를 찾으면 된다:

```
Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):
https://xxxx-xxxx-xxxx.trycloudflare.com
```

`boot-setup.sh`로 부팅 자동시작을 설정한 경우엔 주소가 `~/mytube-server/current-url.txt`에
기록되므로 Termux에서 `myurl` 명령으로 바로 확인할 수 있다.
(설치·사용법은 [server/README.md](../server/README.md) 참고)

## 로그 읽는 법

### 정상 (병렬 캐시 동작)

```
[cache] Yd4Oc_Nxe8w: 64.9MB in 12s (5.47 MB/s, 16 conns)
127.0.0.1 - "GET /audio/Yd4Oc_Nxe8w HTTP/1.1" 200 -
```

### 정상이지만 오해하기 쉬운 것들

| 로그 | 실제 의미 |
|---|---|
| `stream N canceled by remote` | **오류 아님.** 새 곡을 탭하면 앱이 이전 다운로드를 취소(`abort`)하는데 그게 이렇게 찍힘 |
| 같은 영상 GET이 2~3번 | "서버 준비 중" 대기가 길어 사용자가 다시 탭한 것. 캐시된 뒤엔 즉시 응답 |
| `Failed to refresh DNS local resolver` | cloudflared의 일시적 DNS 경고. 터널은 계속 동작하며 자동 복구됨 |
| `/fetch ... 502` | 일시적. 앱에 공개 프록시 폴백 + 목록 캐시가 있어 사용자에겐 거의 안 보임 |

### 진짜 문제

| 로그 | 의미 |
|---|---|
| `Requested format is not available` | **라이브 스트림**. yt-dlp가 m4a를 못 뽑음 → 지원 안 함 |
| `[cache] <id> failed (...) — proxy fallback` | 병렬 다운로드 실패 → 느린 단일 스트리밍으로 폴백됨 |

## 상태 점검 (PC에서)

```sh
adb -s 3cb6066a shell "ps -A -o NAME | grep -iE 'python|cloudflared'"   # 프로세스 확인

URL="https://<현재-터널-주소>"
curl -s -m 15 "$URL/health"    # {"ok":true} 나오면 정상
```

## 캐시 관리

- 위치: `~/mytube-server/audio-cache/`
- 상한: **4GB** (`MYTUBE_CACHE_MAX_MB`로 조절), 넘으면 오래 안 쓴 것부터 삭제(LRU)
- 병렬 연결 수: **16** (`MYTUBE_DL_CONNS`로 조절)
