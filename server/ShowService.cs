using System.Text.Json;

namespace CueSign.Server;

/// <summary>
/// Owns all show state: the media library, playlists, players and groups, plus the live
/// position of every player. Everything is guarded by one lock and persisted to a JSON file.
/// </summary>
public sealed class ShowService
{
    private static readonly TimeSpan OnlineTimeout = TimeSpan.FromSeconds(6);

    private sealed class Runtime
    {
        public DateTime LastSeen = DateTime.MinValue;
        public DateTime? Deadline;
        public JsonElement? Status;
        public bool Online;
    }

    private readonly object _gate = new();
    private readonly string _file;
    private readonly Db _db;
    private readonly Dictionary<string, Runtime> _runtime = [];
    private readonly Dictionary<string, DiscoveredPlayer> _discovered = [];

    public string DataDir { get; }
    public string MediaDir { get; }
    public string ServerId { get; }

    /// <summary>
    /// The player files this server ships ({ version, files: [{ name, sha256, size }] }), sent to
    /// players so they can update themselves. Null turns self-update off.
    /// </summary>
    public object? PlayerSoftware { get; set; }

    /// <summary>Raised (outside the lock) after any change that players or control UIs should see.</summary>
    public event Action? Changed;

    public ShowService(string dataDir)
    {
        DataDir = dataDir;
        MediaDir = Path.Combine(dataDir, "media");
        Directory.CreateDirectory(MediaDir);
        _file = Path.Combine(dataDir, "cuesign.json");
        _db = File.Exists(_file)
            ? JsonSerializer.Deserialize<Db>(File.ReadAllText(_file), Json.Options) ?? new Db()
            : new Db();

        if (string.IsNullOrEmpty(_db.ServerId))
        {
            _db.ServerId = Guid.NewGuid().ToString("N");
            Save();
        }
        ServerId = _db.ServerId;

        if (ConvertOldPlaylists()) Save();

        foreach (var player in _db.Players)
            ArmTimer(player);
    }

    /// <summary>Turns pre-grid playlists (a flat list of items) into one-screen grids.</summary>
    private bool ConvertOldPlaylists()
    {
        var converted = false;
        foreach (var playlist in _db.Playlists)
        {
            if (playlist.Screens.Count == 0)
            {
                playlist.Screens.Add(new PlaylistScreen { Id = NewId(), Name = "Screen 1" });
                converted = true;
            }
            if (playlist.Items is not { } items) continue;
            if (playlist.Cues.Count == 0)
            {
                // Cues keep the old item ids, so players stay on the item they were showing.
                playlist.Cues = [.. items.Select(i => new PlaylistCue
                {
                    Id = i.Id,
                    Duration = i.Duration,
                    Cells = new() { [playlist.Screens[0].Id] = i.MediaId },
                })];
            }
            playlist.Items = null;
            converted = true;
        }
        return converted;
    }

    // ---- Views ----------------------------------------------------------------------------

    /// <summary>Everything the control UI needs.</summary>
    public string SnapshotJson()
    {
        // Serialized inside the lock: the lists are live and the projections are lazy.
        lock (_gate)
        {
            return JsonSerializer.Serialize(new
            {
                type = "snapshot",
                serverTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                media = _db.Media.Select(m => new { m.Id, m.Name, m.Kind, folder = m.Folder ?? "", m.Size, m.Added, url = "/media/" + m.File }),
                folders = _db.Folders.Order(StringComparer.OrdinalIgnoreCase),
                playlists = _db.Playlists,
                groups = _db.Groups,
                discovered = _discovered.Values.OrderBy(d => d.Id).Select(d => new { d.Id, d.Model, d.Os, d.Address }),
                players = _db.Players.Select(p =>
                {
                    var rt = Rt(p.Id);
                    return new
                    {
                        p.Id,
                        p.Name,
                        p.PlaylistId,
                        p.Screen,
                        p.LinkId,
                        // What the player should have on screen now, after "hold" is applied.
                        mediaId = PlaylistOf(p) is { Cues.Count: > 0 } pl ? MediaAt(pl, p, Math.Clamp(p.Index, 0, pl.Cues.Count - 1))?.Id : null,
                        p.Index,
                        p.Cue,
                        p.Auto,
                        p.Blackout,
                        online = rt.Online,
                        deadline = rt.Deadline is { } d ? new DateTimeOffset(d).ToUnixTimeMilliseconds() : (long?)null,
                        status = rt.Status,
                    };
                }),
            }, Json.Options);
        }
    }

    /// <summary>What one player should be showing and caching. Contains nothing volatile, so unchanged state serializes identically.</summary>
    public string PlayerStateJson(string playerId)
    {
        lock (_gate)
        {
            var player = _db.Players.FirstOrDefault(p => p.Id == playerId);
            var playlist = PlaylistOf(player);
            var cues = playlist?.Cues ?? [];
            var index = cues.Count == 0 ? 0 : Math.Clamp(player!.Index, 0, cues.Count - 1);

            object? current = null;
            if (player is { Blackout: false } && cues.Count > 0 && MediaAt(playlist!, player, index) is { } media)
            {
                // With the timer running and no fixed duration, a video plays once and reports back.
                var playOnce = player.Auto && media.Kind == "video" && cues[index].Duration is not > 0;
                // The key changes only when the item should (re)start, so a held item plays on undisturbed.
                current = new { media.Id, media.File, url = "/media/" + media.File, media.Kind, media.Size, loop = !playOnce, key = player.ContentCue };
            }

            // Cache order: the current item first, then the rest of this screen's column in play order.
            var assets = Enumerable.Range(0, cues.Count)
                .Select(i => MediaAt(playlist!, player!, (index + i) % cues.Count))
                .Where(m => m is not null)
                .DistinctBy(m => m!.Id)
                .Select(m => new { m!.Id, m.File, url = "/media/" + m.File, m.Kind, m.Size });

            return JsonSerializer.Serialize(new
            {
                type = "state",
                id = playerId,
                name = player?.Name ?? playerId,
                cue = player?.Cue ?? 0,
                fadeMs = playlist?.FadeMs ?? 0,
                current,
                assets,
                library = _db.Media.Select(m => m.Id),
                software = PlayerSoftware,
            }, Json.Options);
        }
    }

    // ---- Players --------------------------------------------------------------------------

    /// <summary>Called whenever a player connects or polls. Unknown players are registered automatically.</summary>
    public void PlayerSeen(string playerId, string? suggestedName = null)
    {
        var changed = false;
        lock (_gate)
        {
            if (_db.Players.All(p => p.Id != playerId))
            {
                var name = string.IsNullOrWhiteSpace(suggestedName) ? playerId : suggestedName.Trim();
                _db.Players.Add(new Player { Id = playerId, Name = name });
                Save();
                changed = true;
            }

            // A player that has connected is no longer waiting to be paired.
            changed |= _discovered.Remove(playerId);

            var rt = Rt(playerId);
            rt.LastSeen = DateTime.UtcNow;
            if (!rt.Online)
            {
                rt.Online = true;
                changed = true;
            }
        }
        if (changed) Changed?.Invoke();
    }

    /// <summary>Handles a message sent by a player: a status report or an "ended" notice for a play-once video.</summary>
    public void PlayerMessage(string playerId, JsonElement message)
    {
        PlayerSeen(playerId);
        if (message.ValueKind != JsonValueKind.Object || !message.TryGetProperty("type", out var type)) return;

        lock (_gate)
        {
            var player = _db.Players.FirstOrDefault(p => p.Id == playerId);
            if (player is null) return;

            switch (type.GetString())
            {
                case "status":
                    Rt(playerId).Status = message.Clone();
                    break;
                case "ended":
                    var cue = message.TryGetProperty("cue", out var c) && c.TryGetInt64(out var n) ? n : -1;
                    if (!player.Auto || cue != player.Cue) return;
                    StepLinked(player, []);
                    Save();
                    break;
                default:
                    return;
            }
        }
        Changed?.Invoke();
    }

    /// <summary>Records an unpaired player that is announcing itself, so the UI can offer to pair it.</summary>
    public void PlayerAnnounced(DiscoveredPlayer announced)
    {
        bool changed;
        lock (_gate)
        {
            changed = !_discovered.TryGetValue(announced.Id, out var known) || known.Address != announced.Address;
            announced.LastSeen = DateTime.UtcNow;
            _discovered[announced.Id] = announced;
        }
        if (changed) Changed?.Invoke();
    }

    public System.Net.IPEndPoint? DiscoveredEndPoint(string playerId)
    {
        lock (_gate)
        {
            return _discovered.TryGetValue(playerId, out var found) ? found.EndPoint : null;
        }
    }

    public bool UpdatePlayer(string playerId, PlayerRequest request)
    {
        lock (_gate)
        {
            var player = _db.Players.FirstOrDefault(p => p.Id == playerId);
            if (player is null || string.IsNullOrWhiteSpace(request.Name)) return false;
            player.Name = request.Name.Trim();
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    public bool DeletePlayer(string playerId)
    {
        lock (_gate)
        {
            if (_db.Players.RemoveAll(p => p.Id == playerId) == 0) return false;
            _runtime.Remove(playerId);
            foreach (var group in _db.Groups) group.PlayerIds.Remove(playerId);
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    // ---- Cues -----------------------------------------------------------------------------

    public bool CuePlayer(string playerId, CueRequest request)
    {
        lock (_gate)
        {
            if (_db.Players.All(p => p.Id != playerId)) return false;
        }
        return Cue([playerId], request);
    }

    public bool CueGroup(string groupId, CueRequest request)
    {
        List<string> ids;
        lock (_gate)
        {
            var group = _db.Groups.FirstOrDefault(g => g.Id == groupId);
            if (group is null) return false;
            ids = [.. group.PlayerIds];
        }
        return Cue(ids, request);
    }

    /// <summary>Loads one screen of a playlist on a single player, on its own.</summary>
    public bool LoadPlayer(string playerId, string? playlistId, int screen) =>
        Load([playerId], _ => screen, linkId: null, playlistId);

    /// <summary>Loads a playlist across a group: the group's first player gets screen 1, the second screen 2, and so on.</summary>
    public bool LoadGroup(string groupId, string? playlistId)
    {
        List<string> ids;
        lock (_gate)
        {
            var group = _db.Groups.FirstOrDefault(g => g.Id == groupId);
            if (group is null) return false;
            ids = [.. group.PlayerIds];
        }
        return ids.Count > 0 && Load(ids, ids.IndexOf, linkId: groupId, playlistId);
    }

    /// <summary>Puts a playlist (or none) on players and starts it from the first cue, all in one broadcast.</summary>
    private bool Load(List<string> playerIds, Func<string, int> screenOf, string? linkId, string? playlistId)
    {
        lock (_gate)
        {
            if (playlistId is not null && _db.Playlists.All(p => p.Id != playlistId)) return false;
            var players = _db.Players.Where(p => playerIds.Contains(p.Id)).ToList();
            if (players.Count == 0) return false;
            foreach (var player in players)
            {
                player.PlaylistId = playlistId;
                player.Screen = Math.Max(0, screenOf(player.Id));
                player.LinkId = playlistId is null ? null : linkId;
                player.Index = 0;
                EnterCue(player);
            }
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    /// <summary>Applies one cue to several players inside a single lock, so they all change in the same broadcast.</summary>
    private bool Cue(List<string> playerIds, CueRequest request)
    {
        lock (_gate)
        {
            var players = _db.Players.Where(p => playerIds.Contains(p.Id)).ToList();

            // A group blackout toggle with mixed members blacks everyone out rather than swapping them.
            var blackout = request.On ?? !players.All(p => p.Blackout);

            foreach (var player in players)
            {
                switch (request.Action)
                {
                    case "next": Step(player, +1, automatic: false); break;
                    case "prev": Step(player, -1, automatic: false); break;
                    case "first": player.Index = 0; EnterCue(player); break;
                    case "goto":
                        var count = PlaylistOf(player)?.Cues.Count ?? 0;
                        if (request.Index is not { } index || index < 0 || index >= count) return false;
                        player.Index = index;
                        EnterCue(player);
                        break;
                    case "play": player.Auto = true; ArmTimer(player); break;
                    case "pause": player.Auto = false; ArmTimer(player); break;
                    case "blackout":
                        if (player.Blackout == blackout) break;
                        player.Blackout = blackout;
                        if (blackout) ArmTimer(player); else EnterCue(player);
                        break;
                    default: return false;
                }
            }
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    /// <summary>Advances timers and notices players going offline. Called several times a second.</summary>
    public void Tick()
    {
        var changed = false;
        lock (_gate)
        {
            var now = DateTime.UtcNow;
            var advanced = false;

            // Unpaired players announce every couple of seconds; drop the ones that went quiet.
            foreach (var gone in _discovered.Values.Where(d => now - d.LastSeen > OnlineTimeout).ToList())
                changed |= _discovered.Remove(gone.Id);

            var stepped = new HashSet<string>();
            foreach (var player in _db.Players)
            {
                var rt = Rt(player.Id);
                var online = now - rt.LastSeen < OnlineTimeout;
                if (rt.Online != online)
                {
                    rt.Online = online;
                    changed = true;
                }

                if (player.Auto && rt.Deadline <= now && !stepped.Contains(player.Id))
                {
                    StepLinked(player, stepped);
                    advanced = true;
                }
            }
            if (advanced) Save();
            changed |= advanced;
        }
        if (changed) Changed?.Invoke();
    }

    /// <summary>
    /// Advances a player on the timer together with the players it was loaded with, so a group
    /// stays in step whichever of them finishes its video or reaches its deadline first.
    /// </summary>
    private void StepLinked(Player player, HashSet<string> stepped)
    {
        var together = player.LinkId is null
            ? [player]
            : _db.Players.Where(p => p == player || (p.Auto && p.LinkId == player.LinkId && p.PlaylistId == player.PlaylistId && p.Index == player.Index)).ToList();
        foreach (var each in together)
            if (stepped.Add(each.Id)) Step(each, +1, automatic: true);
    }

    private void Step(Player player, int delta, bool automatic)
    {
        var playlist = PlaylistOf(player);
        var count = playlist?.Cues.Count ?? 0;
        if (count == 0) return;

        var from = Math.Clamp(player.Index, 0, count - 1);
        var next = from + delta;
        if (next >= count || next < 0)
        {
            if (!playlist!.Loop)
            {
                // Ran off the end of a non-looping playlist: hold the last cue and stop the timer.
                if (automatic) { player.Auto = false; ArmTimer(player); }
                return;
            }
            next = (next + count) % count;
        }

        // Moving forward onto an empty "hold" cell leaves this screen's item playing where it is.
        var holds = next == from + 1 && playlist!.EmptyCells == "hold" && CellAt(playlist, player, next) is null;
        player.Index = next;
        EnterCue(player, keepContent: holds);
    }

    private void EnterCue(Player player, bool keepContent = false)
    {
        player.Cue++;
        if (!keepContent) player.ContentCue = player.Cue;
        ArmTimer(player);
    }

    private void ArmTimer(Player player)
    {
        var cues = PlaylistOf(player)?.Cues;
        double? duration = cues is { Count: > 0 } ? cues[Math.Clamp(player.Index, 0, cues.Count - 1)].Duration : null;
        Rt(player.Id).Deadline = player is { Auto: true, Blackout: false } && duration is > 0
            ? DateTime.UtcNow.AddSeconds(duration.Value)
            : null;
    }

    /// <summary>The media placed in this player's column at a cue, or null for an empty cell.</summary>
    private MediaItem? CellAt(Playlist playlist, Player player, int index)
    {
        if (playlist.Screens.Count == 0) return null;
        // A player loaded on a screen the playlist does not have wraps round to one it does.
        var screen = playlist.Screens[(player.Screen % playlist.Screens.Count + playlist.Screens.Count) % playlist.Screens.Count];
        return playlist.Cues[index].Cells.TryGetValue(screen.Id, out var mediaId) ? FindMedia(mediaId) : null;
    }

    /// <summary>What this player shows at a cue: its own cell, or with "hold" the nearest filled cell above it.</summary>
    private MediaItem? MediaAt(Playlist playlist, Player player, int index)
    {
        for (var i = index; i >= 0; i--)
        {
            if (CellAt(playlist, player, i) is { } media) return media;
            if (playlist.EmptyCells != "hold") return null;
        }
        return null;
    }

    // ---- Groups ---------------------------------------------------------------------------

    public Group AddGroup(string name)
    {
        Group group;
        lock (_gate)
        {
            group = new Group { Id = NewId(), Name = name.Trim() };
            _db.Groups.Add(group);
            Save();
        }
        Changed?.Invoke();
        return group;
    }

    public bool UpdateGroup(string groupId, GroupRequest request)
    {
        lock (_gate)
        {
            var group = _db.Groups.FirstOrDefault(g => g.Id == groupId);
            if (group is null) return false;
            if (!string.IsNullOrWhiteSpace(request.Name)) group.Name = request.Name.Trim();
            group.PlayerIds = [.. request.PlayerIds.Distinct().Where(id => _db.Players.Any(p => p.Id == id))];
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    public bool DeleteGroup(string groupId)
    {
        lock (_gate)
        {
            if (_db.Groups.RemoveAll(g => g.Id == groupId) == 0) return false;
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    // ---- Playlists ------------------------------------------------------------------------

    public Playlist AddPlaylist(string name)
    {
        Playlist playlist;
        lock (_gate)
        {
            playlist = new Playlist { Id = NewId(), Name = name.Trim(), Screens = [new PlaylistScreen { Id = NewId(), Name = "Screen 1" }] };
            _db.Playlists.Add(playlist);
            Save();
        }
        Changed?.Invoke();
        return playlist;
    }

    public bool UpdatePlaylist(string playlistId, PlaylistRequest request)
    {
        static bool IsNew(string? id) => string.IsNullOrEmpty(id) || id.StartsWith("new-", StringComparison.Ordinal);

        lock (_gate)
        {
            var playlist = _db.Playlists.FirstOrDefault(p => p.Id == playlistId);
            if (playlist is null || request.Screens is not { Count: > 0 and <= 16 } || request.Cues is null) return false;

            // Cells refer to screens by the id the editor used; new screens get a real one here.
            var screenIds = new Dictionary<string, string>();
            var screens = new List<PlaylistScreen>();
            foreach (var screen in request.Screens)
            {
                var id = IsNew(screen.Id) ? NewId() : screen.Id!;
                if (screen.Id is not null) screenIds[screen.Id] = id;
                screens.Add(new PlaylistScreen { Id = id, Name = string.IsNullOrWhiteSpace(screen.Name) ? $"Screen {screens.Count + 1}" : screen.Name.Trim() });
            }

            var cues = new List<PlaylistCue>();
            foreach (var row in request.Cues)
            {
                var cue = new PlaylistCue { Id = IsNew(row.Id) ? NewId() : row.Id!, Duration = row.Duration is > 0 ? row.Duration : null };
                foreach (var (screen, mediaId) in row.Cells ?? [])
                {
                    if (string.IsNullOrEmpty(mediaId) || !screenIds.TryGetValue(screen, out var id)) continue;
                    if (FindMedia(mediaId) is null) return false;
                    cue.Cells[id] = mediaId;
                }
                cues.Add(cue);
            }

            if (!string.IsNullOrWhiteSpace(request.Name)) playlist.Name = request.Name.Trim();
            playlist.Loop = request.Loop;
            playlist.FadeMs = Math.Clamp(request.FadeMs, 0, 10_000);
            playlist.EmptyCells = request.EmptyCells == "black" ? "black" : "hold";

            // Players follow the cue they were on if it moved, rather than the row number.
            var users = _db.Players.Where(p => p.PlaylistId == playlistId).ToList();
            var onCue = users.ToDictionary(p => p.Id, p => playlist.Cues.ElementAtOrDefault(p.Index)?.Id);
            playlist.Screens = screens;
            playlist.Cues = cues;

            foreach (var player in users)
            {
                var moved = cues.FindIndex(c => c.Id == onCue[player.Id]);
                player.Index = moved >= 0 ? moved : Math.Clamp(player.Index, 0, Math.Max(0, cues.Count - 1));
                if (moved < 0) EnterCue(player); else ArmTimer(player);
            }
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    public bool DeletePlaylist(string playlistId)
    {
        lock (_gate)
        {
            if (_db.Playlists.RemoveAll(p => p.Id == playlistId) == 0) return false;
            foreach (var player in _db.Players.Where(p => p.PlaylistId == playlistId))
            {
                player.PlaylistId = null;
                player.LinkId = null;
                player.Index = 0;
                EnterCue(player);
            }
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    // ---- Media ----------------------------------------------------------------------------

    /// <summary>Adds an uploaded file to the library, taking ownership of <paramref name="tempPath"/>.</summary>
    public MediaItem AddMedia(string name, string folder, string tempPath, string sha256, string extension, string kind, long size)
    {
        MediaItem media;
        lock (_gate)
        {
            if (FindMedia(sha256) is { } existing)
            {
                File.Delete(tempPath);
                return existing;
            }

            media = new MediaItem
            {
                Id = sha256,
                Name = name,
                File = sha256 + extension,
                Kind = kind,
                Folder = folder,
                Size = size,
                Added = DateTime.UtcNow,
            };
            File.Move(tempPath, Path.Combine(MediaDir, media.File), overwrite: true);
            _db.Media.Add(media);
            EnsureFolder(folder);
            Save();
        }
        Changed?.Invoke();
        return media;
    }

    /// <summary>Renames a media item and/or moves it to another folder. Null fields are left alone.</summary>
    public bool UpdateMedia(string mediaId, MediaRequest request)
    {
        lock (_gate)
        {
            if (FindMedia(mediaId) is not { } media) return false;
            if (!string.IsNullOrWhiteSpace(request.Name)) media.Name = request.Name.Trim();
            if (request.Folder is not null)
            {
                if (NormalizeFolder(request.Folder) is not { } folder) return false;
                media.Folder = folder;
                EnsureFolder(folder);
            }
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    public bool DeleteMedia(string mediaId)
    {
        lock (_gate)
        {
            if (FindMedia(mediaId) is not { } media) return false;
            _db.Media.Remove(media);

            // Cues stay in place with that cell emptied, so the other screens keep their timing.
            foreach (var cue in _db.Playlists.SelectMany(p => p.Cues))
                foreach (var screen in cue.Cells.Where(c => c.Value == mediaId).Select(c => c.Key).ToList())
                    cue.Cells.Remove(screen);

            File.Delete(Path.Combine(MediaDir, media.File));
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    // ---- Library folders ------------------------------------------------------------------

    /// <summary>Cleans up a folder path. Returns "" for the top level and null if the path is not usable.</summary>
    public static string? NormalizeFolder(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return "";
        var parts = path.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length > 8 || parts.Any(p => p is "." or ".." || p.Length > 80 || p.Any(char.IsControl))) return null;
        return string.Join('/', parts);
    }

    public bool AddFolder(string path)
    {
        lock (_gate)
        {
            if (NormalizeFolder(path) is not { Length: > 0 } folder) return false;
            EnsureFolder(folder);
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    /// <summary>Renames or moves a folder, taking its subfolders and media with it.</summary>
    public bool MoveFolder(string path, string newPath)
    {
        lock (_gate)
        {
            if (NormalizeFolder(path) is not { Length: > 0 } from || NormalizeFolder(newPath) is not { Length: > 0 } to) return false;
            if (!_db.Folders.Contains(from) || to.StartsWith(from + "/", StringComparison.Ordinal)) return false;
            if (from != to) Rebase(from, to);
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    /// <summary>Removes a folder. Its media and subfolders move up into the parent; nothing is deleted.</summary>
    public bool DeleteFolder(string path)
    {
        lock (_gate)
        {
            if (NormalizeFolder(path) is not { Length: > 0 } folder || !_db.Folders.Contains(folder)) return false;
            Rebase(folder, ParentFolder(folder));
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    /// <summary>Re-roots everything at or under <paramref name="from"/> so that it sits at <paramref name="to"/> instead.</summary>
    private void Rebase(string from, string to)
    {
        string Move(string path) =>
            path == from ? to
            : path.StartsWith(from + "/", StringComparison.Ordinal) ? (to == "" ? path[(from.Length + 1)..] : to + path[from.Length..])
            : path;

        foreach (var media in _db.Media) media.Folder = Move(media.Folder ?? "");
        var folders = _db.Folders.Select(Move).ToList();
        _db.Folders.Clear();
        foreach (var folder in folders) EnsureFolder(folder);
    }

    private void EnsureFolder(string path)
    {
        for (; path != ""; path = ParentFolder(path))
            if (!_db.Folders.Contains(path)) _db.Folders.Add(path);
    }

    private static string ParentFolder(string path)
    {
        var slash = path.LastIndexOf('/');
        return slash < 0 ? "" : path[..slash];
    }

    // ---- Helpers --------------------------------------------------------------------------

    private Runtime Rt(string playerId)
    {
        if (!_runtime.TryGetValue(playerId, out var rt))
            _runtime[playerId] = rt = new Runtime();
        return rt;
    }

    private Playlist? PlaylistOf(Player? player) =>
        player?.PlaylistId is { } id ? _db.Playlists.FirstOrDefault(p => p.Id == id) : null;

    private MediaItem? FindMedia(string mediaId) => _db.Media.FirstOrDefault(m => m.Id == mediaId);

    private static string NewId() => Guid.NewGuid().ToString("N")[..10];

    private void Save()
    {
        var temp = _file + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(_db, Json.Indented));
        File.Move(temp, _file, overwrite: true);
    }
}
