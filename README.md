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
- **Playlists** are ordered lists of images and videos. Advance manually, or start a player's
  timer to advance by each item's duration (a video with no duration plays once to its end).
- **Groups** cue several players in one action. Each player keeps its own playlist and position,
  so a group "Next" can advance different content on every screen at once. This is
  close-enough-by-eye sync over the network, not frame lock.

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

1. In the control UI open **Players → Add a player**, check the server address (it must be an
   address the player can reach, not `localhost`) and download the SD card files.
2. Unzip them onto the root of a blank SD card: `autorun.brs`, `index.html`, `player.js`,
   `config.json`.
3. Insert the card and power on. The player appears in the UI under its serial number; give it a
   name and a playlist.

`config.json` holds `"server"` and optionally `"name"` (used the first time the player registers).
Give the server a fixed IP address or DHCP reservation, since players find it by this address.

To try things without hardware, open `http://<server>:8080/player/` in a browser tab. It behaves
like a player but streams media instead of caching it. Add `?id=lobby` to pick its id.

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
| `POST /api/media?name=` (raw body), `PUT`/`DELETE /api/media/{id}` | library |
| `POST /api/playlists`, `PUT`/`DELETE /api/playlists/{id}` | playlists |
| `PUT`/`DELETE /api/players/{id}`, `POST /api/players/{id}/cue` | players |
| `POST /api/groups`, `PUT`/`DELETE /api/groups/{id}`, `POST /api/groups/{id}/cue` | groups |

Cue body: `{"action": "next" | "prev" | "first" | "goto" | "play" | "pause" | "blackout", "index"?, "on"?}`.

There is no authentication: anyone on the network can control the show. Run it on a trusted
show network.
