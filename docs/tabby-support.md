# Getting a Tabby that can run Eternal Terminal

The Eternal Terminal plugin installs on any Tabby, but it can only open connections on a Tabby that has four small additions to Tabby's SSH plugin. Those additions are in [Tabby pull request #11649](https://github.com/Eugeny/tabby/pull/11649), which has not been merged or released yet. Tabby from [tabby.sh](https://tabby.sh/), GitHub releases, Homebrew, winget or a Linux package does not have them.

You are on a Tabby without them if you see any of these:

- a yellow box at the top of **Settings → Eternal Terminal** that says "This Tabby cannot open Eternal Terminal connections yet"
- the same warning in a pop-up when Tabby starts
- an Eternal Terminal tab that prints that message instead of connecting

Until Tabby releases the change, the fix is to run a Tabby built from source with it. This guide takes you through that one step at a time, and shows you every line of the change so you can check it before you build anything. Plan on 30 minutes to an hour, most of it waiting for downloads and the build.

When a Tabby release includes the change, you won't need any of this. Update Tabby the normal way and the warning goes away by itself, because the plugin checks what Tabby has every time it starts.

## Contents

1. [What the change is, and why the plugin needs it](#what-the-change-is-and-why-the-plugin-needs-it)
2. [Before you start](#before-you-start)
3. [Step 1: get the source](#step-1-get-the-source)
4. [Step 2: check the change yourself](#step-2-check-the-change-yourself)
5. [Step 3: install Tabby's dependencies](#step-3-install-tabbys-dependencies)
6. [Step 4: build Tabby](#step-4-build-tabby)
7. [Step 5: start the Tabby you built](#step-5-start-the-tabby-you-built)
8. [Step 6: install the plugin and check it works](#step-6-install-the-plugin-and-check-it-works)
9. [Updating, and going back to a released Tabby](#updating-and-going-back-to-a-released-tabby)
10. [If you would rather not use the qoke/tabby fork](#if-you-would-rather-not-use-the-qoketabby-fork)
11. [Troubleshooting](#troubleshooting)

## What the change is, and why the plugin needs it

An Eternal Terminal connection starts over SSH. The plugin logs in to the server with Tabby's own SSH code, runs `etterminal` once to get a session key, closes that command, and then talks to `etserver` (port 2022 by default) with the key. That way it uses the same SSH logins, keys, agent, known hosts and jump hosts as your Tabby SSH profiles, instead of shipping a second SSH client.

Released Tabby keeps the pieces needed for this inside its SSH plugin, where other plugins can't reach them. The change makes four of them reachable:

| Addition | What the plugin uses it for |
| --- | --- |
| Export `SSHSession` | To open an SSH connection the same way Tabby's SSH tabs do. |
| Export `KeyboardInteractivePrompt` | To show password and one-time-code prompts during that login. |
| Export the `<keyboard-interactive-auth-panel>` component | To show those prompts in the same panel Tabby's SSH tabs use. |
| Add `SSHSession.openExecChannel(command)` | To run `etterminal` as one command with no shell and no terminal attached. |

Here is the whole change, as it is on the [`tabby-et-ssh-support`](https://github.com/qoke/tabby/tree/tabby-et-ssh-support) branch of [qoke/tabby](https://github.com/qoke/tabby). It is one commit on top of a Tabby release: two files, 17 added lines and nothing removed.

```diff
--- a/tabby-ssh/src/index.ts
+++ b/tabby-ssh/src/index.ts
@@ -60,6 +60,9 @@ import { SFTPCreateDirectoryModalComponent } from './components/sftpCreateDirect
         KeyboardInteractiveAuthComponent,
         HostKeyPromptModalComponent,
     ],
+    exports: [
+        KeyboardInteractiveAuthComponent,
+    ],
 })
 // eslint-disable-next-line @typescript-eslint/no-extraneous-class
 export default class SSHModule { }
@@ -68,3 +71,4 @@ export * from './api'
 export { SFTPFile, SFTPSession } from './session/sftp'
 export { SFTPPanelComponent, SSHTabComponent }
 export { PasswordStorageService } from './services/passwordStorage.service'
+export { SSHSession, KeyboardInteractivePrompt } from './session/ssh'
--- a/tabby-ssh/src/session/ssh.ts
+++ b/tabby-ssh/src/session/ssh.ts
@@ -900,6 +900,19 @@ export class SSHSession {
         return ch
     }
 
+    /**
+     * Open a session channel and run a single command, without a PTY.
+     * Useful for clients that need to run a command without starting a shell.
+     */
+    async openExecChannel (command: string): Promise<russh.Channel> {
+        if (!(this.ssh instanceof russh.AuthenticatedSSHClient)) {
+            throw new Error('Cannot open an exec channel before auth')
+        }
+        const ch = await this.ssh.activateChannel(await this.ssh.openSessionChannel())
+        await ch.requestExec(command)
+        return ch
+    }
+
     private setupSocketChannelEvents (channel: russh.Channel, socket: Socket, logPrefix: string): void {
         // Channel → Socket data flow with error handling
         channel.data$.subscribe({
```

If you review code for a living, these are the points to check:

- Three of the four additions are exports of code that already exists and already runs in every Tabby. They change what other plugins can import, not what Tabby does.
- `openExecChannel()` uses the same calls (`openSessionChannel()` and `activateChannel()`) that Tabby already uses to open the channel for its own SSH shells. The only difference is that it asks the server to run one command (`requestExec`) instead of starting a shell, which is what `ssh user@host some-command` does. It refuses to run before the user has logged in.
- Nothing changes for Tabby's own SSH tabs. No dependency is added or updated, and Tabby makes no new connections because of it. The only command it runs is the one a plugin passes to `openExecChannel()`, on a server the user has already logged in to. There is no telemetry.
- Everything else in the branch is Tabby exactly as its authors released it. The next step shows how to prove that with Git instead of taking this page's word for it.
- Any plugin you install already runs with the same access to your computer as Tabby itself. The change does not give plugins any access they did not have: a plugin could always load its own SSH library. It lets the Eternal Terminal plugin use Tabby's instead.

The plugin itself is open source under the MIT licence at [qoke/tabby-et](https://github.com/qoke/tabby-et). Its npm releases are published from GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so npmjs.com shows the exact commit and workflow each release was built from.

## Before you start

You need a computer running Linux, macOS or Windows, about 5 GB of free disk space, and an internet connection. You will type commands into a terminal: Terminal on macOS, PowerShell on Windows, or any terminal on Linux. Type or paste each command on its own and wait for it to finish before you run the next one.

Install these first. Each has a command after it that checks it worked.

1. **Git**, from [git-scm.com](https://git-scm.com/downloads). Check: `git --version` prints a version number.
2. **Node.js 22**, the LTS version, from [nodejs.org](https://nodejs.org/en/download). Tabby's own builds use version 22, and other versions can fail in confusing ways. Check: `node --version` prints `v22.` and then more numbers.
3. **Yarn 1**, which Tabby uses instead of npm. Install it with `npm install --global yarn`. Check: `yarn --version` prints a number that starts with `1.`. On Linux and macOS, if npm says it has no permission, run `sudo npm install --global yarn` instead.
4. **The tools to compile native code.** Some of Tabby's parts are written in C++, and are compiled for your computer while its dependencies install.
   - **Linux (Debian or Ubuntu):** run
     ```sh
     sudo apt install build-essential python3 libfontconfig-dev libsecret-1-dev libarchive-tools libnss3 libatk1.0-0 libatk-bridge2.0-0 libgdk-pixbuf2.0-0 libgtk-3-0 libgbm1 cmake
     ```
     These are the packages Tabby's own [build instructions](https://github.com/Eugeny/tabby/blob/master/HACKING.md) list, plus a C++ compiler and Python. Other distributions have packages with similar names.
   - **macOS:** run `xcode-select --install` and follow the dialog. If it says the tools are already installed, you're done.
   - **Windows:** install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/). In the installer, tick **Desktop development with C++**, then install. Also install Python 3 from [python.org](https://www.python.org/downloads/) and tick **Add python.exe to PATH** on its first screen. Close and reopen PowerShell afterwards, so it finds the new tools.

## Step 1: get the source

Pick a folder to keep the source in, such as your home folder, and run:

```sh
git clone https://github.com/qoke/tabby.git
cd tabby
git checkout tabby-et-ssh-support
git remote add upstream https://github.com/Eugeny/tabby.git
git fetch --tags upstream
```

What each line does:

- `git clone` downloads the fork into a new folder called `tabby`.
- `cd tabby` moves into it. Every command after this one runs from inside this folder.
- `git checkout tabby-et-ssh-support` switches to the branch with the change.
- `git remote add upstream` and `git fetch --tags upstream` download Tabby's official repository alongside it. You need that for the check in step 2, and Tabby's build also needs the official release tags, because it names its version after the last one.

## Step 2: check the change yourself

This step shows that the branch is official Tabby plus the change shown above, and nothing else. Run:

```sh
git log --oneline upstream/master..tabby-et-ssh-support
git diff --stat upstream/master...tabby-et-ssh-support
```

The first command lists the commits that are on the branch and not in official Tabby. Expect one line, whose message is "Expose SSH session bootstrap APIs for external plugins".

The second command lists the files those commits change. Note the three dots in this one. Expect:

```text
 tabby-ssh/src/index.ts       |  4 ++++
 tabby-ssh/src/session/ssh.ts | 13 +++++++++++++
 2 files changed, 17 insertions(+)
```

To read the change in full, run `git diff upstream/master...tabby-et-ssh-support` (press `q` to leave it). It should match the change shown earlier on this page. You can also see it on GitHub, in the [Files changed tab of pull request #11649](https://github.com/Eugeny/tabby/pull/11649/files).

If you see more commits or more files than this, stop, and [open an issue](https://github.com/qoke/tabby-et/issues) with what the commands printed.

## Step 3: install Tabby's dependencies

```sh
yarn
```

This downloads the libraries Tabby is built from and compiles its native parts. It can take 10 minutes or more, and prints a lot of text, including warnings. Warnings are fine. It has worked if the last lines say `Done` and nothing after them says `error`.

If it stops with an error, see [Troubleshooting](#troubleshooting).

## Step 4: build Tabby

```sh
yarn run build
```

This compiles Tabby itself, and takes a few minutes. Again, warnings are fine and errors are not.

## Step 5: start the Tabby you built

First, quit any Tabby that is already running, including one in the system tray or menu bar. The Tabby you built uses the same settings folder as an installed one, so it sees your existing profiles and settings, but only one Tabby can run at a time. If an installed Tabby is still open, the command below brings that one to the front instead of starting yours.

Then run:

```sh
yarn start
```

Tabby opens, with a developer tools window beside it. That window is part of running Tabby from source. You can close it, or leave it open, because it shows useful messages if something goes wrong.

Keep the terminal you ran `yarn start` from open while you use Tabby. Closing it closes Tabby. Each time you want this Tabby later, open a terminal, `cd` into the `tabby` folder, and run `yarn start` again.

Running Tabby this way also turns off its automatic updates, so it won't replace itself with a release that lacks the change.

Tabby can also be packaged into an installer, which is described in [Tabby's build instructions](https://github.com/Eugeny/tabby/blob/master/HACKING.md#building-an-installer). That needs more setup, such as code-signing settings on macOS and Windows, and you don't need it to use the plugin.

## Step 6: install the plugin and check it works

If the plugin is already installed, skip to the checks below. Otherwise, in the Tabby you built:

1. Open **Settings → Plugins → Available**.
2. Search for **eternal-terminal**. npm ranks new plugins low, so it may be near the end of the list.
3. Click **Get**.
4. Quit Tabby, and start it again with `yarn start`.

Then check that it works:

- No Eternal Terminal warning appears when Tabby starts.
- **Settings → Eternal Terminal** has no yellow box at the top.
- An Eternal Terminal profile connects. The server needs `etserver` and `etterminal` installed; see the [Eternal Terminal install guide](https://eternalterminal.dev/download/).

If you still see the warning, the Tabby running is not the one you built. Quit every Tabby window, including the tray or menu bar icon, and start again with `yarn start` from the `tabby` folder.

## Updating, and going back to a released Tabby

To pick up changes to the branch, from the `tabby` folder run:

```sh
git fetch origin
git fetch --tags upstream
git reset --hard origin/tabby-et-ssh-support
```

`git reset --hard` makes your copy match the branch exactly. It is used instead of `git pull` because the branch is moved onto each new Tabby release, which `git pull` can't follow. It also throws away any edits you made inside the `tabby` folder, which you won't have if you only followed this guide.

Then repeat [step 2](#step-2-check-the-change-yourself) to check what changed, run `yarn` and `yarn run build` again, and start Tabby with `yarn start`.

To go back to a released Tabby, quit the one you built and start your installed Tabby as usual. Your profiles and settings stay where they were, because both use the same settings folder. The plugin stays installed and shows its warning again, which is expected. To remove it, uninstall it in **Settings → Plugins**. To remove the Tabby you built, delete the `tabby` folder.

## If you would rather not use the qoke/tabby fork

You don't have to trust the fork. You can start from Tabby's official repository and add the one commit yourself:

```sh
git clone https://github.com/Eugeny/tabby.git
cd tabby
git fetch https://github.com/qoke/tabby.git tabby-et-ssh-support
git show --stat FETCH_HEAD
git cherry-pick --no-commit FETCH_HEAD
git diff --stat HEAD
```

`git show --stat FETCH_HEAD` shows the commit before you apply it. Expect one commit, "Expose SSH session bootstrap APIs for external plugins", changing the same two files and 17 lines as in step 2. `git cherry-pick --no-commit` applies that change to the latest official Tabby without making a commit, so Git does not ask for your name and email. `git diff --stat HEAD` then confirms that only those two files changed. Continue from [step 3](#step-3-install-tabbys-dependencies), skipping the check in step 2, which you have already done.

If `git cherry-pick` reports a conflict, official Tabby has changed the same lines since the branch was made. Run `git cherry-pick --abort` to undo it, and either use the fork as described above or [open an issue](https://github.com/qoke/tabby-et/issues).

Tabby's build needs Tabby's release tags, which this clone already has, because it came from Tabby's official repository.

## Troubleshooting

**`git`, `node` or `yarn`: command not found.** The program is not installed, or the terminal was open before you installed it. Close the terminal, open a new one, and run the check command from [Before you start](#before-you-start) again.

**`yarn` fails with `gyp ERR!` or `node-gyp` in the error.** A native part failed to compile, which nearly always means the build tools from [Before you start](#before-you-start) are missing. On Windows, check that you ticked **Desktop development with C++** and that `python --version` works in a new PowerShell. Install what is missing, then run `yarn` again.

**`yarn` or `yarn run build` fails some other way.** Check that `node --version` prints `v22.`. If it doesn't, install Node.js 22 and start again from step 3. If it does, delete the `node_modules` folder inside `tabby` and run `yarn` again.

**`yarn start` does nothing, or shows your old Tabby.** Another Tabby is still running. Quit it, including its tray or menu bar icon, and run `yarn start` again.

**The warning still shows in the Tabby you built.** Open **Settings → Eternal Terminal** and expand **What this Tabby is missing**. If it lists anything, run the commands from step 2 to check you are on the `tabby-et-ssh-support` branch, then rebuild with `yarn run build`.

**Something else.** [Open an issue on the plugin](https://github.com/qoke/tabby-et/issues), not on Tabby. Include your operating system, what `node --version` prints, the list under **What this Tabby is missing** if there is one, and the last 30 or so lines of output from the command that failed.
