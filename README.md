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

Once the upstream SSH changes are released and this plugin is published on npm, it can be installed through Tabby's Plugin Manager by searching for `tabby-et`. The npm package is not published yet.

## Development

`npm run watch` rebuilds the bundle after source changes. `npm pack --dry-run` shows the package contents. The bundle leaves Tabby and Angular modules external so the running application supplies its own instances. Other libraries used by ET are bundled with the plugin.

This repository is licensed under MIT; see [LICENSE](LICENSE). Please report ET plugin issues here rather than in Tabby core.
