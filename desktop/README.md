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

Build-machine prerequisites: Node 24, pnpm (the version in package.json), uv,
and Tesseract with `eng` and `osd` data. On macOS: `brew install tesseract`.
On Ubuntu: `sudo apt install tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd`.
On Windows, install Tesseract and put its folder on PATH. These dependencies
are needed only by developers, not by the person installing pdfer.

```sh
pnpm install
pnpm desktop:dev       # builds the UI, opens Electron, starts the source backend
pnpm desktop:build     # creates an installer for the current OS and architecture
pnpm desktop:smoke     # exercises the actual packaged app and relaunches it
```

`pnpm desktop:pack` makes an unpacked app for quicker local testing.
Installers and unpacked apps appear in `release/`. Local macOS builds are
ad-hoc signed for testing. Public distribution needs the signing setup below.
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

No GitHub repository or credentials have been configured in this checkout.
Local builds therefore display that updates are unavailable. The updater UI
and release pipeline are ready to use once the following setup is complete.

1. Create a **public GitHub repository** and push this project. The release
   workflow uses `GITHUB_REPOSITORY` automatically. For a local release build,
   set `PDFER_RELEASE_REPOSITORY=owner/repository` and `PDFER_RELEASE=1`.
   A private source repository needs a separately configured public distribution
   endpoint; never put a GitHub access token into the installed app.
2. Add repository Actions secrets for signing:

   | Secret | Value |
   | --- | --- |
   | `MAC_CSC_LINK` | Base64 Developer ID Application signing certificate (.p12) |
   | `MAC_CSC_KEY_PASSWORD` | Password for that certificate |
   | `APPLE_API_KEY_BASE64` | Base64 App Store Connect API private key (.p8) |
   | `APPLE_API_KEY_ID` | Apple API key ID |
   | `APPLE_API_ISSUER` | Apple API issuer ID |
   | `WIN_CSC_LINK` | Base64 Windows code-signing certificate (.pfx/.p12) |
   | `WIN_CSC_KEY_PASSWORD` | Password for that certificate |

   A Windows certificate backed by hardware or a signing service needs its
   corresponding electron-builder signing configuration instead of a PFX.
   Tagged releases fail if signing/notarization is not configured. The manual
   workflow builds test installers without requiring release credentials.
3. Set a higher version in the root `package.json`, commit, and push a matching
   tag such as `v0.1.0`. Use stable semantic versions with this release workflow.
4. The workflow tests and builds macOS arm64/x64, Windows x64 NSIS, and Linux
   x64 AppImage packages. It creates one **draft GitHub release** after every
   platform succeeds. Review it and publish it to make it visible to the apps.
5. Installed apps check at startup, every four hours while running, or when
   the user clicks **Check for updates**. Users choose **Download update**,
   then **Restart to update**. Unsaved project changes trigger the normal
   keep-editing/discard prompt. Ordinary quitting never installs an update.

Keep all generated installer files, ZIP files, blockmaps, and `latest*.yml`
metadata together in the release. macOS needs both DMG and ZIP. Architecture
channels (`latest-arm64` / `latest-x64`) avoid manifest collisions between the
two Mac builds. Never overwrite an existing version to fix a bad release;
publish a higher version. Keep signing identities consistent across releases.
Linux auto-update applies to the provided AppImage; OS-store packages need
their store's update mechanism. A writable installation location is required.

Before the first public release, exercise a real signed `0.1.0 → 0.1.1` update
on each target OS. That final distribution test requires the repository and
signing credentials; local tests cannot substitute for it.

## Checks

`pnpm test` runs backend, frontend, and desktop tests. `pnpm desktop:smoke`
opens the packaged app twice with temporary data and checks private API access,
PDF merging, PDF.js worker rendering, bundled OCR, Node isolation, and storage
across relaunch. It needs a graphical session (on Linux, use `xvfb-run`).
Screenshots are written to `desktop/build/smoke-*.png`.

References: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security),
[electron-updater](https://www.electron.build/v26/docs/features/auto-update/),
[PyInstaller](https://pyinstaller.org/en/stable/).
