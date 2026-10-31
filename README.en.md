# dsh-cookie-sweep

English | [中文](./README.md)

A DSH desktop plugin that sweeps the leftover login-cookie files out of the Electron network
directory on every start, so they can never pile up past the 16KB request-header limit and lock the
Web UI on `Web authentication failed` behind an HTTP 431.

## Why it exists

The desktop app persists its cookies here:

```
%APPDATA%\@deepseek-ai\dsh-desktop\Network\
%APPDATA%\@deepseek-ai\dsh-desktop\Partitions\<partition>\Network\
```

Those files only ever grow. After enough launches, every request header crosses the common 16KB
limit, the server answers 431, and the interface can no longer authenticate. The manual remedy is
to quit DSH, delete `Cookies` and `Cookies-journal`, and reopen — this plugin automates exactly that
step. The login state itself lives in `.dsh` and is untouched.

## What it does

- **Sweep at startup**: when the plugin loads (that is, when DSH starts) it deletes `Cookies` and
  `Cookies-journal` — optionally `Trust Tokens` too. A delete that fails is retried for about six
  seconds, because a process that is still exiting has not released the handle yet.
- **Status page**: Settings → **Cookie 清理 / Cookie Sweep** lists every candidate file with
  `deleted / absent / in use / skipped / recreated`, its size and the reason, plus a **Clean now**
  button.

## Safety boundaries

Deletion is irreversible, so the plugin is deliberately conservative:

- It only acts inside `%APPDATA%\@deepseek-ai\<app>\Network` and `Partitions\<p>\Network`, with
  paths it builds itself.
- It only deletes a fixed list of file names — never a glob.
- A non-empty file is deleted only when its head carries a SQLite or LevelDB cookie-store signature.
  Anything else is skipped and explained in the status page.
- `Partitions\temp-*` (one-shot sessions) is never touched, so an in-progress sign-in is not disturbed.
- Every failure is recorded in the status page; nothing here is allowed to break app startup.

## Configuration

The `config` block in `cordis.patch.yml`:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; with it off nothing is swept at startup and manual cleaning is refused |
| `onStartup` | `true` | Sweep once at every start |
| `keepTrustTokens` | `true` | Leave `Trust Tokens` alone and sweep only the cookies |
| `extraPaths` | `[]` | Extra Electron network directories (absolute paths) |

## Install

From a local checkout:

```yaml
- insert:
    - id: cookie-sweep
      name: 'dsh-cookie-sweep'
      config:
        enabled: true
        onStartup: true
```

or point the plugin manager at the package directory:

```
plugin_manager install_bundle <absolute path to this directory>
```

The package has no runtime dependencies; `index.js` uses only Node built-ins and `client.js` is a
plain module loaded through `window.__ModuleLoader__`.

## Known limits

- A running app holds an exclusive handle on the main `Network\Cookies`, so during the *current*
  run the startup sweep will usually report “in use”. Quit DSH completely (tray included) and
  reopen: the next start sweeps before the file is taken.
- When the main store is held and the app then recreates it, the status says `recreated` rather than
  `deleted` — that is not a failure, just the file being written again.
- Deleting the cookie store can cost one re-authorization. The conversation history in `.dsh` is not
  affected.

## Layout

```
index.js          host half: the sweep, the retry, the recheck, and the /dsh-cookie-sweep routes
client.js         client half: the settings page
cordis.patch.yml  the bundle patch that inserts the plugin into the profile
locale/*.json     display title and description (zh / en)
icon.svg          the icon shown in the plugin list
```

## License

MIT
