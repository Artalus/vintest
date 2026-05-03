using System.IO;
using Cake.Common;
using Cake.Core;
using Cake.Frosting;

namespace VinTest.Cake;

/// <summary>
/// FrostingContext substitute that provides common arguments for running VS integration tests.
/// Inherit from this in your mod's BuildContext and supply the remaining project-specific properties.
/// </summary>
public abstract class ContextBase : FrostingContext
{
    /// <summary>
    /// Name of your core mod's project (WITHOUT `.csproj` extension)
    /// You must define it in your BuildContext class.
    /// </summary>
    public abstract string ProjectName { get; }

    /// <summary>
    /// Name of the test mod project (WITHOUT `.csproj` extension).
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

    protected ContextBase(ICakeContext context)
        : base(context)
    {
        var vspathCandidate = context.Argument("vs-path", "");
        if (string.IsNullOrEmpty(vspathCandidate))
            vspathCandidate = Environment.GetEnvironmentVariable("VINTAGE_STORY") ?? "";
        if (string.IsNullOrEmpty(vspathCandidate))
            throw new CakeException(
                "Vintage Story path not provided. Set --vs-path or VINTAGE_STORY env var"
            );
        VsPath = Path.GetFullPath(vspathCandidate);
        if (!File.Exists(Path.Combine(VsPath, "VintageStory.exe")))
            throw new CakeException($"Vintage Story executable not found in {VsPath}");
        DataPath = Path.GetFullPath(context.Argument("data-path", "../gamedata"));
        TestWorldName = context.Argument("test-world", "autotest");
        TestRunTimeoutSeconds = context.Argument("test-timeout", 300);
        BuildConfiguration = context.Argument("configuration", "Release");
        IgnoreLogErrors = context.Argument("ignore-log-errors", false);
        TestCaseFilter = context.Argument("test-filter", "");
    }
}
