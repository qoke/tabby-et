# tabby-et

tabby-et adds [Eternal Terminal](https://eternalterminal.dev/)
as a first-class connection type in [Tabby](https://tabby.sh/).

Why ? We all use mobile devices. Mobile devices move around. Moving
around causes terminal reconnections. Terminal reconnections are a
pain. ET was created to solve this pain. Tabby was created to make
terminals good. Combine for more good, less pain.

Initial support for:

- Eternal Terminal connection profile (host, user, ports, auth via an SSH profile)
- Quick-connect with user@host from the profile selector or the CLI
- Forward the local SSH agent to the remote session
- Connect via an ET jump host

Key design decisions:

- Native terminal scroll-back
- Use local and remote port forwarding (configured per-profile or add live)
- ET client protocol natively in TypeScript (don't exec/shell out to et)
- Use Tabby's existing SSHSession from tabby-ssh (better for security, less maintenance and more inherited features over time)
- Use tweetnacl (nacl.secretbox / nacl.secretbox.open) for crypto. Pure JS, no native build step reqd and web safe
- TERM is always xterm-256color (can iterate on this if needed)
- Hand write the protobuf codec, no protobufjs. Less deps, its only 200 lines and the et protocol isn't a moving target
- Not resuming an ET session across a Tabby restart (requires persisting the passkey and both nonce counters and a replay buffer. This is asking for security problems, I'm not implementing this)
- Not using et client configuration file - all config sits inside Tabby

## Compatibility

This plugin requires Tabby with the small SSH API changes in PR#11649.
That PR/branch exports `SSHSession` and its keyboard interactive
prompt, makes the prompt component available to plugins, and adds
`SSHSession.openExecChannel()`. A stock Tabby release will not load
the plugin correctly until those changes are accepted and released
upstream.      

The ET server host must have `etserver` and `etterminal` installed. The plugin uses Tabby's SSH connection to start `etterminal`; it does not invoke a local ET binary.

## Install

tabby-et is on npm as
[`tabby-eternal-terminal`](https://www.npmjs.com/package/tabby-eternal-terminal).
The earlier `tabby-et` package is deprecated in its favour. Uninstall
`tabby-et` before installing this one, because both provide the same
connection type.

You need a Tabby build with the SSH API changes described under
[Compatibility](#compatibility), for example one built from the
[`tabby-et-ssh-support`](https://github.com/qoke/tabby/tree/tabby-et-ssh-support)
branch of `qoke/tabby`. A stock Tabby release will install the plugin
but will not load it correctly. This requirement goes away once those
changes are released in mainstream Tabby.

### From inside Tabby

1. Open **Settings → Plugins → Available**.
2. Find **eternal-terminal**. npm ranks new plugins low, so it may be
   near the end of the list.
3. Click **Get**.
4. Restart Tabby.

Eternal Terminal is then offered as a connection type under
**Settings → Profiles & connections → New profile**.

### With npm

Install the package into Tabby's plugin directory, then restart Tabby:

```sh
npm install --prefix ~/.config/tabby/plugins tabby-eternal-terminal
```

The plugin directory is `~/.config/tabby/plugins` on Linux,
`~/Library/Application Support/tabby/plugins` on macOS and
`%APPDATA%\tabby\plugins` on Windows.

The package has no dependencies of its own to install: what it needs
is either inside its bundle or provided by Tabby.

## Build and try it locally

Use a Tabby checkout built from the support branch/PR above, then:

```sh
git clone https://github.com/qoke/tabby-et.git
cd tabby-et
npm ci
npm run build
TABBY_PLUGINS="$PWD" /path/to/patched/tabby --debug
```

This repository is licensed under MIT; see [LICENSE](LICENSE). Please report ET plugin issues here rather than in Tabby core.
