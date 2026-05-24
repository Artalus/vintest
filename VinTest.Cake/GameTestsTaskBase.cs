using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Cake.Common.Diagnostics;
using Cake.Common.IO;
using Cake.Common.Tools.DotNet;
using Cake.Common.Tools.DotNet.Build;
using Cake.Core;
using Cake.Core.Diagnostics;
using Cake.Frosting;
using Newtonsoft.Json;

namespace VinTest.Cake;

/// <summary>
/// Base Cake task that launches VintageStory, waits for test results, and reports them.
/// Derive from this in your mod's CakeBuild project.
/// </summary>
public abstract class GameTestsTaskBase<TContext> : FrostingTask<TContext>
    where TContext : ContextBase
{
    // --- Default patterns ---
    private static readonly string[] DefaultLogErrors = ["[Error]"];
    private static readonly string[] DefaultLogWarnings = ["[Warning]", "not found. Hint:"];
    private static readonly string[] DefaultLogCapture = ["[VinTest]"];

    // --- Extension points ---

    /// <summary>
    /// Lines containing these substrings will be highlighted in red in the filtered log,
    /// and will cause the task to fail, unless <see cref="ContextBase.IgnoreLogErrors"/> is set,
    /// or demoted via <see cref="LogSuppressions"/>.
    ///
    /// Joined with <see cref="DefaultLogErrors"/>: <c>"[Error]"</c>.
    ///
    /// Override to customize.
    /// </summary>
    protected virtual string[] AdditionalLogErrors => [];

    /// <summary>
    /// Lines containing these substrings will be highlighted in yellow in the filtered log.
    ///
    /// Joined with <see cref="DefaultLogWarnings"/>: <c>"[Warning]", "not found. Hint:"</c>.
    ///
    /// Can be demoted or promoted via <see cref="LogSuppressions"/>.
    ///
    /// Override to customize.
    /// </summary>
    protected virtual string[] AdditionalLogWarnings => [];

    /// <summary>
    /// Lines containing these substrings will be printed in the filtered log.
    ///
    /// Joined with <see cref="DefaultLogCapture"/>: <c>"[VinTest]"</c>.
    ///
    /// Can be demoted or promoted via <see cref="LogSuppressions"/>.
    ///
    /// Override to customize.
    /// </summary>
    protected virtual string[] AdditionalLogCapture => [];

    /// <summary>
    /// Change level of specific log lines, pattern-matched after primary classification.
    /// Each entry is a <c>(RegexPattern, Level?)</c> pair.
    ///
    /// If <c>Level == null</c> - ignore the line entirely (not captured).
    ///
    /// If <c>Level != null</c> - override the classified level (e.g. demote Error -> Warning).
    ///
    /// Lines that remain/become Error-level after suppression will cause the task to fail.
    ///
    /// Override to customize.
    /// </summary>
    protected virtual IEnumerable<(string Pattern, LogLevel? TargetLevel)> LogSuppressions => [];

    /// <summary>
    /// Absolute paths to mod directories to pass to --addModPath when launching VS.
    ///
    /// Override to customize.
    /// </summary>
    protected virtual IEnumerable<string> GetModBinaryPaths(TContext context) =>
        [
            Path.GetFullPath($"../{context.ProjectName}/bin/{context.BuildConfiguration}/Mods"),
            Path.GetFullPath(
                $"../{context.AutotestsProjectName}/bin/{context.BuildConfiguration}/Mods"
            ),
        ];

    /// <summary>
    /// Absolute paths to asset directories to pass to --addOrigin when launching VS.
    /// </summary>
    protected virtual IEnumerable<string> GetAssetsPaths(TContext context) =>
        [
            // from VintageStory.Mod.BasicTemplate
            Path.GetFullPath($"../{context.ProjectName}/assets"),
        ];

    /// <summary>
    /// Called during <see cref="Run(TContext)"/>, after generic Cleanup().
    /// Create mod-specific config files here.
    ///
    /// Override to customize.
    /// </summary>
    protected virtual void Prepare(TContext context) { }

    /// <summary>
    /// Called during <see cref="Run(TContext)"/>, after <see cref="Prepare(TContext)"/>.
    /// Build (or rebuild) whatever is needed before VS is launched.
    ///
    /// Default implementation builds <see cref="ContextBase.AutotestsProjectName"/> (which
    /// should pull in core mod project transitively via ProjectReference in <c>.csproj</c>).
    ///
    /// Override to customize.
    ///
    /// NOTE: this *OMITS* rebuilding cake orchestrator project: its executable would be locked
    /// and cause MsBuild to fail, since the executable is already driving the build.
    /// This should not be a problem for <c>dotnet run</c> since it rebuilds cake automatically,
    /// but it *WILL* mess things up if you run <c>CakeBuild.exe</c> manually.
    /// </summary>
    protected virtual void Build(TContext context)
    {
        // TODO: this relies on autotests project dir being a sibling of cake project dir
        // AutotestProject should point to the .csproj file instead of just the name
        context.DotNetBuild(
            $"../{context.AutotestsProjectName}/{context.AutotestsProjectName}.csproj",
            new DotNetBuildSettings { Configuration = context.BuildConfiguration }
        );
    }

    // --- Computed combiners (private) ---

    private string[] AllLogErrors => [.. DefaultLogErrors, .. AdditionalLogErrors];
    private string[] AllLogWarnings => [.. DefaultLogWarnings, .. AdditionalLogWarnings];

    private string[] AllLogCapture => [.. DefaultLogCapture, .. AdditionalLogCapture];

    private List<(Regex Regex, LogLevel? TargetLevel)> CompileSuppressions() =>
        [
            .. LogSuppressions.Select(s =>
                (
                    new Regex(s.Pattern, RegexOptions.Compiled | RegexOptions.IgnoreCase),
                    s.TargetLevel
                )
            ),
        ];

    // --- Entry point ---

    /// <summary>
    /// Entry point for the gametests task, driving the entire process.
    /// Cleanup(), <see cref="Prepare(TContext)"/>, <see cref="Build(TContext)"/>, Launch(), Wait(), Print().
    /// Will be called by Cake internals.
    /// </summary>
    public sealed override void Run(TContext context)
    {
        Cleanup(context);
        WriteVintestConfig(context);
        Prepare(context);
        Build(context);
        var proc = LaunchVintageStory(
            context,
            context.VsExePath,
            GetModBinaryPaths(context),
            GetAssetsPaths(context)
        );
        if (context.ManualMode)
        {
            context.Information("Manual mode: waiting for VintageStory to exit...");
            proc.WaitForExit();
            return;
        }
        var result = WaitForResults(proc, context.TestResultsPath, context.TestRunTimeoutSeconds);
        var logsDir = Path.Combine(context.DataPath, "Logs");
        var badLines = ScanLogs(logsDir, context.Log);
        PrintResults(context, result, badLines, context.IgnoreLogErrors);
    }

    /// <summary>
    /// Performs cleanup after <see cref="Run(TContext)"/> finishes, even if it fails.
    /// Will be called by Cake internals.
    /// If you override this, make sure to call the base method first.
    /// </summary>
    public override void Finally(TContext context)
    {
        // cleanup file upon cake exit
        if (File.Exists(context.PidFilePath))
            File.Delete(context.PidFilePath);
    }

    // --- Implementation (in call order) ---

    private void Cleanup(TContext context)
    {
        foreach (var modDir in GetModBinaryPaths(context))
        {
            if (context.DirectoryExists(modDir))
                context.DeleteDirectory(
                    modDir,
                    new DeleteDirectorySettings { Recursive = true, Force = true }
                );
        }

        var logsDir = Path.Combine(context.DataPath, "Logs");
        context.EnsureDirectoryExists(logsDir);
        context.DeleteFiles($"{logsDir}/*");

        var savesDir = Path.Combine(context.DataPath, "Saves");
        context.EnsureDirectoryExists(savesDir);
        var origSave = Path.Combine(savesDir, $"{context.TestWorldName}.vcdbs.orig");
        var targetSave = Path.Combine(savesDir, $"{context.TestWorldName}.vcdbs");
        if (File.Exists(origSave))
        {
            File.Copy(origSave, targetSave, overwrite: true);
            var wal = targetSave + "-wal";
            var shm = targetSave + "-shm";
            if (File.Exists(wal))
                File.Delete(wal);
            if (File.Exists(shm))
                File.Delete(shm);
        }

        foreach (var file in new[] { context.TestResultsPath, context.PidFilePath })
            if (File.Exists(file))
                File.Delete(file);
    }

    private static void WriteVintestConfig(TContext context)
    {
        var configDir = Path.Combine(context.DataPath, "ModConfig");
        Directory.CreateDirectory(configDir);
        // dump even empty config, so old one does not interfere when no filter is provided
        var config = new Dictionary<string, object>();
        if (context.ManualMode)
            config["ManualMode"] = true;
        if (!string.IsNullOrEmpty(context.TestCaseFilter))
            config["TestCaseFilter"] = context.TestCaseFilter;
        var json = JsonConvert.SerializeObject(config);
        File.WriteAllText(Path.Combine(configDir, "vintestconfig.json"), json);
    }

    private static Process LaunchVintageStory(
        TContext context,
        string vsExe,
        IEnumerable<string> modPaths,
        IEnumerable<string> assetsPaths
    )
    {
        if (!File.Exists(vsExe))
            throw new CakeException($"Vintage Story executable does not exist: {vsExe}");
        if (!modPaths.Any())
            throw new CakeException("No valid mod paths provided");
        var mods = ValidatePaths(modPaths, "MOD");
        var dataPath = context.DataPath.TrimEnd('\\');
        List<string> arguments =
        [
            "--tracelog",
            "--addModPath",
            string.Join(" ", mods),
            "--dataPath",
            $"\"{dataPath}\"",
            "--openWorld",
            $"\"{context.TestWorldName}\"",
        ];
        var assets = ValidatePaths(assetsPaths, "ASSETS");
        if (assets.Any())
        {
            arguments.Add("--addOrigin");
            arguments.Add(string.Join(" ", assets));
        }

        var psi = new ProcessStartInfo(vsExe) { Arguments = string.Join(" ", arguments) };
        context.Information($"Launching VintageStory with command: {psi.FileName} {psi.Arguments}");
        var proc = Process.Start(psi)!;

        // if something goes horribly wrong with VS, it usually does so immediately
        proc.WaitForExit(2000);
        if (proc.HasExited)
            throw new CakeException($"VS exited immediately with code {proc.ExitCode}");

        // Write PID so the VS Code extension can attach a debugger.
        Directory.CreateDirectory(Path.GetDirectoryName(context.PidFilePath)!);
        File.WriteAllText(context.PidFilePath, proc.Id.ToString());

        return proc;
    }

    private static IEnumerable<string> ValidatePaths(IEnumerable<string> paths, string kind)
    {
        return paths
            // missing path will cause VS to crash, so fail faster and cleaner
            .Where(p =>
                Directory.Exists(p)
                    ? true
                    : throw new CakeException($"{kind} directory '{p}' not found")
            )
            // if user provides path ending with \ and then we append " to it, VS own parser will
            // consider it an escaped quote and fail in quite a confusing way
            .Select(p => p.TrimEnd('\\'))
            // quote paths in case of spaces
            .Select(p => $"\"{p}\"");
    }

    private static TestRunInfo WaitForResults(Process proc, string resultsPath, int timeoutSeconds)
    {
        // timeoutSeconds == 0 means no deadline (e.g. when a debugger is attached)
        proc.WaitForExit(timeoutSeconds > 0 ? timeoutSeconds * 1000 : -1);
        if (!proc.HasExited)
        {
            proc.Kill();
            proc.WaitForExit(1000);
        }

        if (!File.Exists(resultsPath))
            throw new CakeException("VS exited without producing results JSON");

        return JsonConvert.DeserializeObject<TestRunInfo>(File.ReadAllText(resultsPath))!;
    }

    /// <summary>
    /// Pass over all log files, capturing interesting output.
    /// Returns number of bad lines found.
    /// </summary>
    private int ScanLogs(string logsDir, ICakeLog log)
    {
        if (!Directory.Exists(logsDir))
            return 0;

        int badLines = 0;
        var entries = new List<(DateTime Ts, string Line, LogLevel Level)>();
        var suppressions = CompileSuppressions();

        foreach (var logFile in Directory.GetFiles(logsDir, "*.log"))
        {
            // cannot simply File.ReadLines() when running from vscode extension
            using var fs = new FileStream(
                logFile,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite
            );
            using var reader = new StreamReader(fs);
            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                var ts = TryParseLogTimestamp(line) ?? DateTime.MinValue;

                LogLevel? level = DetermineLineLogLevel(line);
                if (level == null)
                    continue;
                foreach (var (regex, targetLevel) in suppressions)
                {
                    if (regex.IsMatch(line))
                    {
                        level = targetLevel; // null = ignore
                        break;
                    }
                }
                if (level == null)
                    continue;

                if (level == LogLevel.Error)
                    badLines++;

                entries.Add((ts, TrimDateFromLine(line), level.Value));
            }
        }

        if (entries.Count > 0)
        {
            log.Write(Verbosity.Normal, LogLevel.Information, "--- Filtered log ---");
            foreach (var (_, line, level) in entries.OrderBy(e => e.Ts))
                log.Write(Verbosity.Normal, level, line);
            log.Write(Verbosity.Normal, LogLevel.Information, "--- End of filtered log ---");
        }

        return badLines;
    }

    private LogLevel? DetermineLineLogLevel(string line)
    {
        foreach (var pattern in AllLogErrors)
            if (line.Contains(pattern, StringComparison.OrdinalIgnoreCase))
                return LogLevel.Error;

        foreach (var pattern in AllLogWarnings)
            if (line.Contains(pattern, StringComparison.OrdinalIgnoreCase))
                return LogLevel.Warning;

        foreach (var marker in AllLogCapture)
            if (line.Contains(marker, StringComparison.OrdinalIgnoreCase))
                return LogLevel.Verbose;

        return null;
    }

    // VS log timestamp format: D.M.YYYY HH:MM:SS  (e.g. "4.5.2026 11:02:33")
    private static readonly Regex LogTimestampRegex = new(
        @"^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}:\d{2}:\d{2})",
        RegexOptions.Compiled
    );

    private static string TrimDateFromLine(string line)
    {
        var m = LogTimestampRegex.Match(line);
        return m.Success ? line[m.Groups[4].Index..] : line;
    }

    private static DateTime? TryParseLogTimestamp(string line)
    {
        var m = LogTimestampRegex.Match(line);
        if (!m.Success)
            // TODO: *can* VS log contain unparsable timestamps even?... for multiline logs maybe...
            return null;
        if (
            DateTime.TryParseExact(
                $"{m.Groups[3].Value}-{int.Parse(m.Groups[2].Value):D2}-{int.Parse(m.Groups[1].Value):D2} {m.Groups[4].Value}",
                "yyyy-MM-dd H:mm:ss",
                null,
                System.Globalization.DateTimeStyles.None,
                out var dt
            )
        )
            return dt;
        return null;
    }

    private static void PrintResults(
        TContext context,
        TestRunInfo result,
        int badLines,
        bool ignoreLogErrors
    )
    {
        foreach (var suite in result.Suites)
        {
            foreach (var tc in suite.TestCases)
            {
                context.Log.Write(
                    Verbosity.Normal,
                    tc.Passed ? LogLevel.Information : LogLevel.Error,
                    $"  [{(tc.Passed ? "PASS" : "FAIL")}] {suite.SuiteName}.{tc.Name} ({tc.DurationMs:F0}ms)"
                );

                if (tc.Passed)
                    continue;

                foreach (var a in tc.Assertions)
                {
                    context.Log.Write(
                        Verbosity.Normal,
                        a.Passed ? LogLevel.Information : LogLevel.Error,
                        $"    {(a.Passed ? "..." : "-->")} {a.Name}"
                    );
                    if (a.Passed)
                        continue;

                    if (tc.ExceptionMessage == null)
                        context.Log.Write(
                            Verbosity.Normal,
                            LogLevel.Verbose,
                            $"      in {a.Location}"
                        );
                }
                if (tc.ExceptionMessage != null)
                {
                    var exLines = tc.ExceptionMessage.Split('\n');
                    context.Log.Write(
                        Verbosity.Normal,
                        LogLevel.Information,
                        $"    !!! {exLines[0]}"
                    );
                    foreach (var exLine in exLines.Skip(1))
                        context.Log.Write(
                            Verbosity.Normal,
                            LogLevel.Verbose,
                            $"      {exLine.TrimStart()}"
                        );
                }
            }
        }

        var errors = new List<string>();
        if (!result.Passed)
            errors.Add("Integration tests FAILED");
        if (badLines > 0 && !ignoreLogErrors)
            errors.Add($"{badLines} log issue(s) found - see above for details");
        if (errors.Count > 0)
            throw new CakeException(string.Join("\n", errors));
    }

    // --- Result DTOs ---
    // they kinda duplicate VinTest.Runner's Test***Result, but unifying would cause weird project deps

    private class TestRunInfo
    {
        public bool Passed { get; set; }
        public List<TestSuiteInfo> Suites { get; set; } = [];
    }

    private class TestSuiteInfo
    {
        public required string SuiteName { get; set; }
        public List<TestCaseInfo> TestCases { get; set; } = [];
    }

    private class TestCaseInfo
    {
        public required string Name { get; set; }
        public bool Passed { get; set; }
        public double DurationMs { get; set; }
        public string? ExceptionMessage { get; set; }
        public List<AssertionInfo> Assertions { get; set; } = [];
    }

    private class AssertionInfo
    {
        public required string Name { get; set; }
        public bool Passed { get; set; }
        public required string Location { get; set; }
    }
}
