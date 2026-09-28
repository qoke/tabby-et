# tabby-et

Community maintained [Eternal Terminal](https://eternalterminal.dev/) connections for [Tabby](https://tabby.sh/). The plugin provides ET profiles, SSH bootstrap, reconnection, and port forwarding. Its implementation was copied from the `tabby-et/` directory of [`qoke/tabby` at `4f3981e5`](https://github.com/qoke/tabby/tree/4f3981e5/tabby-et); it was not rewritten for this repository.

## Compatibility

This plugin requires Tabby with the small SSH API changes in [`qoke/tabby` branch `tabby-et-ssh-support`](https://github.com/qoke/tabby/tree/tabby-et-ssh-support). That branch exports `SSHSession` and its keyboard interactive prompt, makes the prompt component available to plugins, and adds `SSHSession.openExecChannel()`. A stock Tabby release will not load the plugin correctly until those changes are accepted and released upstream.

The ET server host must have `etserver` and `etterminal` installed. The plugin uses Tabby's SSH connection to start `etterminal`; it does not invoke a local ET binary.

## Build and try it locally

Use a Tabby checkout built from the support branch above, then:

```sh
git clone https://github.com/qoke/tabby-et.git
cd tabby-et
npm ci
npm run build
TABBY_PLUGINS="$PWD" /path/to/patched/tabby --debug
```

`TABBY_PLUGINS` can point at this repository because it contains the plugin's `package.json` and built `dist/index.js`. Restart Tabby after installing or rebuilding the plugin.

## Download a patched macOS Tabby build

The [Patched Tabby preview workflow](https://github.com/qoke/tabby-et/actions/workflows/tabby-preview.yml) checks out `qoke/tabby` at `tabby-et-ssh-support`, runs the same typings and lint commands as Tabby's PR workflow, runs Tabby's normal macOS build and packaging commands, builds this plugin, and tests a copied app from each downloaded DMG on a Mac runner. Run it manually to select another branch or commit. Each successful run offers three downloadable artifacts for 30 days:

- `tabby-macos-arm64`: Apple Silicon DMG and ZIP.
- `tabby-macos-x86_64`: Intel DMG and ZIP.
- `tabby-et-plugin`: the locally built npm tarball.

Download the artifact for your Mac, mount the DMG, and copy `Tabby.app` to a separate location so it does not replace your normal Tabby installation. Preview builds are signed ad hoc and verified in CI. They are **not signed with an Apple Developer ID or notarized**, so Gatekeeper rejects a downloaded copy; macOS may say the app is damaged. This is expected for this local preview, even when the app's signature is intact. [Apple explains that Gatekeeper normally accepts Developer ID signed apps](https://developer.apple.com/library/archive/technotes/tn2206/).

Verify the downloaded image and copied app:

```sh
hdiutil verify /path/to/tabby-*-macos-*.dmg
codesign --verify --deep --strict --verbose=2 "/path/to/Tabby.app"
```

Stop if either verification command fails, and report its output. Once both pass and you have confirmed the DMG came from this workflow, clear quarantine for that copied preview app alone and open it:

```sh
xattr -dr com.apple.quarantine "/path/to/Tabby.app"
open "/path/to/Tabby.app"
```

This bypasses Gatekeeper for that copy only; it does not change your Mac's system-wide security settings. A Developer ID signature and notarization are required for a normal, warning-free macOS install; this preview does not have those credentials. The [Mac runner diagnosis](https://github.com/qoke/tabby-et/actions/runs/36393012555) verified that both downloaded DMGs contain intact apps and launch after this step.

For a local plugin test, extract the plugin tarball and start the preview from Terminal:

```sh
mkdir -p "$HOME/tabby-et-preview"
tar -xzf /path/to/tabby-et-0.1.0.tgz -C "$HOME/tabby-et-preview"
TABBY_PLUGINS="$HOME/tabby-et-preview/package" \
  "/path/to/Tabby.app/Contents/MacOS/Tabby"
```

This loads the copied plugin package into the preview build without publishing it to npm. The DMG and ZIP contain the same patched Tabby source; each artifact includes a `tabby-commit.txt` with the exact source commit.

Once the upstream SSH changes are released and this plugin is published on npm, it can be installed through Tabby's Plugin Manager by searching for `tabby-et`. The npm package is not published yet.

## Development

`npm run watch` rebuilds the bundle after source changes. `npm pack --dry-run` shows the package contents. The bundle leaves Tabby and Angular modules external so the running application supplies its own instances. Other libraries used by ET are bundled with the plugin.

This repository is licensed under MIT; see [LICENSE](LICENSE). Please report ET plugin issues here rather than in Tabby core.
