# Desktop app

The Electron app packages the React UI, Python 3.14 backend, PDF libraries,
fonts, Tesseract, and English/orientation data. Users install the app without
Node, Python, uv, a terminal, or a separately running server.

PaddleOCR is optional. In the OCR tab choose PaddleOCR and **Install PaddleOCR**.
This explicitly downloads a managed Python 3.12 environment, locked packages,
and pinned models into the app's data folder. After setup it runs offline.
It needs several GB of disk space and is offered on Apple Silicon, Windows x64,
and Linux x64. Intel Macs can use the included Tesseract engine.

## Development and local installers

The Mac installers require macOS 15 or newer, matching the bundled PDF engine.
Build-machine prerequisites: Node 24, pnpm (the version in package.json), uv,
and Tesseract with `eng` and `osd` data. On macOS: `brew install tesseract qpdf`.
On Ubuntu: `sudo apt install tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd`.
On Windows, install Tesseract and put its folder on PATH. These dependencies
are needed only by developers, not by the person installing pdfer.

Intel Mac builds compile pikepdf from source. Before `pnpm install`, set
`QPDF_SOURCE_TREE` to the output of `brew --prefix qpdf` and
`QPDF_BUILD_LIBDIR` to that directory's `lib` subfolder. CI sets these automatically.

```sh
pnpm install
pnpm desktop:dev       # builds the UI, opens Electron, starts the source backend
pnpm desktop:build     # creates an installer for the current OS and architecture
pnpm desktop:smoke     # exercises the actual packaged app and relaunches it
```

`pnpm desktop:pack` makes an unpacked app for quicker local testing.
Installers and unpacked apps appear in `release/`. macOS builds use free ad-hoc
code signing by default, and Sparkle verifies updates with your own free
Ed25519 key. Windows code signing is optional. See the release setup below.
Build on each target OS/architecture; PyInstaller does not cross-compile.
`PDFER_BUILD_TESSERACT` and `PDFER_BUILD_TESSDATA` can select build-machine paths.
The native libraries determine the oldest OS the resulting app can run on;
test on the oldest OS you intend to support.

The existing `pnpm start` browser application and `pnpm dev` remain available.
Desktop development stores data separately from the installed app.

## Local data and privacy

The renderer uses `pdfer://app/` on every launch. Saved projects, preferences,
and workflow presets persist across restarts and app upgrades. The Python
process binds only to an OS-assigned `127.0.0.1` port and requires a random
per-launch token, held by the Electron main process. The renderer cannot use
Node or load remote websites. API requests stream through the private bridge.
No PDF is sent to the update service or OCR download providers.

Installed data lives in Electron's `userData` folder:

- macOS: `~/Library/Application Support/pdfer`
- Windows: `%APPDATA%/pdfer`
- Linux: `$XDG_CONFIG_HOME/pdfer` (normally `~/.config/pdfer`)

`PDFER_USER_DATA_DIR` can override this location. Projects use IndexedDB;
signatures use a local SQLite library. These files are outside the application
bundle and are preserved by updates. Keep the app ID, name, protocol origin,
and data folder stable in future releases. Storage schema changes need migrations.
The desktop app has its own browser profile: existing projects in Chrome or
Safari do not automatically transfer to it. Export their PDFs before moving.

The backend is stopped when the app quits and also watches the parent's pipe
so a crashed app does not leave it running. OCR setup is stopped on exit.
`desktop.log` in the data folder contains bounded startup/setup diagnostics.

## Releases and in-app updates

The release workflow builds all four targets without paid certificates:
macOS arm64/x64 use Sparkle, Windows NSIS and Linux AppImage use electron-updater.
The workflow uses its public GitHub repository (`GITHUB_REPOSITORY`) as the
release host. A private source repository needs a separately configured public
distribution endpoint; never embed a GitHub access token in the installed app.

### One-time free Sparkle key setup

Generate this identity once, before the first release:

If `desktop/sparkle/public-key.json` already exists, reuse that identity. On a
new build machine, restore the private backup instead of generating a new key.

```sh
pnpm desktop:keys
```

The command creates:

- `desktop/sparkle/public-key.json`: public information; commit this file.
- `~/.config/pdfer-signing/sparkle-private-key`: a private, owner-readable
  Ed25519 seed stored outside the repository. Back it up securely.

The command refuses to overwrite an existing identity. All releases and both
Mac architectures must reuse this same key. Replacing the public key will
prevent installed apps from authenticating updates. Key rotation or a lost key
needs a planned migration or manual reinstall.

Add the private seed to the repository's encrypted Actions secrets:

```sh
gh secret set SPARKLE_PRIVATE_KEY --repo kahseng94/pdfer --app actions < "$HOME/.config/pdfer-signing/sparkle-private-key"
```

Keep the seed private; only the public key belongs in Git. The CI signer passes
the secret to Sparkle through stdin. Release builds fail if the secret does not
match the embedded public key. These are free update-authentication keys, with
no Apple Developer membership or certificate purchase required.

### Publish a release

1. Commit the public key and the desktop source changes, and push the project.
2. Set a higher version in the root `package.json`, commit it, and push a
   matching stable tag, such as `v0.1.0` for the first release.
3. The workflow tests and builds every target, then creates one **draft GitHub
   release**. Review and publish that draft to make the update visible.

For a first release, you can instead run **Desktop installers** manually from
`main` with its **release** input enabled. It builds and tests everything before
creating the matching version tag and draft release. Existing version tags must
point at that exact tested commit; the workflow never moves a release tag.

Pushing source code alone does not publish an app update. Before the first
stable release is published, the Mac app shows **No published stable release
is available yet**. Drafts and prereleases do not count as the latest stable
release. A broken published feed or a failed signature remains an error.

For a local release build, set `PDFER_RELEASE_REPOSITORY=kahseng94/pdfer` and
`PDFER_RELEASE=1` before running `pnpm desktop:build`. The signer reads the local
private-key file; `SPARKLE_PRIVATE_KEY_FILE` can select a secure backup file.
Ordinary local builds have updates disabled. The test suite uses disposable
keys and loopback feeds and never publishes artifacts.

Mac builds bundle the pinned, SHA-256-verified Sparkle framework and a small
Node-API bridge. Sparkle authenticates both the appcast and ZIP archive using
Ed25519, verifies before extraction, and handles replacement and relaunch.
`appcast-arm64.xml` and `appcast-x64.xml` point to version-specific release
ZIPs; the app checks the matching architecture's feed at the GitHub latest
release URL. macOS no longer uses Squirrel or `latest-mac.yml`.

Keep the generated DMGs, ZIPs, signed `appcast-*.xml`, Windows/Linux installers,
blockmaps and `latest*.yml` together in the draft release. Don't edit signed
appcasts after generation. Publish all platforms together so the latest release
always contains both Mac feeds. Fix a faulty release by publishing a higher
version, rather than replacing files in an existing version.

Installed apps check at startup, every four hours while running, or when the
user chooses **Check for updates**. Users choose **Download update**, then
**Restart to update**. Unsaved project changes retain the normal keep-editing
prompt. Closing normally cancels Sparkle's staged installation; it never
silently applies an update on an ordinary quit.

The first Sparkle-enabled app must be installed manually: older test builds
have no update feed and cannot acquire this integration automatically.
Existing desktop projects remain in the same profile. Use the normal app
profile for updates; environment/command-line overrides are not preserved by
Sparkle's macOS relaunch, so a custom `PDFER_USER_DATA_DIR` should be used only
with launches you control yourself.

Free signing does not give the app an OS-trusted publisher identity. A Mac
download can require the user's **Privacy & Security → Open Anyway** approval;
Windows can show Unknown Publisher/SmartScreen warnings or block installation
under managed policies. Sparkle verifies updates after the user has installed
and approved the app. A writable installation is simplest; protected locations
may need an OS authorization prompt. Linux updates apply to the provided
AppImage, not to arbitrary store packages.

### Optional OS signing and notarization

These secrets remain supported if you obtain certificates later:

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64 Developer ID Application certificate (.p12) |
| `MAC_CSC_KEY_PASSWORD` | Certificate password |
| `APPLE_API_KEY_BASE64` | Base64 notarization API private key (.p8) |
| `APPLE_API_KEY_ID` | Apple API key ID |
| `APPLE_API_ISSUER` | Apple API issuer ID |
| `WIN_CSC_LINK` | Base64 Windows code-signing certificate (.pfx/.p12) |
| `WIN_CSC_KEY_PASSWORD` | Certificate password |

Without these secrets, Mac builds are ad-hoc signed and Windows installers
are unsigned. When a certificate is supplied, signing failures fail the build.
Mac notarization is enabled when the certificate and all Apple credentials
are present. Hardware/cloud Windows signing services need their corresponding
electron-builder integration instead of a PFX. `PDFER_REQUIRE_OS_SIGNING=1`
can make OS signing mandatory again. Free Sparkle update signing remains in
place regardless of whether Apple signing is enabled.

## Checks

`pnpm test` runs backend, frontend, and desktop tests. `pnpm desktop:smoke`
opens the packaged app twice with temporary data and checks private API access,
PDF merging, PDF.js worker rendering, bundled OCR, Node isolation, and storage
across relaunch. It needs a graphical session (on Linux, use `xvfb-run`).
Screenshots are written to `desktop/build/smoke-*.png`.

On macOS, `pnpm desktop:sparkle-test` builds two isolated ad-hoc-signed apps,
rejects a tampered signed feed and archive, verifies normal-quit cancellation,
then replaces and relaunches `0.1.0 → 0.1.1` through the real Sparkle installer.
It uses a separate test app ID/profile and a temporary signing key. It requires
a graphical user session and runs automatically on both Mac CI architectures.

References: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security),
[electron-updater](https://www.electron.build/v26/docs/features/auto-update/),
[Sparkle](https://sparkle-project.org/documentation/),
[PyInstaller](https://pyinstaller.org/en/stable/).
