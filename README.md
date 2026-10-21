# stop dont do

a mod for the slack desktop app.

- **sidebar sections:** a panel that lists every sidebar section with its channels under it. untick a section or a channel and it's gone from your sidebar. tick it to bring it back.
- **groups:** sections whose names start with dashes (like `── .✦ events`) become groups, holding every section below them until the next one. tick or untick a whole group at once, or click the divider in your sidebar to fold the group away.
- **mentions you'd miss:** slack still counts mentions in channels you've hidden (that's the taskbar badge), so activity gets a "hidden" tab next to dms that lists them, with the total count. click one to open it.
- **silent mode:** a switch at the top of the panel that pauses notifications (slack's own "pause notifications") in every workspace you're signed in to, renewed while it's on, and hides the unread counts on the dash bar. a pause you set yourself is left alone, and turning silent mode off only ends the pauses it started.
- **no fake bold:** if the only unread channels in a section are ones you hid, the section name isn't bold anymore.
- **slack buttons:** untick any of slack's own buttons to hide them: the menu, workspace switcher, history, agents and help in the top bar; the workspace icon, home, dms, activity, files, to-dos, more, create new and focus mode in the left rail; and find a conversation, threads, huddles, drafts & sent, saved and directories in the sidebar.
- **themes:** slack, google docs, valorant, paper, midnight and terminal. every theme's colours can be changed (background, sidebar, text, accent). valorant has agent presets.
  - google docs: white everywhere, arial, google blue for links and the selected channel.
  - valorant: dark navy and red, bahnschrift, uppercase labels, sharp corners and clipped edges. adds a "dash" button to the left rail. it opens a valorant-style home page over the left rail, channel sidebar and messages, playing the hush agent trailer ("rise and fall", muted, through youtube's embed player, with a sound toggle). tick "run slack from dash" to go all in: the left rail and channel list disappear, the dash top bar becomes how you get around (its channels tab slides your channel list back in until you pick one), and every page (dms, activity, a channel) sits on frosted glass over the video. tick "hide the video" for a plain backdrop while its sound keeps playing. tick "match accent to the dash video" to take the accent from the video's most vivid colour (read from its youtube thumbnail). the top bar has play/pause, back/forward 5 seconds, a seek bar and volume for the video, and the cards show what's playing and today's date. paste a spotify playlist, album or song link under "spotify instead of the video's sound" and the controls drive spotify instead (back/forward skip songs; spotify's embed has no volume, and it plays 30-second previews unless you're signed in to spotify inside it, which slack's app doesn't allow). for full songs tick "follow the music playing on this computer": on windows the dash bar then shows and drives whatever is playing (the spotify app, a browser tab, any media app) through windows' media controls (`media.ps1`), and a spotify link opens in the spotify app. "hide the music bar" takes the play/seek/volume controls out of the top bar. paste a different youtube link (or a direct video file link) into "dash video" in the panel to loop that instead; leave it blank for the hush trailer. spaces shows how many pings are waiting in your other workspaces (and the menu shows each one's). its top bar has dash, home, dms, activity, to-dos and sidebar, a spaces menu to switch workspaces, and profile (opens your profile in the right panel), and today's weather in burlington, vt (from open-meteo, no key needed). the launcher also reaches into the player to hide youtube's buttons and captions and pick the best quality. play, esc, dash again or any other rail tab takes you back. untick it in the panel to turn it off.

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
