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
var port = builder.Configuration["port"] ?? Environment.GetEnvironmentVariable("CUESIGN_PORT") ?? "8080";
var dataDir = Path.GetFullPath(builder.Configuration["data"] ?? Environment.GetEnvironmentVariable("CUESIGN_DATA") ?? "data");
var playerDir = Path.Combine(baseDir, "player");

builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = null); // videos are large
builder.Services.AddSingleton(new ShowService(dataDir));
builder.Services.AddSingleton<Hub>();
builder.Services.AddHostedService<Scheduler>();
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();
var show = app.Services.GetRequiredService<ShowService>();
var hub = app.Services.GetRequiredService<Hub>();
var contentTypes = new FileExtensionContentTypeProvider();

app.UseCors(); // the player page runs from file:// on the BrightSign
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(10) });
app.UseDefaultFiles();
app.UseStaticFiles();
if (Directory.Exists(playerDir))
{
    // The same player files that go on the SD card, served for previewing in a desktop browser.
    var playerFiles = new PhysicalFileProvider(playerDir);
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = playerFiles, RequestPath = "/player" });
    app.UseStaticFiles(new StaticFileOptions { FileProvider = playerFiles, RequestPath = "/player" });
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
    if (!ctx.WebSockets.IsWebSocketRequest || !IsValidPlayerId(id)) { ctx.Response.StatusCode = 400; return; }
    show.PlayerSeen(id, ctx.Request.Query["name"]);
    using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
    await hub.RunAsync(socket, id, app.Lifetime.ApplicationStopping);
});

// ---- Player API (polling fallback for when the WebSocket is down) ---------------------------

app.MapGet("/api/player/{id}/state", (string id, string? name) =>
{
    if (!IsValidPlayerId(id)) return Results.BadRequest();
    show.PlayerSeen(id, name);
    return Results.Content(show.PlayerStateJson(id), "application/json");
});

app.MapPost("/api/player/{id}/message", (string id, JsonElement message) =>
{
    if (!IsValidPlayerId(id)) return Results.BadRequest();
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

// Upload one file as the raw request body: POST /api/media?name=clip.mp4
app.MapPost("/api/media", async (HttpRequest request, string name) =>
{
    name = Path.GetFileName(name);
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
        return Results.Json(show.AddMedia(name, temp, id, extension, kind, size), Json.Options);
    }
    finally
    {
        if (File.Exists(temp)) File.Delete(temp);
    }
});

app.MapPut("/api/media/{id}", (string id, NameRequest request) => Done(show.RenameMedia(id, request.Name)));
app.MapDelete("/api/media/{id}", (string id) => Done(show.DeleteMedia(id)));

// ---- Control API ----------------------------------------------------------------------------

app.MapGet("/api/state", () => Results.Content(show.SnapshotJson(), "application/json"));

app.MapPost("/api/playlists", (NameRequest request) => Results.Json(show.AddPlaylist(request.Name), Json.Options));
app.MapPut("/api/playlists/{id}", (string id, PlaylistRequest request) => Done(show.UpdatePlaylist(id, request)));
app.MapDelete("/api/playlists/{id}", (string id) => Done(show.DeletePlaylist(id)));

app.MapPut("/api/players/{id}", (string id, PlayerRequest request) => Done(show.UpdatePlayer(id, request)));
app.MapDelete("/api/players/{id}", (string id) => Done(show.DeletePlayer(id)));
app.MapPost("/api/players/{id}/cue", (string id, CueRequest request) => Done(show.CuePlayer(id, request)));

app.MapPost("/api/groups", (NameRequest request) => Results.Json(show.AddGroup(request.Name), Json.Options));
app.MapPut("/api/groups/{id}", (string id, GroupRequest request) => Done(show.UpdateGroup(id, request)));
app.MapDelete("/api/groups/{id}", (string id) => Done(show.DeleteGroup(id)));
app.MapPost("/api/groups/{id}/cue", (string id, CueRequest request) => Done(show.CueGroup(id, request)));

// ---- Player setup ---------------------------------------------------------------------------

app.MapGet("/api/info", () => Results.Json(new { addresses = LanAddresses().Select(a => $"http://{a}:{port}") }, Json.Options));

// The SD card contents for a BrightSign, with config.json pointing at this server.
app.MapGet("/api/player-package", (string? server, HttpRequest request) =>
{
    if (!Directory.Exists(playerDir)) return Results.NotFound();
    server = string.IsNullOrWhiteSpace(server) ? $"{request.Scheme}://{request.Host}" : server.Trim().TrimEnd('/');

    using var buffer = new MemoryStream();
    using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
    {
        foreach (var path in Directory.EnumerateFiles(playerDir, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(playerDir, path).Replace('\\', '/');
            if (relative != "config.json") zip.CreateEntryFromFile(path, relative);
        }
        using var config = new StreamWriter(zip.CreateEntry("config.json").Open());
        config.Write(JsonSerializer.Serialize(new { server }, Json.Indented));
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

static bool IsValidPlayerId(string id) => Regex.IsMatch(id, "^[A-Za-z0-9._-]{1,64}$");

static IEnumerable<string> LanAddresses() =>
    NetworkInterface.GetAllNetworkInterfaces()
        .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
        .SelectMany(n => n.GetIPProperties().UnicastAddresses)
        .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork)
        .Select(a => a.Address.ToString())
        .Distinct();
