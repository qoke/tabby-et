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

The [Patched Tabby preview workflow](https://github.com/qoke/tabby-et/actions/workflows/tabby-preview.yml) checks out `qoke/tabby` at `tabby-et-ssh-support`, runs Tabby's normal macOS build and packaging commands, and builds this plugin. Run it manually to select another branch or commit. Each successful run offers three downloadable artifacts for 30 days:

- `tabby-macos-arm64`: Apple Silicon DMG and ZIP.
- `tabby-macos-x86_64`: Intel DMG and ZIP.
- `tabby-et-plugin`: the locally built npm tarball.

Download the artifact for your Mac, mount the DMG, and copy `Tabby.app` to a separate location so it does not replace your normal Tabby installation. This preview is unsigned and not notarized; macOS may require you to open it through Finder's **Open** context menu.

For a local plugin test, extract the plugin tarball and start the preview from Terminal:

```sh
mkdir -p "$HOME/tabby-et-preview"
tar -xzf /path/to/tabby-et-0.1.0.tgz -C "$HOME/tabby-et-preview"
TABBY_PLUGINS="$HOME/tabby-et-preview/package" \
  "/path/to/Tabby.app/Contents/MacOS/Tabby"
```

This loads the copied plugin package into the preview build without publishing it to npm. The DMG and ZIP contain the same patched Tabby source; each artifact includes a `tabby-commit.txt` with the exact source commit.

Once the upstream SSH changes are released and this plugin is published on npm, it can be installed through Tabby's Plugin Manager by searching for `tabby-et`. The npm package is not published yet.

## GPU memory guard

Stock Tabby keeps a full-size WebGL canvas alive for every hidden terminal tab
(a regression from upstream PR #11354, June 2026), never bounds the xterm.js
glyph atlas that every terminal's GPU context mirrors, never explicitly loses a
WebGL context when a tab closes, and lets the sixel image store grow to 128 MB
per terminal. GPU memory therefore climbs with every tab and every new
glyph/colour combination and rarely comes back down. Eternal Terminal tabs live
for days, so they show it most.

This plugin ships a guard that applies to every terminal tab:

- a tab hidden for 30 seconds releases its WebGL renderer and gets it back when
  shown again, without touching the host's context-loss recovery budget
- the shared glyph atlas is cleared once its pages exceed 48 MB
- the WebGL context is lost explicitly when a tab is closed instead of waiting
  for garbage collection
- the inline image store is capped at 32 MB per terminal

It can be switched off in Settings > Eternal Terminal. The limits live in the
config file:

```yaml
et:
  gpuMemoryGuard:
    enabled: true
    hiddenReleaseDelaySeconds: 30
    atlasBudgetMB: 48
    imageStorageLimitMB: 32
```

Two host-side issues are out of a plugin's reach: the WebGL probe that Tabby
runs for every new tab (cached and released by upstream since #11673) and the
`max-active-webgl-contexts=9000` Chromium flag that disables context eviction.

## Development

`npm run watch` rebuilds the bundle after source changes. `npm pack --dry-run` shows the package contents. The bundle leaves Tabby and Angular modules external so the running application supplies its own instances. Other libraries used by ET are bundled with the plugin.

This repository is licensed under MIT; see [LICENSE](LICENSE). Please report ET plugin issues here rather than in Tabby core.
