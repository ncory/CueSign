using Avalonia;
using Avalonia.Controls;
using CueSign.Server;

namespace CueSign.App;

internal static class Program
{
    /// <summary>
    /// Starts the CueSign server, then sits in the menu bar (macOS) or notification area
    /// (Windows) until the user quits. Accepts the server's own options (--port, --data,
    /// --player-updates) plus --background, which skips opening the browser; the
    /// start-at-login entry uses it.
    /// </summary>
    [STAThread]
    public static int Main(string[] args)
    {
        var background = args.Contains("--background");
        var server = ServerHost.Build([.. args.Where(a => a != "--background")], AppPaths.DataDir);

        try
        {
            server.App.StartAsync().GetAwaiter().GetResult();
        }
        catch (IOException)
        {
            // The port is taken, almost certainly by a copy that is already running: show that one.
            Shell.Open($"http://localhost:{server.Port}");
            return 1;
        }

        TrayApp.Server = server;
        TrayApp.OpenOnStart = !background;
        var exitCode = AppBuilder.Configure<TrayApp>()
            .UsePlatformDetect()
            .With(new MacOSPlatformOptions { ShowInDock = false })
            .StartWithClassicDesktopLifetime(args, ShutdownMode.OnExplicitShutdown);

        // On a pool thread: this thread still carries Avalonia's synchronization context, whose
        // message loop has ended, so anything awaited here directly would never resume.
        Task.Run(() => server.App.StopAsync(TimeSpan.FromSeconds(3))).GetAwaiter().GetResult();
        return exitCode;
    }
}

internal static class AppPaths
{
    /// <summary>~/Library/Application Support/CueSign on macOS, %AppData%\CueSign on Windows.</summary>
    public static string DataDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "CueSign");
}

internal static class Shell
{
    /// <summary>Opens a URL in the default browser, or a folder in Finder / Explorer.</summary>
    public static void Open(string target)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(target) { UseShellExecute = true });
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException or FileNotFoundException)
        {
            // Nothing useful to do from a tray app with no window.
        }
    }
}
