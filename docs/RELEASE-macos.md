# macOS Release — Signing, Notarization & Distribution

OTel Monitor is a Tauri v2 desktop app. This document covers producing a
**signed + notarized + stapled** `.dmg`/`.app` on your Mac that teammates can
open without Gatekeeper warnings.

The repo holds **configuration only** — no certificates, no passwords, no API
keys. All signing/notarization credentials are read from environment variables
at build time and never committed.

---

## 1. One-time Apple-side prerequisites (you do this once)

You need a paid Apple Developer membership, then:

1. **Developer ID Application certificate** — create it in the Apple Developer
   portal (Certificates → "Developer ID Application") and install it into your
   **login keychain** on this Mac. Verify it is present:

   ```bash
   security find-identity -v -p codesigning
   # look for a line like:
   #   1) ABCDEF... "Developer ID Application: Jane Doe (AB12CD34EF)"
   ```

   The full quoted string is your `APPLE_SIGNING_IDENTITY`.

2. **Your Team ID** — the 10-character string in parentheses above
   (`AB12CD34EF`), also visible in the Apple Developer portal (Membership).

3. **Notarization credentials** — pick **one** of two methods:

   - **Method A — App-specific password.** At <https://appleid.apple.com>
     → Sign-In and Security → App-Specific Passwords, generate one.
     This is NOT your Apple ID password.

   - **Method B — App Store Connect API key.** In App Store Connect → Users and
     Access → Integrations → App Store Connect API, create a key. Download the
     `.p8` file (you can only download it once) and note the **Key ID** and the
     **Issuer ID**.

You do **not** need to register the cert in the repo or run `notarytool`
manually — Tauri's bundler signs, submits to Apple's notary service, waits, and
staples the ticket automatically when the env vars below are set.

---

## 2. Environment variables

### Always required (signing)

| Var | Example |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Jane Doe (AB12CD34EF)` |

### Notarization — provide EXACTLY ONE method

**Method A — Apple ID + app-specific password**

| Var | Example |
| --- | --- |
| `APPLE_ID` | `jane@example.com` |
| `APPLE_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | `AB12CD34EF` |

**Method B — App Store Connect API key**

| Var | Example |
| --- | --- |
| `APPLE_API_KEY` | `AB12CD34EF` (the Key ID) |
| `APPLE_API_ISSUER` | `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee` (Issuer UUID) |
| `APPLE_API_KEY_PATH` | `/Users/you/keys/AuthKey_AB12CD34EF.p8` |

Do not put these in any committed file. Export them in your shell session, or
keep them in a local, git-ignored file you `source` (e.g. `~/.OTel Monitor-signing.env`).

---

## 3. Build command

```bash
# 1. export your credentials (Method A example)
export APPLE_SIGNING_IDENTITY="Developer ID Application: Jane Doe (AB12CD34EF)"
export APPLE_ID="jane@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="AB12CD34EF"

# 2. run the release script (validates env, then builds + signs + notarizes + staples)
./scripts/build-macos-release.sh
```

The script fails fast with a clear list of what's missing if any required var is
absent, and it never starts a build with incomplete credentials. Under the hood
it runs:

```bash
pnpm tauri build --bundles app,dmg
```

Output bundles land in `src-tauri/target/release/bundle/macos/` (the `.app`)
and `src-tauri/target/release/bundle/dmg/` (the `.dmg`).

### Verify the result

This is the acceptance gate for a web-download release. All four must pass:

```bash
APP="src-tauri/target/release/bundle/macos/OTel Monitor.app"
DMG="src-tauri/target/release/bundle/dmg/OTel Monitor_0.1.0_aarch64.dmg"

# 1. signature + hardened runtime (must list "Developer ID Application: …")
codesign --verify --deep --strict --verbose=2 "$APP"

# 2. the .app carries a stapled ticket (works offline, required for web download)
xcrun stapler validate "$APP"          # -> "The validate action worked!"

# 3. the .dmg carries a stapled ticket
xcrun stapler validate "$DMG"          # -> "The validate action worked!"

# 4. Gatekeeper accepts both, offline
spctl -a -vvv -t exec    "$APP"        # -> accepted / source=Notarized Developer ID
spctl -a -vvv -t install "$DMG"        # -> accepted / source=Notarized Developer ID
```

> The `.app` **and** the `.dmg` must each be stapled. Stapling the `.dmg` alone
> is not enough — once a user drags the app out of the disk image, the app needs
> its own ticket to pass Gatekeeper offline.

---

## 4. Signing configuration in this repo

`src-tauri/tauri.conf.json` → `bundle.macOS`:

- `hardenedRuntime: true` — required for notarization. (This is also the Tauri
  default; it is set explicitly to document intent.)
- `minimumSystemVersion: "13.0"` — the distributable targets macOS 13 (Ventura)+.

There is **no `signingIdentity` and no `entitlements`** in the config, on
purpose:

- **`signingIdentity` is intentionally absent** so the bundler reads the
  identity from `APPLE_SIGNING_IDENTITY` at build time. This keeps the repo
  free of any developer-specific value.
- **No entitlements file is needed.** OTel Monitor is a standard WKWebView app:
  - The host process loads no unsigned in-process code and does no in-process
    JIT. WebKit's JavaScript JIT runs in the OS-provided, separately-entitled
    `com.apple.WebKit.WebContent` helper — not in the OTel Monitor host process —
    so the host needs no `com.apple.security.cs.allow-jit` /
    `allow-unsigned-executable-memory`.
  - The runner launches the system `node` as a **separate child process**
    (`exec`), not by loading it into the host. Hardened runtime gates
    *in-process* library/code loading, not child `exec`, so no
    `com.apple.security.cs.disable-library-validation` is required.

  Adding entitlements would only widen the security surface without benefit, so
  none are added. Revisit only if a future feature loads unsigned dylibs into
  the host process or needs in-process JIT.

---

## 5. Distribution prerequisites for teammates

- **Nested native binaries are signed automatically.** The runner's bundled
  dependencies (`runner/dist-deps/node_modules`) DO contain a native binary: the
  Claude Code CLI (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`) that the
  Anthropic SDK spawns. It is an extension-less **Mach-O executable**. We re-sign
  it under our own Developer ID so the whole bundle is self-consistent under one
  Team ID (rationale and notary evidence in §6.1). Tauri's bundler deep-signs
  only the main executable, `externalBin`
  entries, and frameworks — **not** files under `bundle.resources` — so this
  binary is signed by `scripts/sign-nested-binaries.sh`, wired as
  `build.beforeBundleCommand` in `tauri.conf.json`. That hook runs after dep
  staging and before Tauri bundles/signs the `.app`, so the re-signature travels
  into the copied bundle and Tauri's outer signing then seals everything. The
  scan is **content-based** (`file` reports "Mach-O", not by file extension), so
  any future bundled native binary is covered automatically with no config
  changes. When `APPLE_SIGNING_IDENTITY` is unset (plain/dev `pnpm tauri build`)
  the hook is a no-op, so unsigned builds are unaffected.

- **End-user machines must have Node.js installed.** The runner does not bundle
  a Node runtime; it spawns the **system `node`** found on the user's machine.
  A teammate without Node installed will be able to open the app but the runner
  will fail to launch agents. Tell recipients to install Node (e.g. via the
  official installer, Homebrew, `nvm`, or a version manager) before use.

---

## 6. Notarization latency vs. failure — how to tell them apart

Apple's notary service is a queue. A submission normally finishes in 1–5 min,
but **multi-minute to occasionally 30+ min "In Progress" stalls happen with no
fault on our side**, even when Apple's status page shows the service as
operational. A long stall is **not** evidence that the artifact, signing, or
credentials are wrong.

How to distinguish a transient queue stall from a real rejection:

```bash
source ~/.config/otel-monitor/release.env   # APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID

# Are submissions reaching Apple at all, and did any Accept?
xcrun notarytool history \
  --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"

# Verbatim result for one submission (the source of truth — read "status" + "issues")
xcrun notarytool log <submission-id> \
  --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
```

- `status: Accepted`, `issues: null` → done. Just **staple** (see §6.2); no rebuild.
- `status: Invalid` → read the `issues` array; that names the exact file/problem.
- `notarytool log` says "not yet available" while `--wait` still shows
  `In Progress` → the job is simply still queued. **Wait, or re-submit the same
  zip** — a fresh submission of the identical artifact typically clears in
  minutes. Do not start changing the build to "fix" a stall.

> **Root cause record (2026-06-17):** a submission sat "In Progress" for 40+ min
> and `notarytool log` reported "not yet available". The prime suspect was the
> nested-binary re-signing (§5). It was **not** the cause: the same submission
> (`1412d853-…`) later resolved to `Accepted`, `issues: null`, with the
> re-signed `claude` binary present in `ticketContents`. A fresh re-notarization
> of the identical artifact (`59789a5f-…`) Accepted in ~2 min. Conclusion: it
> was a **transient notary-queue delay**, not an artifact/method defect. The
> `beforeBundleCommand` re-signing in §5 is correct and was kept. The 04:56
> `2054f7cc-…` build, whose nested `claude` carried Anthropic's original
> signature (cdhash `f50f22a2…`), Accepted; the 05:05 `1412d853-…` build, whose
> `claude` we re-signed under our Team ID (cdhash `fc6c1993…`), also Accepted.
> So notary accepts the nested Mach-O under either signer — we sign it ourselves
> for the bundle-consistency reason in §6.1, not because Apple forces it on this
> particular binary today.

### 6.1 Why we re-sign the nested binary

Empirically (see the root-cause record above), Apple's notary accepts the nested
`claude` Mach-O **either** under Anthropic's signature **or** under ours — so
re-signing is not strictly forced by today's notary checks. We do it anyway for
two structural reasons:

- **Bundle consistency under one Team ID.** A `.app` whose every Mach-O is
  signed under our Developer ID is self-consistent and fully under our control.
  A third-party signature inside our bundle is outside our control and can
  change shape across SDK updates (different cert, expiry, hardened-runtime
  flags), any of which could start tripping notary or Gatekeeper later.
- **Supported, deterministic path.** The hook is content-based and idempotent
  (§5): whatever native binaries the SDK ships, they end up signed by us with no
  config changes. Relying on the upstream signature would make our release
  correctness depend on a vendor's signing decisions.

The cost is one extra `codesign` over a ~210 MB binary at bundle time; the
benefit is a bundle we fully own. Keep it.

### 6.2 Recovery path — notarize an already-signed `.app` without recompiling

If a build produced a correctly **signed** `.app` but the notarize/staple step
was interrupted (e.g. the notary stalled and the build was killed), you do **not**
need to recompile. Re-notarize the existing bundle and rebuild the `.dmg` around
the stapled app:

```bash
source ~/.config/otel-monitor/release.env
APP="src-tauri/target/release/bundle/macos/OTel Monitor.app"

# 0. sanity: the app must already be signed under your Developer ID
codesign --verify --deep --strict --verbose=2 "$APP"

# 1. notarize the .app (zip just for upload; keepParent preserves the .app name)
ditto -c -k --keepParent "$APP" /tmp/adeck.zip
xcrun notarytool submit /tmp/adeck.zip \
  --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" \
  --wait --timeout 30m
# on Accepted, staple the ticket INTO the .app
xcrun stapler staple "$APP"

# 2. build the .dmg from the now-stapled .app (same tool Tauri uses)
cd src-tauri/target/release/bundle/dmg
rm -f "OTel Monitor_0.1.0_aarch64.dmg"
bash bundle_dmg.sh \
  --volname "OTel Monitor" \
  --icon "OTel Monitor.app" 180 170 \
  --app-drop-link 480 170 \
  --window-size 660 400 \
  --hide-extension "OTel Monitor.app" \
  "OTel Monitor_0.1.0_aarch64.dmg" "../macos/OTel Monitor.app"

# 3. sign, notarize, and staple the .dmg itself
codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "OTel Monitor_0.1.0_aarch64.dmg"
xcrun notarytool submit "OTel Monitor_0.1.0_aarch64.dmg" \
  --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" \
  --wait --timeout 30m
xcrun stapler staple "OTel Monitor_0.1.0_aarch64.dmg"
```

Then run the four verification checks in §3. This produces the same artifact the
full `build-macos-release.sh` pipeline does; it just skips the recompile when a
good signed `.app` already exists.
