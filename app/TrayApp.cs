using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Platform;
using Avalonia.Threading;
using CueSign.Server;

namespace CueSign.App;

/// <summary>The whole desktop presence of CueSign: one tray icon and its menu. There are no windows.</summary>
public sealed class TrayApp : Application
{
    public static CueSignServer Server { get; set; } = null!;
    public static bool OpenOnStart { get; set; }

    private static readonly TimeSpan QuitConfirmWindow = TimeSpan.FromSeconds(8);

    private TrayIcon _tray = null!;
    private WindowIcon _idleIcon = null!;
    private WindowIcon _activeIcon = null!;
    private readonly NativeMenuItem _players = new() { IsEnabled = false };
    private readonly NativeMenuItem _address = new() { IsEnabled = false };
    private readonly NativeMenuItem _startAtLogin = new("Start at Login") { ToggleType = MenuItemToggleType.CheckBox };
    private readonly NativeMenuItem _quit = new("Quit CueSign");

    private bool _showingActive;
    private int _refreshQueued;
    private DateTime _quitArmedAt = DateTime.MinValue;

    private static string ControlUrl => $"http://localhost:{Server.Port}";

    public override void OnFrameworkInitializationCompleted()
    {
        // macOS tints a black "template" glyph itself. Windows has no such thing, and a black
        // glyph would vanish on a dark taskbar, so it gets the coloured app icon instead.
        var mac = OperatingSystem.IsMacOS();
        _idleIcon = LoadIcon(mac ? "tray-idle.png" : "CueSign.png");
        _activeIcon = mac ? LoadIcon("tray-active.png") : _idleIcon;

        var open = new NativeMenuItem("Open CueSign");
        open.Click += (_, _) => Shell.Open(ControlUrl);
        var dataFolder = new NativeMenuItem("Show Data Folder");
        dataFolder.Click += (_, _) => Shell.Open(Server.DataDir);
        _startAtLogin.Click += (_, _) =>
        {
            LoginItem.Set(!LoginItem.IsEnabled);
            Refresh();
        };
        _quit.Click += (_, _) => Quit();

        var menu = new NativeMenu();
        menu.Items.Add(_players);
        menu.Items.Add(_address);
        menu.Items.Add(new NativeMenuItemSeparator());
        menu.Items.Add(open);
        menu.Items.Add(dataFolder);
        menu.Items.Add(_startAtLogin);
        menu.Items.Add(new NativeMenuItemSeparator());
        menu.Items.Add(_quit);
        menu.Opening += (_, _) => Refresh();

        _tray = new TrayIcon { Icon = _idleIcon, ToolTipText = "CueSign", Menu = menu, IsVisible = true };
        MacOSProperties.SetIsTemplateIcon(_tray, true);
        _tray.Clicked += (_, _) => Shell.Open(ControlUrl); // Windows: a plain click opens the UI
        TrayIcon.SetIcons(this, [_tray]);

        // Players report in every couple of seconds, so changes arrive in bursts from server
        // threads. Collapse them into one refresh on the UI thread.
        Server.Show.Changed += () =>
        {
            if (Interlocked.Exchange(ref _refreshQueued, 1) == 0)
                Dispatcher.UIThread.Post(() =>
                {
                    Interlocked.Exchange(ref _refreshQueued, 0);
                    Refresh();
                });
        };

        // The server also stops by itself on a termination signal (logout, shutdown, "kill").
        // Without this the icon would stay in the menu bar with nothing behind it.
        Server.App.Lifetime.ApplicationStopping.Register(() => Dispatcher.UIThread.Post(() =>
        {
            _tray.IsVisible = false;
            (ApplicationLifetime as IClassicDesktopStyleApplicationLifetime)?.Shutdown();
        }));

        Refresh();
        if (OpenOnStart) Shell.Open(ControlUrl);
        base.OnFrameworkInitializationCompleted();
    }

    private void Refresh()
    {
        var (online, total) = Server.Show.PlayerCounts();
        _players.Header = total == 0 ? "No players paired yet" : $"{online} of {total} player{(total == 1 ? "" : "s")} online";

        var address = ServerHost.LanAddresses().FirstOrDefault();
        _address.Header = address is null ? "Not connected to a network" : $"On the network: http://{address}:{Server.Port}";

        _startAtLogin.IsChecked = LoginItem.IsEnabled;
        _tray.ToolTipText = total == 0 ? "CueSign" : $"CueSign: {online} of {total} online";

        if (DateTime.UtcNow - _quitArmedAt > QuitConfirmWindow) _quit.Header = "Quit CueSign";

        var active = online > 0;
        if (active != _showingActive)
        {
            _showingActive = active;
            _tray.Icon = active ? _activeIcon : _idleIcon;
        }
    }

    /// <summary>
    /// Quitting stops the show for every connected player, so with players online the first
    /// click only arms the menu item and the second one, within a few seconds, quits.
    /// </summary>
    private void Quit()
    {
        var (online, _) = Server.Show.PlayerCounts();
        if (online > 0 && DateTime.UtcNow - _quitArmedAt > QuitConfirmWindow)
        {
            _quitArmedAt = DateTime.UtcNow;
            _quit.Header = $"{online} player{(online == 1 ? " is" : "s are")} connected. Click again to quit";
            return;
        }

        _tray.IsVisible = false;
        (ApplicationLifetime as IClassicDesktopStyleApplicationLifetime)?.Shutdown();
    }

    private static WindowIcon LoadIcon(string name)
    {
        using var stream = AssetLoader.Open(new Uri($"avares://CueSign/Assets/{name}"));
        return new WindowIcon(stream);
    }
}
