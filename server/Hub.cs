using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace CueSign.Server;

/// <summary>
/// Keeps the WebSocket connections of players and control UIs, and pushes fresh state to
/// each of them whenever the show changes.
/// </summary>
public sealed class Hub
{
    private sealed class Connection(WebSocket socket, string? playerId)
    {
        public WebSocket Socket { get; } = socket;
        /// <summary>Null for a control UI connection.</summary>
        public string? PlayerId { get; } = playerId;
        public string? LastSent;
        // State messages supersede each other, so a slow client only ever needs the newest.
        public Channel<string> Outbox { get; } = Channel.CreateBounded<string>(
            new BoundedChannelOptions(4) { FullMode = BoundedChannelFullMode.DropOldest });
    }

    private readonly ShowService _show;
    private readonly ConcurrentDictionary<Guid, Connection> _connections = new();

    public Hub(ShowService show)
    {
        _show = show;
        _show.Changed += Broadcast;
    }

    private void Broadcast()
    {
        foreach (var connection in _connections.Values)
            Push(connection);
    }

    private void Push(Connection connection)
    {
        // Taking the snapshot and queuing it under one lock keeps messages in order per connection.
        lock (connection)
        {
            var json = connection.PlayerId is { } id ? _show.PlayerStateJson(id) : _show.SnapshotJson();

            if (connection.PlayerId is not null && json == connection.LastSent) return;
            connection.LastSent = json;
            connection.Outbox.Writer.TryWrite(json);
        }
    }

    public async Task RunAsync(WebSocket socket, string? playerId, CancellationToken cancel)
    {
        var key = Guid.NewGuid();
        var connection = new Connection(socket, playerId);
        _connections[key] = connection;
        var writer = WriteLoopAsync(connection, cancel);

        try
        {
            Push(connection);

            var buffer = new byte[16 * 1024];
            while (socket.State == WebSocketState.Open)
            {
                using var message = new MemoryStream();
                ValueWebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer.AsMemory(), cancel);
                    if (result.MessageType == WebSocketMessageType.Close) return;
                    message.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                if (playerId is null) continue;
                try
                {
                    using var doc = JsonDocument.Parse(message.ToArray());
                    _show.PlayerMessage(playerId, doc.RootElement);
                }
                catch (JsonException)
                {
                    // Ignore malformed messages rather than dropping the player.
                }
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException)
        {
        }
        finally
        {
            _connections.TryRemove(key, out _);
            connection.Outbox.Writer.TryComplete();
            await writer;
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                try
                {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, timeout.Token);
                }
                catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException)
                {
                }
            }
        }
    }

    private static async Task WriteLoopAsync(Connection connection, CancellationToken cancel)
    {
        try
        {
            await foreach (var json in connection.Outbox.Reader.ReadAllAsync(cancel))
                await connection.Socket.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, cancel);
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException or ObjectDisposedException)
        {
        }
    }
}

/// <summary>Drives playlist timers and online/offline detection.</summary>
public sealed class Scheduler(ShowService show) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(100));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
                show.Tick();
        }
        catch (OperationCanceledException)
        {
        }
    }
}
