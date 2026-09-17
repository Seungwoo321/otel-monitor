#!/usr/bin/env bash
#
# 릴리즈 산출물에서 updater 용 latest.json 을 만든다.
# tauri build 가 만든 .app.tar.gz 와 그 .sig 를 읽어 조립한다.
#
# Usage: ./scripts/make-latest-json.sh <version>
set -euo pipefail

VERSION="${1:?사용법: $0 <version>   예: 0.2.0}"
REPO="Seungwoo321/otel-monitor"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="${ROOT}/src-tauri/target/universal-apple-darwin/release/bundle/macos"

TARGZ="$(ls -t "${BUNDLE}"/*.app.tar.gz 2>/dev/null | head -1)"
[[ -n "${TARGZ}" ]] || { echo "✗ .app.tar.gz 가 없습니다. createUpdaterArtifacts 가 켜져 있는지 확인하세요." >&2; exit 1; }
[[ -f "${TARGZ}.sig" ]] || { echo "✗ 서명(.sig)이 없습니다. TAURI_SIGNING_PRIVATE_KEY 를 설정하고 빌드하세요." >&2; exit 1; }

SIG="$(cat "${TARGZ}.sig")"
NAME="$(basename "${TARGZ}")"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${NAME}"
DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "${ROOT}/latest.json" <<JSON
{
  "version": "${VERSION}",
  "notes": "자세한 변경 내용은 릴리즈 노트를 참고하세요.",
  "pub_date": "${DATE}",
  "platforms": {
    "darwin-aarch64": { "signature": "${SIG}", "url": "${URL}" },
    "darwin-x86_64":  { "signature": "${SIG}", "url": "${URL}" }
  }
}
JSON

echo "✓ latest.json 생성"
echo "  버전 : ${VERSION}"
echo "  자산 : ${NAME}"
echo
echo "다음: gh release upload v${VERSION} latest.json \"${TARGZ}\" \"${TARGZ}.sig\""
