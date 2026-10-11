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
    /// <summary>Library folder path such as "Act 1/Walk-in". Empty for the top level.</summary>
    public string Folder { get; set; } = "";
    public long Size { get; set; }
    public DateTime Added { get; set; }
}

/// <summary>An entry of a pre-grid playlist. Only used to convert old data files.</summary>
public sealed class PlaylistItem
{
    public required string Id { get; set; }
    public required string MediaId { get; set; }
    public double? Duration { get; set; }
}

/// <summary>A column of a playlist: one display's worth of content. Named, not tied to a player.</summary>
public sealed class PlaylistScreen
{
    public required string Id { get; set; }
    public required string Name { get; set; }
}

/// <summary>A row of a playlist: what every screen shows at one moment.</summary>
public sealed class PlaylistCue
{
    public required string Id { get; set; }
    /// <summary>Seconds on screen when the timer is running. Null: wait for a video to end or a manual cue.</summary>
    public double? Duration { get; set; }
    /// <summary>Screen id → media id. A screen with no entry is an empty cell.</summary>
    public Dictionary<string, string> Cells { get; set; } = [];
}

/// <summary>A grid of cues (rows) by screens (columns). A single-screen playlist is a grid with one column.</summary>
public sealed class Playlist
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public bool Loop { get; set; } = true;
    public int FadeMs { get; set; } = 500;
    /// <summary>What an empty cell means: "hold" keeps that screen's previous item up, "black" clears it.</summary>
    public string EmptyCells { get; set; } = "hold";
    public List<PlaylistScreen> Screens { get; set; } = [];
    public List<PlaylistCue> Cues { get; set; } = [];

    /// <summary>The pre-grid format, read only so old data files can be converted on load.</summary>
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public List<PlaylistItem>? Items { get; set; }
}

public sealed class Player
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public string? PlaylistId { get; set; }
    /// <summary>Which column of the playlist this player shows. Wraps if the playlist has fewer screens.</summary>
    public int Screen { get; set; }
    /// <summary>The group this player was loaded with, if any. Linked players advance together on the timer.</summary>
    public string? LinkId { get; set; }
    public int Index { get; set; }
    /// <summary>Incremented every time the player enters a cue.</summary>
    public long Cue { get; set; }
    /// <summary>The value of Cue when the item now on screen started. Unchanged while an empty cell holds it.</summary>
    public long ContentCue { get; set; }
    public bool Auto { get; set; }
    public bool Blackout { get; set; }
}

public sealed class Group
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public List<string> PlayerIds { get; set; } = [];
}

/// <summary>An unpaired player heard announcing itself on the network.</summary>
public sealed class DiscoveredPlayer
{
    public required string Id { get; init; }
    public string? Model { get; init; }
    public string? Os { get; init; }
    public required string Address { get; init; }
    [System.Text.Json.Serialization.JsonIgnore] public required System.Net.IPEndPoint EndPoint { get; init; }
    [System.Text.Json.Serialization.JsonIgnore] public DateTime LastSeen { get; set; }
}

public static class PlayerIds
{
    public static bool IsValid(string? id) =>
        id is not null && System.Text.RegularExpressions.Regex.IsMatch(id, "^[A-Za-z0-9._-]{1,64}$");
}

public sealed class Db
{
    /// <summary>Identifies this server to its paired players, so they only follow the server they belong to.</summary>
    public string? ServerId { get; set; }
    public List<MediaItem> Media { get; set; } = [];
    /// <summary>Every library folder path, including empty folders and all ancestors.</summary>
    public List<string> Folders { get; set; } = [];
    public List<Playlist> Playlists { get; set; } = [];
    public List<Player> Players { get; set; } = [];
    public List<Group> Groups { get; set; } = [];
}

public sealed record NameRequest(string Name);
public sealed record MediaRequest(string? Name, string? Folder);
public sealed record FolderRequest(string Path);
public sealed record FolderMoveRequest(string Path, string NewPath);
public sealed record LoadRequest(string? PlaylistId, int? Screen);
public sealed record ScreenRequest(string? Id, string? Name);
public sealed record CueRowRequest(string? Id, double? Duration, Dictionary<string, string?>? Cells);
/// <summary>Screens and cues created in the editor carry ids starting "new-"; the server replaces them.</summary>
public sealed record PlaylistRequest(string Name, bool Loop, int FadeMs, string? EmptyCells, List<ScreenRequest> Screens, List<CueRowRequest> Cues);
public sealed record PlayerRequest(string Name);
public sealed record GroupRequest(string Name, List<string> PlayerIds);
/// <summary>Action is one of: next, prev, first, goto, play, pause, blackout.</summary>
public sealed record CueRequest(string Action, int? Index, bool? On);
