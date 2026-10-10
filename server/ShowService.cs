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

    public string DataDir { get; }
    public string MediaDir { get; }

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

        foreach (var player in _db.Players)
            ArmTimer(player);
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
                media = _db.Media.Select(m => new { m.Id, m.Name, m.Kind, m.Size, m.Added, url = "/media/" + m.File }),
                playlists = _db.Playlists,
                groups = _db.Groups,
                players = _db.Players.Select(p =>
                {
                    var rt = Rt(p.Id);
                    return new
                    {
                        p.Id,
                        p.Name,
                        p.PlaylistId,
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
            var items = playlist?.Items ?? [];
            var index = items.Count == 0 ? 0 : Math.Clamp(player!.Index, 0, items.Count - 1);

            object? current = null;
            if (player is { Blackout: false } && items.Count > 0 && FindMedia(items[index].MediaId) is { } media)
            {
                // With the timer running and no fixed duration, a video plays once and reports back.
                var playOnce = player.Auto && media.Kind == "video" && items[index].Duration is not > 0;
                current = new { media.Id, media.File, url = "/media/" + media.File, media.Kind, media.Size, loop = !playOnce };
            }

            // Cache order: the current item first, then the rest of the playlist in play order.
            var assets = Enumerable.Range(0, items.Count)
                .Select(i => FindMedia(items[(index + i) % items.Count].MediaId))
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
                    Step(player, +1, automatic: true);
                    Save();
                    break;
                default:
                    return;
            }
        }
        Changed?.Invoke();
    }

    public bool UpdatePlayer(string playerId, PlayerRequest request)
    {
        lock (_gate)
        {
            var player = _db.Players.FirstOrDefault(p => p.Id == playerId);
            if (player is null) return false;
            if (request.PlaylistId is not null && _db.Playlists.All(p => p.Id != request.PlaylistId)) return false;

            if (!string.IsNullOrWhiteSpace(request.Name)) player.Name = request.Name.Trim();
            if (player.PlaylistId != request.PlaylistId)
            {
                player.PlaylistId = request.PlaylistId;
                player.Index = 0;
                EnterCue(player);
            }
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
                        var count = PlaylistOf(player)?.Items.Count ?? 0;
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
            foreach (var player in _db.Players)
            {
                var rt = Rt(player.Id);
                var online = now - rt.LastSeen < OnlineTimeout;
                if (rt.Online != online)
                {
                    rt.Online = online;
                    changed = true;
                }

                if (player.Auto && rt.Deadline <= now)
                {
                    Step(player, +1, automatic: true);
                    advanced = true;
                }
            }
            if (advanced) Save();
            changed |= advanced;
        }
        if (changed) Changed?.Invoke();
    }

    private void Step(Player player, int delta, bool automatic)
    {
        var playlist = PlaylistOf(player);
        var count = playlist?.Items.Count ?? 0;
        if (count == 0) return;

        var next = Math.Clamp(player.Index, 0, count - 1) + delta;
        if (next >= count || next < 0)
        {
            if (!playlist!.Loop)
            {
                // Ran off the end of a non-looping playlist: hold the last item and stop the timer.
                if (automatic) { player.Auto = false; ArmTimer(player); }
                return;
            }
            next = (next + count) % count;
        }
        player.Index = next;
        EnterCue(player);
    }

    private void EnterCue(Player player)
    {
        player.Cue++;
        ArmTimer(player);
    }

    private void ArmTimer(Player player)
    {
        var items = PlaylistOf(player)?.Items;
        double? duration = items is { Count: > 0 } ? items[Math.Clamp(player.Index, 0, items.Count - 1)].Duration : null;
        Rt(player.Id).Deadline = player is { Auto: true, Blackout: false } && duration is > 0
            ? DateTime.UtcNow.AddSeconds(duration.Value)
            : null;
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
            playlist = new Playlist { Id = NewId(), Name = name.Trim() };
            _db.Playlists.Add(playlist);
            Save();
        }
        Changed?.Invoke();
        return playlist;
    }

    public bool UpdatePlaylist(string playlistId, PlaylistRequest request)
    {
        lock (_gate)
        {
            var playlist = _db.Playlists.FirstOrDefault(p => p.Id == playlistId);
            if (playlist is null) return false;
            if (request.Items.Any(i => FindMedia(i.MediaId) is null)) return false;

            if (!string.IsNullOrWhiteSpace(request.Name)) playlist.Name = request.Name.Trim();
            playlist.Loop = request.Loop;
            playlist.FadeMs = Math.Clamp(request.FadeMs, 0, 10_000);

            // Players follow the item they were on if it moved, rather than the slot number.
            var users = _db.Players.Where(p => p.PlaylistId == playlistId).ToList();
            var onItem = users.ToDictionary(p => p.Id, p => playlist.Items.ElementAtOrDefault(p.Index)?.Id);

            playlist.Items = [.. request.Items.Select(i => new PlaylistItem
            {
                Id = string.IsNullOrEmpty(i.Id) ? NewId() : i.Id,
                MediaId = i.MediaId,
                Duration = i.Duration is > 0 ? i.Duration : null,
            })];

            foreach (var player in users)
            {
                var moved = playlist.Items.FindIndex(i => i.Id == onItem[player.Id]);
                player.Index = moved >= 0 ? moved : Math.Clamp(player.Index, 0, Math.Max(0, playlist.Items.Count - 1));
                if (moved < 0) EnterCue(player);
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
    public MediaItem AddMedia(string name, string tempPath, string sha256, string extension, string kind, long size)
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
                Size = size,
                Added = DateTime.UtcNow,
            };
            File.Move(tempPath, Path.Combine(MediaDir, media.File), overwrite: true);
            _db.Media.Add(media);
            Save();
        }
        Changed?.Invoke();
        return media;
    }

    public bool RenameMedia(string mediaId, string name)
    {
        lock (_gate)
        {
            if (FindMedia(mediaId) is not { } media || string.IsNullOrWhiteSpace(name)) return false;
            media.Name = name.Trim();
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

            foreach (var playlist in _db.Playlists.Where(p => p.Items.Any(i => i.MediaId == mediaId)))
            {
                var users = _db.Players.Where(p => p.PlaylistId == playlist.Id).ToList();
                var onItem = users.ToDictionary(p => p.Id, p => playlist.Items.ElementAtOrDefault(p.Index)?.Id);
                playlist.Items.RemoveAll(i => i.MediaId == mediaId);
                foreach (var player in users)
                {
                    var moved = playlist.Items.FindIndex(i => i.Id == onItem[player.Id]);
                    player.Index = moved >= 0 ? moved : Math.Clamp(player.Index, 0, Math.Max(0, playlist.Items.Count - 1));
                    if (moved < 0) EnterCue(player);
                }
            }

            File.Delete(Path.Combine(MediaDir, media.File));
            Save();
        }
        Changed?.Invoke();
        return true;
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
