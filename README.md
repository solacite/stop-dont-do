# stop dont do

a mod for the slack desktop app.

- **sidebar sections:** a panel that lists every sidebar section with its channels under it. untick a section or a channel and it's gone from your sidebar. tick it to bring it back.
- **groups:** sections whose names start with dashes (like `── .✦ events`) become groups, holding every section below them until the next one. tick or untick a whole group at once, or click the divider in your sidebar to fold the group away.
- **no fake bold:** if the only unread channels in a section are ones you hid, the section name isn't bold anymore.
- **slack buttons:** untick any of slack's own buttons to hide them: the menu, workspace switcher, history, agents and help in the top bar; the workspace icon, home, dms, activity, files, to-dos, more, create new and focus mode in the left rail; and find a conversation, threads, huddles, drafts & sent, saved and directories in the sidebar.
- **themes:** slack, google docs, valorant, paper, midnight and terminal. every theme's colours can be changed (background, sidebar, text, accent). valorant has agent presets.
  - google docs: white everywhere, arial, google blue for links and the selected channel.
  - valorant: dark navy and red, bahnschrift, uppercase labels, sharp corners and clipped edges, with a moving background (drifting shards, a sweeping slash, grid and scanlines) and hover animations. turns the motion off if your system asks for reduced motion.

open the panel with the **sidebar** button in the left rail (under more), or ctrl+alt+h.

## running it

needs node 22 or newer.

```
node launch.mjs
```

this restarts slack with a local debug port, injects `src/inject.js` into it, and stays running so reloads and new windows get the mod too. close slack and the launcher exits.

on windows you can get a start menu and desktop shortcut that does this without a console window:

```
powershell -ExecutionPolicy Bypass -File install-shortcut.ps1
```

then open slack from "Slack (stop dont do)" instead of the normal slack icon.

## how it works

- `launch.mjs` starts slack with `--remote-debugging-port=9333` (bound to 127.0.0.1) and uses the chrome devtools protocol to add the script to every slack page. nothing in slack's install folder is touched, so slack updates don't break it.
- `src/inject.js` runs inside slack. it reads your sections from slack's own api (`users.channelSections.list`) and hides rows in the sidebar. slack's sidebar is a virtual list with absolutely positioned rows, so the script also shifts the visible rows up to close the gaps. hiding a section collapses it in slack first so the list stays short.
- the bold fix asks slack's `client.counts` which channels are unread, at most every 15 seconds.
- settings live in slack's localStorage under `sdd:settings`, per computer.

## notes

- while the launcher is running, other programs on your computer could connect to the debug port and control slack. stop the launcher / restart slack normally to close it.
- set `SDD_PORT` to use a different port, or `SLACK_PATH` if slack isn't found.
- slack can rename its css classes at any time. if the sidebar stops hiding things, that's probably why.
