using System.Text.Json;

namespace CueSign.Server;

public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
    public static readonly JsonSerializerOptions Indented = new(JsonSerializerDefaults.Web) { WriteIndented = true };
}

public static class MediaKinds
{
    private static readonly HashSet<string> Images = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
    private static readonly HashSet<string> Videos = [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ts", ".mpg", ".mpeg"];

    public static string? FromExtension(string ext) =>
        Images.Contains(ext) ? "image" : Videos.Contains(ext) ? "video" : null;
}

/// <summary>A file in the library. Id is the SHA-256 of its content, so players can cache by id.</summary>
public sealed class MediaItem
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public required string File { get; set; }
    public required string Kind { get; set; }
    public long Size { get; set; }
    public DateTime Added { get; set; }
}

public sealed class PlaylistItem
{
    public required string Id { get; set; }
    public required string MediaId { get; set; }
    /// <summary>Seconds on screen when the timer is running. Null: videos play once, images hold.</summary>
    public double? Duration { get; set; }
}

public sealed class Playlist
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public bool Loop { get; set; } = true;
    public int FadeMs { get; set; } = 500;
    public List<PlaylistItem> Items { get; set; } = [];
}

public sealed class Player
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public string? PlaylistId { get; set; }
    public int Index { get; set; }
    /// <summary>Incremented every time the player should (re)start its current item.</summary>
    public long Cue { get; set; }
    public bool Auto { get; set; }
    public bool Blackout { get; set; }
}

public sealed class Group
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public List<string> PlayerIds { get; set; } = [];
}

public sealed class Db
{
    public List<MediaItem> Media { get; set; } = [];
    public List<Playlist> Playlists { get; set; } = [];
    public List<Player> Players { get; set; } = [];
    public List<Group> Groups { get; set; } = [];
}

public sealed record NameRequest(string Name);
public sealed record PlaylistItemRequest(string? Id, string MediaId, double? Duration);
public sealed record PlaylistRequest(string Name, bool Loop, int FadeMs, List<PlaylistItemRequest> Items);
public sealed record PlayerRequest(string Name, string? PlaylistId);
public sealed record GroupRequest(string Name, List<string> PlayerIds);
/// <summary>Action is one of: next, prev, first, goto, play, pause, blackout.</summary>
public sealed record CueRequest(string Action, int? Index, bool? On);
