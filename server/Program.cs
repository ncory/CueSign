using System.IO.Compression;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using CueSign.Server;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;

// A published build keeps wwwroot next to the executable; "dotnet run" keeps it in the project folder.
var baseDir = AppContext.BaseDirectory;
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = Directory.Exists(Path.Combine(baseDir, "wwwroot")) ? baseDir : Directory.GetCurrentDirectory(),
});

// Options: --port 8080 --data ./data   (or CUESIGN_PORT / CUESIGN_DATA)
//          --player-updates false   stops players updating their own code from this server
var port = builder.Configuration["port"] ?? Environment.GetEnvironmentVariable("CUESIGN_PORT") ?? "8080";
var dataDir = Path.GetFullPath(builder.Configuration["data"] ?? Environment.GetEnvironmentVariable("CUESIGN_DATA") ?? "data");
var playerDir = Path.Combine(baseDir, "player");

builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = null); // videos are large
builder.Services.AddSingleton(new ShowService(dataDir));
builder.Services.AddSingleton<Hub>();
builder.Services.AddHostedService<Scheduler>();
builder.Services.AddSingleton(sp => new Discovery(sp.GetRequiredService<ShowService>(), int.Parse(port), sp.GetRequiredService<ILogger<Discovery>>()));
builder.Services.AddHostedService(sp => sp.GetRequiredService<Discovery>());
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();
var show = app.Services.GetRequiredService<ShowService>();
var hub = app.Services.GetRequiredService<Hub>();
var discovery = app.Services.GetRequiredService<Discovery>();
var contentTypes = new FileExtensionContentTypeProvider();

// The files that make up a player's SD card. Players compare these hashes with their own
// copies and download whatever differs.
// TODO(production): reconsider self-update before a final release. It lets any server a
// player is paired with replace the player's code; see "Before a production release" in the README.
string[] playerFileNames = ["autorun.brs", "index.html", "player.js"];
if (Directory.Exists(playerDir) && !string.Equals(builder.Configuration["player-updates"], "false", StringComparison.OrdinalIgnoreCase))
{
    var files = playerFileNames.Where(name => File.Exists(Path.Combine(playerDir, name))).Select(name =>
    {
        var bytes = File.ReadAllBytes(Path.Combine(playerDir, name));
        return new { name, sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), size = bytes.Length };
    }).ToList();
    var version = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(string.Join("|", files.Select(f => f.sha256)))))[..12].ToLowerInvariant();
    show.PlayerSoftware = new { version, files };
}

app.UseCors(); // the player page runs from file:// on the BrightSign
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(10) });
app.UseDefaultFiles();
app.UseStaticFiles();
if (Directory.Exists(playerDir))
{
    // The same player files that go on the SD card, served for previewing in a desktop browser.
    var playerFiles = new PhysicalFileProvider(playerDir);
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = playerFiles, RequestPath = "/player" });
    // ServeUnknownFileTypes: autorun.brs has no registered content type, and players fetch it to update.
    app.UseStaticFiles(new StaticFileOptions { FileProvider = playerFiles, RequestPath = "/player", ServeUnknownFileTypes = true });
}

// ---- WebSockets -----------------------------------------------------------------------------

app.Map("/ws/control", async (HttpContext ctx) =>
{
    if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
    using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
    await hub.RunAsync(socket, null, app.Lifetime.ApplicationStopping);
});

app.Map("/ws/player", async (HttpContext ctx) =>
{
    var id = ctx.Request.Query["id"].ToString();
    if (!ctx.WebSockets.IsWebSocketRequest || !PlayerIds.IsValid(id)) { ctx.Response.StatusCode = 400; return; }
    show.PlayerSeen(id, ctx.Request.Query["name"]);
    using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
    await hub.RunAsync(socket, id, app.Lifetime.ApplicationStopping);
});

// ---- Player API (polling fallback for when the WebSocket is down) ---------------------------

app.MapGet("/api/player/{id}/state", (string id, string? name) =>
{
    if (!PlayerIds.IsValid(id)) return Results.BadRequest();
    show.PlayerSeen(id, name);
    return Results.Content(show.PlayerStateJson(id), "application/json");
});

app.MapPost("/api/player/{id}/message", (string id, JsonElement message) =>
{
    if (!PlayerIds.IsValid(id)) return Results.BadRequest();
    show.PlayerMessage(id, message);
    return Results.NoContent();
});

// ---- Media ----------------------------------------------------------------------------------

app.MapGet("/media/{file}", (string file, HttpContext ctx) =>
{
    if (!Regex.IsMatch(file, "^[0-9a-f]{64}\\.[a-z0-9]+$")) return Results.NotFound();
    var path = Path.Combine(show.MediaDir, file);
    if (!File.Exists(path)) return Results.NotFound();
    if (!contentTypes.TryGetContentType(file, out var type)) type = "application/octet-stream";
    // The file name is the content hash, so a URL never changes meaning.
    ctx.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
    return Results.File(path, type, enableRangeProcessing: true);
});

// Upload one file as the raw request body: POST /api/media?name=clip.mp4&folder=Act%201
app.MapPost("/api/media", async (HttpRequest request, string name, string? folder) =>
{
    name = Path.GetFileName(name);
    if (ShowService.NormalizeFolder(folder) is not { } target) return Results.Problem("Invalid folder.", statusCode: 400);
    var extension = Path.GetExtension(name).ToLowerInvariant();
    if (MediaKinds.FromExtension(extension) is not { } kind)
        return Results.Problem($"Unsupported file type '{extension}'.", statusCode: 415);

    var temp = Path.Combine(show.MediaDir, $".upload-{Guid.NewGuid():N}");
    try
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long size = 0;
        await using (var output = File.Create(temp))
        {
            var buffer = new byte[128 * 1024];
            int read;
            while ((read = await request.Body.ReadAsync(buffer, request.HttpContext.RequestAborted)) > 0)
            {
                sha.AppendData(buffer, 0, read);
                await output.WriteAsync(buffer.AsMemory(0, read));
                size += read;
            }
        }
        if (size == 0) return Results.Problem("Empty upload.", statusCode: 400);

        var id = Convert.ToHexString(sha.GetHashAndReset()).ToLowerInvariant();
        return Results.Json(show.AddMedia(name, target, temp, id, extension, kind, size), Json.Options);
    }
    finally
    {
        if (File.Exists(temp)) File.Delete(temp);
    }
});

app.MapPut("/api/media/{id}", (string id, MediaRequest request) => Done(show.UpdateMedia(id, request)));
app.MapDelete("/api/media/{id}", (string id) => Done(show.DeleteMedia(id)));

app.MapPost("/api/folders", (FolderRequest request) => Done(show.AddFolder(request.Path)));
app.MapPut("/api/folders", (FolderMoveRequest request) => Done(show.MoveFolder(request.Path, request.NewPath)));
app.MapDelete("/api/folders", (string path) => Done(show.DeleteFolder(path)));

// ---- Control API ----------------------------------------------------------------------------

app.MapGet("/api/state", () => Results.Content(show.SnapshotJson(), "application/json"));

app.MapPost("/api/playlists", (NameRequest request) => Results.Json(show.AddPlaylist(request.Name), Json.Options));
app.MapPut("/api/playlists/{id}", (string id, PlaylistRequest request) => Done(show.UpdatePlaylist(id, request)));
app.MapDelete("/api/playlists/{id}", (string id) => Done(show.DeletePlaylist(id)));

app.MapPut("/api/players/{id}", (string id, PlayerRequest request) => Done(show.UpdatePlayer(id, request)));
// Unpairing sends a connected player back to waiting to be paired, then forgets it here.
app.MapDelete("/api/players/{id}", (string id) =>
{
    discovery.CancelPairing(id);
    hub.Unpair(id);
    return Done(show.DeletePlayer(id));
});
app.MapPost("/api/discovered/{id}/pair", async (string id) => Done(await discovery.PairAsync(id)));
app.MapPost("/api/players/{id}/cue", (string id, CueRequest request) => Done(show.CuePlayer(id, request)));
app.MapPost("/api/players/{id}/load", (string id, LoadRequest request) => Done(show.LoadPlayer(id, request.PlaylistId, request.Screen ?? 0)));

app.MapPost("/api/groups", (NameRequest request) => Results.Json(show.AddGroup(request.Name), Json.Options));
app.MapPut("/api/groups/{id}", (string id, GroupRequest request) => Done(show.UpdateGroup(id, request)));
app.MapDelete("/api/groups/{id}", (string id) => Done(show.DeleteGroup(id)));
app.MapPost("/api/groups/{id}/cue", (string id, CueRequest request) => Done(show.CueGroup(id, request)));
app.MapPost("/api/groups/{id}/load", (string id, LoadRequest request) => Done(show.LoadGroup(id, request.PlaylistId)));

// ---- Player setup ---------------------------------------------------------------------------

app.MapGet("/api/info", () => Results.Json(new { addresses = LanAddresses().Select(a => $"http://{a}:{port}") }, Json.Options));

// The SD card contents for a BrightSign. They are the same for every player, which finds the
// server by pairing; pass ?server= to pin a fixed address in config.json instead.
app.MapGet("/api/player-package", (string? server) =>
{
    if (!Directory.Exists(playerDir)) return Results.NotFound();

    using var buffer = new MemoryStream();
    using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
    {
        foreach (var name in playerFileNames.Where(name => File.Exists(Path.Combine(playerDir, name))))
            zip.CreateEntryFromFile(Path.Combine(playerDir, name), name);
        if (!string.IsNullOrWhiteSpace(server))
        {
            using var config = new StreamWriter(zip.CreateEntry("config.json").Open());
            config.Write(JsonSerializer.Serialize(new { server = server.Trim().TrimEnd('/') }, Json.Indented));
        }
    }
    return Results.File(buffer.ToArray(), "application/zip", "cuesign-player-sd.zip");
});

app.Lifetime.ApplicationStarted.Register(() =>
{
    Console.WriteLine($"CueSign data folder: {dataDir}");
    Console.WriteLine($"Control UI:          http://localhost:{port}");
    foreach (var address in LanAddresses())
        Console.WriteLine($"On the network:      http://{address}:{port}");
});

app.Run();

static IResult Done(bool ok) => ok ? Results.NoContent() : Results.NotFound();

static IEnumerable<string> LanAddresses() =>
    NetworkInterface.GetAllNetworkInterfaces()
        .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
        .SelectMany(n => n.GetIPProperties().UnicastAddresses)
        .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork)
        .Select(a => a.Address.ToString())
        .Distinct();
