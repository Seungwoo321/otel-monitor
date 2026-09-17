<div align="center">

<img src="assets/icon.png" width="104" alt="">

# OTel Monitor

**Claude Code 의 텔레메트리를 눈으로 확인하는 macOS 앱**

[![macOS](https://img.shields.io/badge/macOS-13%2B-black)](#설치)
[![Universal](https://img.shields.io/badge/build-universal-black)](#설치)
[![License](https://img.shields.io/badge/license-MIT-black)](LICENSE)

<img src="assets/banner.png" width="100%" alt="">

</div>

---

## 왜 만들었나

Claude Code 의 OpenTelemetry 를 켜면 사용량 메트릭이 주기적으로 수집 서버로 나간다.
숫자만 나가고 프롬프트나 코드는 안 나가는데, 정작 그걸 확인할 방법이 없었다.

- 전송 성공·실패가 로컬에 안 남는다
- 실패는 `claude --debug` 를 켜야 보인다
- 설정을 바꿔도 뭐가 달라졌는지 알 수 없다

그래서 중간에 하나 세워두고 지나가는 걸 들여다보기로 했다.

## 어떻게 동작하나

로컬에서 OTLP 를 받아 풀어본 뒤, 수집 서버로 받은 바이트를 그대로 넘긴다.
기존 수집은 그대로 두고 내용만 본다.

```
Claude Code
    │  OTLP/HTTP (protobuf)
    ▼
OTel Monitor  :4319     ← 디코딩 · 기록 · 유출 감지
    │  원본 그대로 릴레이
    ▼
원래 수집 서버 (선택)
```

헤더까지 그대로 넘기므로 수집 서버 입장에서는 달라지는 게 없다.
전달할 서버를 비워두면 **로컬 전용 뷰어**로만 쓸 수도 있다.

## 화면

<div align="center">
<img src="assets/screenshot.png" width="100%" alt="">
</div>

| 영역 | 내용 |
|---|---|
| **상단 통계** | 받은 요청 · 누적 용량 · 토큰 · 비용 · 세션 · 커밋/PR · 코드 변경 · 활동 시간 · 전달 실패 · 내용 유출. 창 폭에 맞춰 열 수가 바뀐다 |
| **필터** | `user.email`·`unit`·`model` 등 원하는 속성으로 스트림·통계·차트를 한 번에 거른다 |
| **수신 스트림** | 요청 하나하나를 시각 · 신호 종류 · 크기 · 메트릭명 · 응답과 함께 나열 |
| **인스펙터** | 선택한 요청의 전체 속성. 개인 식별 정보는 색으로 구분. 경계선을 드래그해 너비 조정 |
| **차트** | 토큰(input/output) · 비용 · 활동 시간 · 코드 변경. 호버하면 그 지점의 값을 모두 보여준다. 이번 실행 / 7 · 30 · 90일 전환 |
| **설정** | 포트 · 전달 서버 · 전달 on/off, 테마, 기록 보관 기간, 업데이트 확인, 설정 파일 진단 |

### 내용 유출 감지

아래 항목이 페이로드에 섞여 들어오면 상단에 배너가 뜬다.

- **로그(이벤트) 신호 자체** — `OTEL_LOGS_EXPORTER` 가 켜졌다는 뜻이다
- **내용 필드** — `prompt`, `response`, `tool_parameters`, `error`, `api_request_body` 등이
  비어 있지 않고 `<REDACTED>` 도 아닌 경우

설정 탭에서 `settings.json` 을 읽어 내용 노출 키 6종이 켜져 있는지도 확인할 수 있다.

### 날짜별 기록

날짜·계정별 사용량 합계를 남긴다. 7·30·90일 추이를 볼 수 있다.
요청 원문은 저장하지 않는다. 볼 일도 없는 데이터를 쌓아둘 이유가 없어서다.

```
~/Library/Application Support/dev.seungwoo.otel-monitor/history.json
```

보관 기간은 기본 90일. 설정에서 바꿀 수 있고, 줄이면 그 자리에서 정리된다.
전체 삭제 버튼도 있다. 1년을 써도 1MB가 안 된다.

### 자동 업데이트

새 버전이 나오면 알려준다. 확인을 눌러야 받는다.

## 설치

[Releases](../../releases) 에서 `.dmg` 를 받아 앱을 `Applications` 로 옮긴다.
Universal 빌드라 Intel · Apple Silicon 모두 동작한다 (macOS 13+).

### Claude Code 연결

설정 파일의 `env` 에 아래를 넣는다. 경로는 `CLAUDE_CONFIG_DIR` 에 따라 다르며 기본은 `~/.claude/settings.json` 이다 — 앱 설정 탭이 실제 경로를 찾아 준다.

```jsonc
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4319"
  }
}
```

이미 수집 서버를 쓰고 있다면 그 주소를 앱 설정의 **전달할 서버 주소** 에 넣는다.
앱이 받은 내용을 그대로 넘기므로 기존 수집은 그대로 유지된다.

> 이미 실행 중인 세션에는 반영되지 않는다. 새 터미널에서 `claude` 를 띄워야 한다.
> 첫 전송까지 최대 1분(기본 export 간격) 걸린다.

## 직접 빌드

```bash
pnpm install
pnpm tauri dev      # 개발
pnpm tauri build    # .app / .dmg
```

Rust 1.77+, Node 20+ 필요. 서명·공증 배포는 [docs/RELEASE-macos.md](docs/RELEASE-macos.md) 참조 —
인증서와 비밀번호는 전부 환경변수로 읽고 저장소에는 넣지 않는다.

## 잡히는 내용

Claude Code 가 내보내는 메트릭은 8종이 전부다.

| 메트릭 | 의미 |
|---|---|
| `session.count` | 세션 시작 횟수 |
| `lines_of_code.count` | 수정한 줄 수 (added/removed) |
| `commit.count` · `pull_request.count` | 커밋 · PR 개수 |
| `cost.usage` | 비용(USD) |
| `token.usage` | 토큰 (input/output/cacheRead/cacheCreation) |
| `code_edit_tool.decision` | 편집 권한 승인 · 거절 |
| `active_time.total` | 실제 활동 시간(초) |

숫자뿐이고 대화 내용은 없다.
다만 로그인 상태면 `user.email`·`organization.id` 가 같이 붙는다. 인스펙터에서 따로 표시된다.

## 만들면서 알게 된 것

- 헤드리스(`claude -p`)는 메트릭을 안 보낸다. 대화형 세션에서만 나간다. 이거 모르고 한참 헤맸다.
- Claude Code 는 매번 "세션 시작 이후 누계"를 통째로 다시 보낸다(cumulative).
  그래서 값을 더하면 안 되고 최신값으로 덮어써야 한다. 처음에 `+=` 로 짰다가
  커밋 수가 두 배로 찍히는 걸 보고 알았다.
- `OTEL_METRICS_EXPORTER` 는 `console,otlp` 처럼 쉼표로 여러 개를 줄 수 있다.
  다만 콘솔 출력이 어디로 가는지는 문서에 안 나온다.
- Claude 설정 폴더의 `telemetry/` 는 Anthropic 자체 분석용(`1p_failed_events`)이라
  여기서 다루는 OTel 과 무관하다. 이름 때문에 헷갈린다.

## 구조

```
src-tauri/src/
  otlp.rs     OTLP 수신 · protobuf 디코딩 · 유출 판정 · 라우팅
  state.rs    캡처 버퍼 · 누적 집계(cumulative) · 전달
  history.rs  날짜별 기록 저장 · 보관 기간 정리
  lib.rs      Tauri 커맨드 · 서버 기동
src/
  index.html  UI · 테마 토큰
  main.js     렌더링 · SVG 차트 · 필터 · 리사이저
scripts/
  build-macos-release.sh   서명 · 공증 · staple
  make-latest-json.sh      업데이터 매니페스트 생성
```

protobuf 는 `opentelemetry-proto` 크레이트로 제대로 디코딩한다.
처음엔 바이너리에서 문자열만 긁어 쓰다가 값이 자꾸 어긋나서 갈아엎었다.

## 안 하는 것

- **요청 원문을 저장하지 않는다.** 캡처는 메모리에만 있고(최대 500건) 앱을 끄면 사라진다.
  디스크에 남는 건 날짜·계정별 합계와 유출 기록뿐이다. 원문이 필요하면 JSON/CSV 로 내보낸다.
- 지나가는 내용을 바꾸지 않는다. 보는 도구지 막는 도구가 아니다.
- 앱이 꺼져 있으면 그 구간은 전달되지 않는다. 중간에 끼워 넣는 이상 어쩔 수 없다.

## 라이선스

[MIT](LICENSE)
