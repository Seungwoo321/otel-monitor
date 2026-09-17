#!/usr/bin/env bash
#
# 빌드가 끝난 산출물을 GitHub 릴리즈로 올린다.
# DMG 는 버전 없는 고정 이름으로 올려, 랜딩 링크를 릴리즈마다 고칠 필요가 없게 한다.
#
# Usage: ./scripts/publish-release.sh [version]
#        버전을 생략하면 package.json 의 version 을 쓴다.
#        저장소는 git remote, 자산 이름은 tauri.conf.json 의 productName 에서 얻는다.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="${ROOT}/src-tauri/target/universal-apple-darwin/release/bundle"

# ---------------------------------------------------------------- 인자
ARG_VERSION=""; ARG_REPO=""; ARG_ASSET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) ARG_VERSION="${2:?--version 에 값이 필요합니다}"; shift 2 ;;
    --repo)    ARG_REPO="${2:?--repo 에 owner/name 이 필요합니다}"; shift 2 ;;
    --asset)   ARG_ASSET="${2:?--asset 에 파일명이 필요합니다}"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
사용법: publish-release.sh [옵션]

  --version <x.y.z>      릴리즈 버전 (기본: package.json 의 version)
  --repo <owner/name>    GitHub 저장소 (기본: git remote origin)
  --asset <파일명>       업로드할 DMG 이름 (기본: <productName>-universal.dmg)

공증된 DMG 를 고정 이름으로 올리고, 업데이터 아티팩트가 있으면 latest.json 을 함께 만든다.
USAGE
      exit 0 ;;
    *) printf '알 수 없는 옵션: %s\n' "$1" >&2; exit 1 ;;
  esac
done

info() { printf '\033[32m▸ %s\033[0m\n' "$1"; }
err()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; }

# 인자 > 환경변수 > 프로젝트 파일에서 읽기 순으로 정한다.
VERSION="${ARG_VERSION:-$(node -p "require('${ROOT}/package.json').version" 2>/dev/null || true)}"
[[ -n "${VERSION}" ]] || { err "버전을 알 수 없습니다. --version 으로 주세요."; exit 1; }

REPO="${ARG_REPO:-${GH_REPO:-$(git -C "${ROOT}" remote get-url origin 2>/dev/null \
  | sed -E 's#^(git@[^:]+:|https://[^/]+/)##; s#\.git$##' || true)}}"
[[ -n "${REPO}" ]] || { err "GitHub 저장소를 알 수 없습니다. --repo owner/name 으로 주세요."; exit 1; }

_product="$(node -p "require('${ROOT}/src-tauri/tauri.conf.json').productName" 2>/dev/null || echo app)"
ASSET_NAME="${ARG_ASSET:-$(echo "${_product}" | tr ' ' '-')-universal.dmg}"

info "저장소 ${REPO} · 버전 v${VERSION} · 자산 ${ASSET_NAME}"

DMG="$(ls -t "${BUNDLE}/dmg/"*.dmg 2>/dev/null | head -1)"
[[ -n "${DMG}" ]] || { err "DMG 가 없습니다. 먼저 build-macos-release.sh 를 실행하세요."; exit 1; }

# 공증 여부 확인 — 안 된 것을 올리면 받는 쪽에서 안 열린다
if ! xcrun stapler validate "${DMG}" >/dev/null 2>&1; then
  err "공증(staple)이 되지 않은 DMG 입니다: ${DMG##*/}"
  exit 1
fi
info "공증 확인: ${DMG##*/}"

# 고정 이름으로 사본을 만든다
STAGE="$(mktemp -d)"
cp "${DMG}" "${STAGE}/${ASSET_NAME}"

# 업데이터 아티팩트 (있으면 함께 올린다)
TARGZ="$(ls -t "${BUNDLE}/macos/"*.app.tar.gz 2>/dev/null | head -1)"
EXTRA=()
if [[ -n "${TARGZ}" && -f "${TARGZ}.sig" ]]; then
  SIG="$(cat "${TARGZ}.sig")"
  # GitHub 은 자산명의 공백을 점으로 바꿔 올린다. latest.json 의 URL 도 그 규칙을 따라야
  # 업데이터가 파일을 찾는다 (안 그러면 404 로 조용히 실패한다).
  _asset_basename="$(basename "${TARGZ}" | tr ' ' '.')"
  URL="https://github.com/${REPO}/releases/download/v${VERSION}/${_asset_basename}"
  cat > "${STAGE}/latest.json" <<JSON
{
  "version": "${VERSION}",
  "notes": "자세한 변경 내용은 릴리즈 노트를 참고하세요.",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-aarch64": { "signature": "${SIG}", "url": "${URL}" },
    "darwin-x86_64":  { "signature": "${SIG}", "url": "${URL}" }
  }
}
JSON
  EXTRA=("${TARGZ}" "${TARGZ}.sig" "${STAGE}/latest.json")
  info "업데이터 매니페스트 생성"
else
  err "업데이터 아티팩트가 없습니다 — 자동 업데이트 없이 올립니다."
fi

# 설치 안내는 매 릴리즈 같은 내용이라 여기서 만든다.
# 변경 내역은 GitHub 이 커밋에서 생성한 것(--generate-notes)을 그대로 쓴다.
DL="https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}"
NOTES_FILE="${STAGE}/notes.md"
cat > "${NOTES_FILE}" <<NOTES
## 설치

[${ASSET_NAME}](${DL}) 를 받아 앱을 \`Applications\` 로 옮기세요.
서명·공증돼 있어 경고 없이 열립니다. (macOS 13+, Intel · Apple Silicon)
NOTES

if [[ ${#EXTRA[@]} -gt 0 ]]; then
  cat >> "${NOTES_FILE}" <<'NOTES'

이전 버전이 설치돼 있다면 앱의 **설정 → 업데이트** 에서 바로 올릴 수 있습니다.
NOTES
fi

if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "기존 릴리즈에 자산을 덮어씁니다: v${VERSION}"
  gh release upload "v${VERSION}" --clobber \
    "${STAGE}/${ASSET_NAME}" ${EXTRA[@]+"${EXTRA[@]}"}
else
  info "릴리즈 생성: v${VERSION}"
  # --notes-file 은 --generate-notes 를 무시하므로, 자동 생성분을 먼저 받아 합친다.
  PREV="$(gh release list --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null || true)"
  AUTO=""
  if [[ -n "${PREV}" ]]; then
    AUTO="$(gh api "repos/${REPO}/releases/generate-notes" \
      -f tag_name="v${VERSION}" -f previous_tag_name="${PREV}" \
      --jq '.body' 2>/dev/null || true)"
  else
    AUTO="$(gh api "repos/${REPO}/releases/generate-notes" \
      -f tag_name="v${VERSION}" --jq '.body' 2>/dev/null || true)"
  fi
  if [[ -n "${AUTO}" ]]; then
    printf '\n%s\n' "${AUTO}" >> "${NOTES_FILE}"
  fi

  gh release create "v${VERSION}" \
    --title "v${VERSION}" --notes-file "${NOTES_FILE}" \
    "${STAGE}/${ASSET_NAME}" ${EXTRA[@]+"${EXTRA[@]}"}
fi

rm -rf "${STAGE}"
info "완료 → https://github.com/${REPO}/releases/tag/v${VERSION}"
echo "  다운로드: https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}"
