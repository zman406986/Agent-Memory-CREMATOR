// pwsh-guard: a pwsh wrapper that refuses commands naming paths outside the
// workspace before pwsh runs them. Built by build.mjs; configured by
// pwsh-guard.ini beside the exe.
//
// Why: dsh's Windows sandbox confines writes only (dsh-sandbox-windows-acl
// README: reads are not restricted), so the shell could read any caller-
// readable file. The runner's `--workspace-only` audit noticed those calls
// only after the run and failed it. This guard refuses them in the call
// itself, so the agent keeps running and the workspace boundary holds.
//
// Scope and limits, stated plainly: this is a command-text check, not a kernel
// boundary. It sees absolute drive paths and `..`-relative tokens after
// tracking simple `Set-Location`/`cd` segments; UNC paths and a path built at
// run time from variables (`$p = 'C:' + '\Users'; ...`) are invisible here.
// The session audit is still the second check for the answer files.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

internal static class PwshGuard
{
    private const string Marker = "[workspace-guard] refused: outside the workspace: ";
    private const string ConfigName = "pwsh-guard.ini";

    private sealed class Config
    {
        public string RealPwsh = "";
        public readonly List<string> AllowRoots = new List<string>();
    }

    private static int Main(string[] args)
    {
        try
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            Config cfg = LoadConfig(Path.Combine(baseDir, ConfigName));
            string command = CommandText(args);
            if (command == null)
            {
                // No -Command text: nothing to inspect. Pass through.
                return Spawn(cfg, args);
            }

            string workspace = Directory.GetCurrentDirectory();
            List<string> roots = new List<string>();
            AddRoot(roots, workspace);
            foreach (string r in cfg.AllowRoots) AddRoot(roots, r);

            string denial = FirstOutsidePath(command, workspace, roots);
            if (denial != null)
            {
                Console.Error.WriteLine(Marker + denial);
                return 126;
            }
            return Spawn(cfg, args);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[workspace-guard] failed: " + error.Message);
            return 125;
        }
    }

    private static string CommandText(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (string.Equals(a, "-Command", StringComparison.OrdinalIgnoreCase)
                || string.Equals(a, "-c", StringComparison.OrdinalIgnoreCase))
            {
                return i + 1 < args.Length ? args[i + 1] : "";
            }
            if (a.StartsWith("-Command:", StringComparison.OrdinalIgnoreCase))
            {
                return a.Substring("-Command:".Length);
            }
        }
        return null;
    }

    private static Config LoadConfig(string file)
    {
        Config cfg = new Config();
        if (File.Exists(file))
        {
            foreach (string raw in File.ReadAllLines(file))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string key = line.Substring(0, eq).Trim().ToLowerInvariant();
                string value = line.Substring(eq + 1).Trim().Trim('"');
                if (key == "realpwsh") cfg.RealPwsh = value;
                else if (key == "allowroot") cfg.AllowRoots.Add(value);
            }
        }
        if (cfg.RealPwsh.Length == 0)
        {
            string[] candidates =
            {
                @"C:\Program Files\PowerShell\7\pwsh.exe",
                @"C:\Program Files\PowerShell\6\pwsh.exe",
                @"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            };
            foreach (string c in candidates)
            {
                if (File.Exists(c)) { cfg.RealPwsh = c; break; }
            }
        }
        if (cfg.RealPwsh.Length == 0)
            throw new InvalidOperationException("no real pwsh found; write realPwsh= into " + ConfigName);
        return cfg;
    }

    private static int Spawn(Config cfg, string[] args)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = cfg.RealPwsh;
        psi.Arguments = JoinArgs(args);
        psi.UseShellExecute = false;
        psi.WorkingDirectory = Directory.GetCurrentDirectory();
        using (Process child = Process.Start(psi))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }

    // ── Path inspection ─────────────────────────────────────────────────────

    private static readonly Regex SetLocation = new Regex(
        @"^(?:Set-Location|cd|chdir|sl)\s+(?<p>[^\s;|&]+)$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly Regex AbsoluteToken = new Regex(
        @"(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s""'`|&;,)]*",
        RegexOptions.CultureInvariant);

    // No UNC rule: a UNC token (`\\server\share`) cannot be told apart from a
    // code payload's `\\F\\b` escape sequence. The bench is local-only and the
    // machine exposes no share the tasks use, so the false positive costs more
    // than the rule buys. An absolute drive path is still caught.

    private static readonly Regex ParentToken = new Regex(
        @"(?<![\w.-])(?:\.\.[\\/])+[^\s""'`|&;,)]*",
        RegexOptions.CultureInvariant);

    /// Returns the first offending token, or null when every named path stays
    /// under an allowed root. Tracks simple `Set-Location` segments so
    /// `../..` is judged against the cwd the command itself created.
    private static string FirstOutsidePath(string command, string workspace, List<string> roots)
    {
        string cwd = workspace;
        string[] segments = command.Split(new char[] { ';', '\n', '\r' });
        foreach (string raw in segments)
        {
            string segment = raw.Trim();
            if (segment.Length == 0) continue;

            Match cd = SetLocation.Match(segment);
            if (cd.Success)
            {
                string target = cd.Groups["p"].Value.Trim('"', '\'');
                if (!target.StartsWith("$") && !target.Contains("("))
                {
                    string resolved = SafeFullPath(cwd, target);
                    if (resolved != null && !InsideAny(resolved, roots))
                        return target;
                    cwd = resolved ?? cwd;
                }
                continue;
            }

            Match absolute = AbsoluteToken.Match(segment);
            if (absolute.Success && !InsideAny(SafeFullPath(cwd, absolute.Value) ?? absolute.Value, roots))
                return absolute.Value;
            foreach (Match m in ParentToken.Matches(segment))
            {
                string resolved = SafeFullPath(cwd, m.Value);
                if (resolved != null && !InsideAny(resolved, roots)) return m.Value;
            }
        }
        return null;
    }

    private static string SafeFullPath(string cwd, string path)
    {
        try
        {
            string normalized = path.Replace('/', Path.DirectorySeparatorChar);
            return Path.GetFullPath(Path.Combine(cwd, normalized));
        }
        catch
        {
            return null;
        }
    }

    private static void AddRoot(List<string> roots, string root)
    {
        if (string.IsNullOrEmpty(root)) return;
        string full = SafeFullPath(Directory.GetCurrentDirectory(), root);
        if (full != null) roots.Add(full.TrimEnd(Path.DirectorySeparatorChar));
    }

    private static bool InsideAny(string path, List<string> roots)
    {
        string full;
        try { full = Path.GetFullPath(path); }
        catch { return false; }
        full = full.TrimEnd(Path.DirectorySeparatorChar);
        foreach (string root in roots)
        {
            if (full.Equals(root, StringComparison.OrdinalIgnoreCase)) return true;
            if (full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    // ── argv rebuild (Windows quoting) ──────────────────────────────────────

    private static string JoinArgs(string[] args)
    {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < args.Length; i++)
        {
            if (i > 0) sb.Append(' ');
            sb.Append(Quote(args[i]));
        }
        return sb.ToString();
    }

    private static string Quote(string arg)
    {
        if (arg.Length == 0) return "\"\"";
        bool needs = false;
        foreach (char c in arg)
        {
            if (c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '"') { needs = true; break; }
        }
        if (!needs) return arg;
        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
                continue;
            }
            if (backslashes > 0) { sb.Append('\\', backslashes); backslashes = 0; }
            sb.Append(c);
        }
        if (backslashes > 0) sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }
}
