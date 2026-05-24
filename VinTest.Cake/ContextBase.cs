using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Xml.Linq;
using Cake.Common;
using Cake.Core;
using Cake.Core.Diagnostics;
using Cake.Frosting;

namespace VinTest.Cake;

/// <summary>
/// FrostingContext substitute that provides common arguments for running VS integration tests.
/// Inherit from this in your mod's BuildContext and supply the remaining project-specific properties.
/// </summary>
public abstract class ContextBase : FrostingContext
{
    /// <summary>
    /// Name of your core mod's project (WITHOUT <c>.csproj</c> extension)
    /// You must define it in your BuildContext class.
    /// </summary>
    public abstract string ProjectName { get; }

    /// <summary>
    /// Name of the test mod project (WITHOUT <c>.csproj</c> extension).
    /// You can redefine it in your BuildContext class if you use different naming convention.
    /// </summary>
    public virtual string AutotestsProjectName => $"{ProjectName}.gametests";

    /// <summary>
    /// [ARG] Dotnet configuration (Debug/Release) to build the solution in.
    /// </summary>
    public string BuildConfiguration { get; }

    /// <summary>
    /// [ARG] Absolute path to the VintageStory installation directory.
    /// </summary>
    public string VsPath { get; }

    /// <summary>
    /// [ARG] Name of the world save to load for tests.
    /// </summary>
    public string TestWorldName { get; }

    /// <summary>
    /// [ARG] Maximum seconds to wait for all tests to finish before timing out.
    /// </summary>
    public int TestRunTimeoutSeconds { get; }

    /// <summary>
    /// [ARG] Absolute path to the VS data directory (containing Saves/, Logs/, etc.).
    /// </summary>
    public string DataPath { get; }

    /// <summary>
    /// [ARG] If set, log lines matching error patterns are captured but do not fail the build.
    /// </summary>
    public bool IgnoreLogErrors { get; }

    /// <summary>
    /// [ARG] When set, launches VS without running tests automatically.
    /// Cake will wait for VS to exit without checking for test results.
    /// </summary>
    public bool ManualMode { get; }

    /// <summary>
    /// [ARG] Case-insensitive substring filter applied to <c>SuiteName.CaseName</c>.
    /// Leave empty to run all tests.
    /// When non-empty, only matching tests are executed.
    /// </summary>
    public string TestCaseFilter { get; }

    /// <summary>
    /// Directory under the VS data path where VinTest will store its files.
    /// Shared with VinTest.Runner.
    /// </summary>
    public const string TestResultsDirName = "TestResults";

    /// <summary>
    /// Path to the JSON file where test results are written by the test runner.
    /// </summary>
    public string TestResultsPath => Path.Combine(DataPath, TestResultsDirName, "results.json");

    /// <summary>
    /// Path to the PID file written by cake task once VintageStory is launched.
    /// </summary>
    public string PidFilePath => Path.Combine(DataPath, TestResultsDirName, "vs.pid");

    /// <summary>
    /// Absolute path to VS executable (Vintagestory.exe on Windows, Vintagestory on Linux).
    /// </summary>
    public string VsExePath =>
        Path.Combine(
            VsPath,
            RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                ? "Vintagestory.exe"
                : "Vintagestory"
        );

    /// <inheritdoc/>
    protected ContextBase(ICakeContext context)
        : base(context)
    {
        var vspathCandidate = context.Argument("vs-path", "");
        if (string.IsNullOrEmpty(vspathCandidate))
        {
            Log.Information("* --vs-path argument not provided; trying .props");
            vspathCandidate = ReadVsPathFromProps();
        }
        if (string.IsNullOrEmpty(vspathCandidate))
        {
            if (vspathCandidate == null)
                Log.Information("* Directory.Build.props not available; trying env");
            else
                Log.Information("* Directory.Build.props has no valid path; trying env");
            vspathCandidate = ReadVsPathFromEnv();
        }
        if (string.IsNullOrEmpty(vspathCandidate))
            throw new CakeException(
                "Vintage Story path not provided."
                    + " Use --vs-path, or add <VINTAGE_STORY> property to Directory.Build.props,"
                    + " or set VINTAGE_STORY environment variable."
            );
        VsPath = Path.GetFullPath(vspathCandidate);

        // Check if VintagestoryAPI.dll exists
        string dllPath = Path.Combine(VsPath, "VintagestoryAPI.dll");
        if (!File.Exists(dllPath))
            throw new CakeException(
                $"{VsPath} does not look like a valid Vintage Story installation"
                    + " (missing VintagestoryAPI.dll)."
            );

        if (!File.Exists(VsExePath))
        {
            Log.Warning(
                $"WARNING: Vintage Story executable '{VsExePath}' not found."
                    + "\nCake Will not be able to run tests!"
            );
            Log.Information("This is OK in CI environments building against a vs_server.tar.gz");
        }
        DataPath = Path.GetFullPath(context.Argument("data-path", "../gamedata"));
        TestWorldName = context.Argument("test-world", "autotest");
        TestRunTimeoutSeconds = context.Argument("test-timeout", 300);
        BuildConfiguration = context.Argument("configuration", "Release");
        IgnoreLogErrors = context.Argument("ignore-log-errors", false);
        ManualMode = context.Argument("manual-mode", false);
        TestCaseFilter = context.Argument("test-filter", "");

        // delete as soon as possible to minimize chance of extension reading stale PID
        if (File.Exists(PidFilePath))
            File.Delete(PidFilePath);
    }

    private string? ReadVsPathFromProps()
    {
        // Cwd = "this project dir", even if `dotnet run --project cake` happens at workspace root.
        // Since cake project lives in subdirectory, props file should be one level up from cwd.
        var propsFile = Path.GetFullPath(
            Path.Combine(Directory.GetCurrentDirectory(), "..", "Directory.Build.props")
        );
        if (!File.Exists(propsFile))
            return null;
        var doc = XDocument.Load(propsFile);
        var value = doc.Descendants()
            .FirstOrDefault(e => e.Name.LocalName == "VINTAGE_STORY")
            ?.Value.Trim();
        if (value == null)
            return "";
        Log.Information($"* Got '{value}' from {propsFile}");
        return value;
    }

    private string ReadVsPathFromEnv()
    {
        var value = Environment.GetEnvironmentVariable("VINTAGE_STORY") ?? "";
        if (!string.IsNullOrEmpty(value))
            Log.Information($"* Got '{value}' from VINTAGE_STORY env var");
        return value;
    }
}
