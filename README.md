# CueSign

Show control for BrightSign players. A server on the local network holds a media library and
playlists; each player shows whatever the server cues it to, playing from its own SD card cache.

```
player/   HTML/JS page + autorun.brs that go on the BrightSign's SD card
server/   ASP.NET Core (.NET 10) server: API, WebSockets, timers, media storage
web/      React + TypeScript control UI, built into server/wwwroot
```

## How it works

- **Players** open a WebSocket to the server and are pushed a new state whenever a cue changes
  (with HTTP polling every 2 s as a fallback). The state names the current item and lists the rest
  of the playlist, so upcoming items are downloaded ahead of time.
- **Media** is addressed by its SHA-256. A player downloads each file once to
  `SD:/cuesign-cache`, verifies the hash, and plays it from the card. The item on screen only
  changes once the new one is fully downloaded. Files deleted from the library are deleted from
  every player's cache.
- **If the server goes away**, players keep showing their current item, and after a power cycle
  they come back up on the last item they were told to show.
- **Playlists** are grids: each row is a cue and each column is a screen, so a multi-screen show
  is built side by side and every screen changes on the same cue. A single-screen playlist is
  just a grid with one column. Advance manually, or start the timer to advance by each cue's
  duration (a cue with no duration waits for a video to play to its end).
- **Screens are named columns, not players.** An empty cell either keeps that screen's previous
  item playing or goes to black, as the playlist chooses.
- **The library** is organised in folders. Dropping a folder onto the Media tab uploads everything
  in it and recreates its subfolders. Removing a folder moves its contents up; it never deletes media.
- **Edits to playlists, players and groups are drafts** until you press Save, so a batch of changes
  reaches the players in one go. Loading a playlist and cueing, on the Live tab, act immediately.
- **Groups** are ordered lists of players. Loading a playlist on a group gives its first player
  the first screen, its second the second, and so on (extra players start again from the first
  screen), and from then on the group cues and its timer move them together. A single player can
  also load any one screen of a playlist on its own. This is close-enough-by-eye sync over the
  network, not frame lock.

## Running the server

Requires the [.NET 10 SDK](https://dotnet.microsoft.com/download) and Node.js 20+.

```bash
cd web && npm install && npm run build
```

```bash
dotnet run --project server
```

Open http://localhost:8080. Options: `--port 8080`, `--data <folder>` (default `./data`; holds
`cuesign.json` and the `media/` folder — back this folder up to back up a show).

For UI work, run the server as above and `npm run dev` in `web/` for hot reload.

### Building a standalone copy

Produces a folder with a single executable plus `wwwroot/` and `player/`; no .NET install needed
on the target. Replace the runtime id with `win-x64`, `osx-arm64`, `linux-x64` or `linux-arm64`
(Raspberry Pi 4/5, 64-bit OS).

```bash
dotnet publish server -c Release -r linux-arm64 --self-contained -p:PublishSingleFile=true -o dist/linux-arm64
```

Build the web UI first, since it is copied from `server/wwwroot`.

## Setting up a BrightSign

Every player uses the same SD card contents; there is nothing to configure per player.

1. In the control UI open **Players → Add a player** and download the SD card files.
2. Unzip them onto the root of a blank SD card: `autorun.brs`, `index.html`, `player.js`.
3. Insert the card and power on. The screen shows "Waiting to be paired" and the player appears
   at the top of the Players tab under its serial number.
4. Choose **Pair**, then give the player a name and a playlist.

### Pairing

- An unpaired player broadcasts a small UDP announcement (port 48550) every two seconds. The
  server lists what it hears; **Pair** answers the player with the server's address and id,
  which the player saves to `cuesign-pairing.json` on the card.
- A paired player ignores every other CueSign server. **Unpair** on the Players tab sends it
  back to waiting; deleting `cuesign-pairing.json` from the card does the same.
- If a paired player cannot reach its server for a few seconds it announces again, naming the
  server it belongs to. That server answers with its current address, so the server does not
  need a fixed IP.
- Broadcasts only reach the server's own network segment, and the server's firewall must allow
  inbound UDP 48550. Where that is not possible, put a `config.json` on the card to skip
  pairing: `{ "server": "http://192.168.1.10:8080", "name": "Lobby" }` (`name` is optional). The
  download dialog can add this file for you.

To try things without hardware, open `http://<server>:8080/player/` in a browser tab. It behaves
like a player but streams media instead of caching it. Add `?id=lobby` to pick its id.

### Player updates

A connected player keeps its own code up to date. The server sends the hashes of the player
files it ships (`autorun.brs`, `index.html`, `player.js`); a player whose copies differ downloads
the new ones to its card, verifies them and restarts on them (a reboot if `autorun.brs` changed,
otherwise a page reload). So upgrading the server upgrades every player, with no cards to pull.
Start the server with `--player-updates false` to turn this off.

### Player notes

- Video is played on the hardware video plane behind the page (`hwz`). That plane cannot
  crossfade with itself, so video-to-video transitions dip through black; transitions involving
  an image are true fades.
- `autorun.brs` enables the Chromium inspector on port 2999 for debugging
  (`http://<player-ip>:2999`). Remove those lines for a locked-down install.
- The player page avoids newer JavaScript syntax so it runs on older BrightSign OS versions.

## API sketch

| | |
|---|---|
| `WS /ws/player?id=` | server → `state`; player → `status`, `ended` |
| `GET /api/player/{id}/state`, `POST /api/player/{id}/message` | polling fallback for the same messages |
| `WS /ws/control`, `GET /api/state` | full snapshot for control UIs |
| `POST /api/media?name=&folder=` (raw body), `PUT`/`DELETE /api/media/{id}` | library (`PUT` renames and/or moves) |
| `POST`/`PUT /api/folders`, `DELETE /api/folders?path=` | library folders |
| `POST /api/playlists`, `PUT`/`DELETE /api/playlists/{id}` | playlists |
| `PUT`/`DELETE /api/players/{id}`, `POST /api/players/{id}/cue` | players (`DELETE` unpairs) |
| `POST /api/players/{id}/load`, `POST /api/groups/{id}/load` | load a playlist from its first item |
| `POST /api/discovered/{id}/pair` | pair a player that is announcing itself |
| UDP 48550 | player → `announce` (broadcast); server → `pair` (reply) |
| `POST /api/groups`, `PUT`/`DELETE /api/groups/{id}`, `POST /api/groups/{id}/cue` | groups |

Cue body: `{"action": "next" | "prev" | "first" | "goto" | "play" | "pause" | "blackout", "index"?, "on"?}`.

## Before a production release

- **Reconsider player self-update.** It is there to make development and early deployment
  painless, but it means whichever server a player is paired with can replace the code that
  player runs, and a bad update can leave a player needing its card reflashed. For a final
  release decide whether to remove it, leave it off by default (`--player-updates false`), or
  gate it behind an explicit "update players" action in the UI.
- **Remove the debugging inspector.** `autorun.brs` opens the Chromium inspector on port 2999.

There is no authentication: anyone on the network can control the show, and any CueSign server
can pair with an unpaired player. Run it on a trusted show network.
