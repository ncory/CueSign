using System.Security;

namespace CueSign.App;

/// <summary>
/// Makes CueSign start when the user logs in: a per-user LaunchAgent on macOS, a per-user
/// Run entry in the registry on Windows. Neither needs administrator rights.
/// </summary>
internal static class LoginItem
{
    private const string Label = "com.cuesign.app";
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    private static string AgentPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "LaunchAgents", Label + ".plist");

    public static bool IsEnabled
    {
        get
        {
            if (OperatingSystem.IsMacOS()) return File.Exists(AgentPath);
            if (OperatingSystem.IsWindows())
            {
                using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey);
                return key?.GetValue("CueSign") is not null;
            }
            return false;
        }
    }

    public static void Set(bool enabled)
    {
        if (Environment.ProcessPath is not { } executable) return;
        try
        {
            if (OperatingSystem.IsMacOS()) SetMac(enabled, executable);
            else if (OperatingSystem.IsWindows()) SetWindows(enabled, executable);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or SecurityException)
        {
            // The menu item re-reads the real state, so a failure simply shows as still unticked.
        }
    }

    private static void SetMac(bool enabled, string executable)
    {
        if (!enabled)
        {
            File.Delete(AgentPath);
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(AgentPath)!);
        File.WriteAllText(AgentPath, $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
                <key>Label</key>
                <string>{Label}</string>
                <key>ProgramArguments</key>
                <array>
                    <string>{SecurityElement.Escape(executable)}</string>
                    <string>--background</string>
                </array>
                <key>RunAtLoad</key>
                <true/>
            </dict>
            </plist>

            """);
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static void SetWindows(bool enabled, string executable)
    {
        using var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunKey);
        if (enabled) key.SetValue("CueSign", $"\"{executable}\" --background");
        else key.DeleteValue("CueSign", throwOnMissingValue: false);
    }
}
