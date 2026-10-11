using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace CueSign.Server;

/// <summary>
/// Finds players on the local network. A player with no server broadcasts an "announce"
/// datagram; pairing answers it with this server's address and id. A player that is already
/// paired with this server but has lost it announces with our id and is answered straight
/// away, which is how players follow the server to a new IP address.
/// </summary>
public sealed class Discovery(ShowService show, int httpPort, ILogger<Discovery> log) : BackgroundService
{
    public const int Port = 48550;
    private static readonly TimeSpan PairRetryWindow = TimeSpan.FromSeconds(10);

    private UdpClient? _udp;
    // Datagrams can be lost, so a requested pairing is re-sent each time the player announces again.
    private readonly ConcurrentDictionary<string, DateTime> _pairing = new();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            var udp = new UdpClient(AddressFamily.InterNetwork) { EnableBroadcast = true };
            udp.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            udp.Client.Bind(new IPEndPoint(IPAddress.Any, Port));
            _udp = udp;
        }
        catch (SocketException e)
        {
            log.LogWarning("Player discovery is off: cannot listen on UDP port {Port} ({Error}). Players need a fixed server address in config.json.", Port, e.Message);
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var datagram = await _udp.ReceiveAsync(stoppingToken);
                await HandleAsync(datagram);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception e) when (e is SocketException or JsonException)
            {
                // A malformed datagram, or (on Windows) an ICMP error from an earlier reply.
            }
        }
        _udp.Dispose();
    }

    private async Task HandleAsync(UdpReceiveResult datagram)
    {
        using var doc = JsonDocument.Parse(datagram.Buffer);
        var message = doc.RootElement;
        if (message.ValueKind != JsonValueKind.Object) return;
        if (!message.TryGetProperty("cuesign", out var version) || version.ValueKind != JsonValueKind.Number || version.GetInt32() != 1) return;
        if (Text(message, "type") != "announce" || Text(message, "id") is not { } id || !PlayerIds.IsValid(id)) return;

        var theirServer = Text(message, "serverId");
        if (theirServer == show.ServerId)
        {
            await SendPairAsync(datagram.RemoteEndPoint);
        }
        else if (theirServer is null)
        {
            show.PlayerAnnounced(new DiscoveredPlayer
            {
                Id = id,
                Model = Text(message, "model"),
                Os = Text(message, "os"),
                Address = datagram.RemoteEndPoint.Address.ToString(),
                EndPoint = datagram.RemoteEndPoint,
            });

            if (_pairing.TryGetValue(id, out var requested))
            {
                if (DateTime.UtcNow - requested < PairRetryWindow) await SendPairAsync(datagram.RemoteEndPoint);
                else _pairing.TryRemove(id, out _);
            }
        }
        // Otherwise the player belongs to a different CueSign server: leave it alone.
    }

    /// <summary>Pairs a player that is currently announcing itself. False if it is not on the network.</summary>
    public async Task<bool> PairAsync(string playerId)
    {
        if (_udp is null || show.DiscoveredEndPoint(playerId) is not { } endPoint) return false;
        _pairing[playerId] = DateTime.UtcNow;
        await SendPairAsync(endPoint);
        return true;
    }

    /// <summary>Stops re-sending a pairing, so a player that was just unpaired is not paired straight back.</summary>
    public void CancelPairing(string playerId) => _pairing.TryRemove(playerId, out _);

    private async Task SendPairAsync(IPEndPoint player)
    {
        if (_udp is null) return;
        var reply = JsonSerializer.Serialize(new
        {
            cuesign = 1,
            type = "pair",
            serverId = show.ServerId,
            url = $"http://{LocalAddressFacing(player.Address)}:{httpPort}",
        }, Json.Options);
        await _udp.SendAsync(Encoding.UTF8.GetBytes(reply), player);
    }

    /// <summary>The address of whichever network interface this machine would use to reach the player.</summary>
    private static IPAddress LocalAddressFacing(IPAddress player)
    {
        using var probe = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        probe.Connect(player, Port); // UDP: picks a route, sends nothing
        return ((IPEndPoint)probe.LocalEndPoint!).Address;
    }

    private static string? Text(JsonElement message, string name) =>
        message.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
