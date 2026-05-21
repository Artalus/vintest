using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json;
using Vintagestory.API.Common;
using Vintagestory.API.Server;

namespace VinTest;

internal class Runner(ICoreServerAPI sapi)
{
    private readonly ICoreServerAPI sapi = sapi;
    private readonly Queue<CaseEntry> caseQueue = [];
    private readonly Dictionary<string, TestSuiteResult> suiteResults = [];
    private TestSuiteResult? currentSuiteResult;
    private CaseEntry? currentCase;
    private readonly List<AssertionResult> currentAssertions = [];
    private readonly Stopwatch caseTimer = new();

    private record CaseEntry(string SuiteName, string CaseName, IEnumerator<TestStep> Enumerator);

    /// <summary>
    /// Starts the test runner with the given test suites.
    /// </summary>
    /// <param name="suites">Objects with methods annotated with [GameTest] attribute, returning <see cref="IEnumerable{TestStep}"/>.</param>
    /// <param name="startupDelayMs">Milliseconds to wait before running the first test.</param>
    /// <param name="testCaseFilter">
    /// Case-insensitive substring to filter <c>SuiteName.CaseName</c>s by.
    /// When non-empty, only matching tests are enqueued; all others are skipped.
    /// </param>
    public void Start(object[] suites, int startupDelayMs, string? testCaseFilter = null)
    {
        var filters =
            testCaseFilter?.Split(
                ',',
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries
            ) ?? [];
        bool hasFilter = filters.Length > 0;
        if (hasFilter)
            sapi.Logger.Notification($"[VinTest] Filter active: '{testCaseFilter}'");

        foreach (var suite in suites)
        {
            string suiteName = suite.GetType().Name;
            if (suite.GetType().GetCustomAttribute<GameTestSuiteAttribute>() == null)
                throw new InvalidOperationException(
                    $"Test suite class '{suiteName}' is missing the [GameTestSuite] attribute."
                );

            var methods = suite
                .GetType()
                .GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .Where(m => m.GetCustomAttribute<GameTestAttribute>() != null)
                .ToList();

            if (methods.Count == 0)
                throw new InvalidOperationException(
                    $"Test suite '{suiteName}' has no test methods. "
                        + "Each test must be a `public` method returning `IEnumerable<TestStep>` with `[GameTest]` attribute applied."
                );

            foreach (var method in methods)
            {
                if (!typeof(IEnumerable<TestStep>).IsAssignableFrom(method.ReturnType))
                    throw new InvalidOperationException(
                        $"[GameTest] method '{suiteName}.{method.Name}' must return IEnumerable<TestStep>, "
                            + $"but returns {method.ReturnType.Name}."
                    );

                string fullName = $"{suiteName}.{method.Name}";
                if (
                    hasFilter
                    && !filters.Any(f => fullName.Contains(f, StringComparison.OrdinalIgnoreCase))
                )
                {
                    sapi.Logger.Notification($"[VinTest] Skipping '{fullName}' (filtered out)");
                    continue;
                }

                var attr = method.GetCustomAttribute<GameTestAttribute>()!;
                var enumerator = (
                    (IEnumerable<TestStep>)method.Invoke(suite, null)!
                ).GetEnumerator();
                caseQueue.Enqueue(new CaseEntry(suiteName, method.Name, enumerator));
            }
        }

        if (caseQueue.Count == 0)
            throw new InvalidOperationException(
                $"No test cases matched filter '{testCaseFilter}'. "
                    + "Check the filter string against your [GameTest] method names."
            );

        if (startupDelayMs > 0)
        {
            sapi.Logger.Notification($"[VinTest] Waiting {startupDelayMs}ms for startup...");
            DelayThen(startupDelayMs, NextCase);
        }
        else
            NextCase();
    }

    private void NextCase()
    {
        currentCase = caseQueue.Dequeue();
        if (!suiteResults.TryGetValue(currentCase.SuiteName, out currentSuiteResult))
        {
            currentSuiteResult = new TestSuiteResult { SuiteName = currentCase.SuiteName };
            suiteResults[currentCase.SuiteName] = currentSuiteResult;
        }
        currentAssertions.Clear();
        caseTimer.Restart();
        var title = $"{currentCase.SuiteName}.{currentCase.CaseName}";
        sapi.Logger.Notification($"[VinTest] > > >  {title}");
        sapi.BroadcastMessageToAllGroups($"&gt;&gt;&gt; {title}", EnumChatType.Notification);
        RunFromCurrentStep();
    }

    private void RunFromCurrentStep()
    {
        while (currentCase!.Enumerator.MoveNext())
        {
            var step = currentCase.Enumerator.Current;

            switch (step)
            {
                case TestStep.ConditionalWaitStep conditionalWait:
                    if (!conditionalWait.Condition())
                        break;
                    DelayThen(conditionalWait.Ms, RunFromCurrentStep);
                    return;

                case TestStep.PollStep pollStep:
                    PollUntil(pollStep, Stopwatch.GetTimestamp());
                    return;

                case TestStep.DoStep doStep:
                    try
                    {
                        doStep.Action();
                    }
                    catch (Exception e)
                    {
                        var (msg, loc) = AnalyzeException(e);
                        FinishCase(
                            failedUnexpectedly: true,
                            exceptionMessage: msg,
                            exceptionLocation: loc
                        );
                        return;
                    }
                    break;

                case TestStep.AssertStep assertStep:
                    try
                    {
                        bool passed = assertStep.Condition();
                        currentAssertions.Add(
                            new AssertionResult
                            {
                                Name = assertStep.Name,
                                Passed = passed,
                                Location = assertStep.Location,
                            }
                        );
                        if (!passed)
                        {
                            FinishCase(
                                failedUnexpectedly: false,
                                exceptionMessage: null,
                                exceptionLocation: null
                            );
                            return;
                        }
                    }
                    catch (Exception e)
                    {
                        var (msg, loc) = AnalyzeException(e);
                        currentAssertions.Add(
                            new AssertionResult
                            {
                                Name = assertStep.Name,
                                Passed = false,
                                Location = loc ?? assertStep.Location,
                            }
                        );
                        FinishCase(
                            failedUnexpectedly: true,
                            exceptionMessage: msg,
                            exceptionLocation: loc
                        );
                        return;
                    }
                    break;

                default:
                    throw new UnreachableException($"Unknown TestStep type: {step.GetType().Name}");
            }
        }

        // Loop exhausted - test method passed
        FinishCase(failedUnexpectedly: false, exceptionMessage: null, exceptionLocation: null);
    }

    private void PollUntil(TestStep.PollStep step, long startedAt)
    {
        bool passed = false;
        try
        {
            passed = step.BreakWhen();
        }
        catch (Exception e)
        {
            var (msg, loc) = AnalyzeException(e);
            currentAssertions.Add(
                new AssertionResult
                {
                    Name = step.Name,
                    Passed = false,
                    Location = loc ?? step.Location,
                }
            );
            FinishCase(failedUnexpectedly: true, exceptionMessage: msg, exceptionLocation: loc);
            return;
        }

        if (passed)
        {
            currentAssertions.Add(
                new AssertionResult
                {
                    Name = step.Name,
                    Passed = true,
                    Location = step.Location,
                }
            );
            RunFromCurrentStep();
            return;
        }

        long elapsedMs = (long)Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds;
        if (elapsedMs + step.PollIntervalMs >= step.MaxMs)
        {
            currentAssertions.Add(
                new AssertionResult
                {
                    Name = step.Name,
                    Passed = false,
                    Location = step.Location,
                }
            );
            FinishCase(failedUnexpectedly: false, exceptionMessage: null, exceptionLocation: null);
            return;
        }

        DelayThen(step.PollIntervalMs, () => PollUntil(step, startedAt));
    }

    private void FinishCase(
        bool failedUnexpectedly,
        string? exceptionMessage,
        string? exceptionLocation
    )
    {
        caseTimer.Stop();
        bool assertionsPassed = currentAssertions.All(a => a.Passed);
        bool passed = !failedUnexpectedly && assertionsPassed;

        var result = new TestCaseResult
        {
            Name = currentCase!.CaseName,
            Passed = passed,
            DurationMs = caseTimer.Elapsed.TotalMilliseconds,
            Assertions = [.. currentAssertions],
            ExceptionLocation = exceptionLocation,
            ExceptionMessage = exceptionMessage,
        };

        currentSuiteResult!.TestCases.Add(result);
        var title = $"{currentCase.SuiteName}.{currentCase.CaseName}";
        var duration = $"{result.DurationMs:F0}ms";
        var status = passed ? "PASS" : "FAIL";
        sapi.Logger.Notification($"[VinTest] < < < {title} {status} ({duration})");
        sapi.BroadcastMessageToAllGroups(
            $"&lt;&lt;&lt; {status} ({duration})",
            EnumChatType.Notification
        );

        if (caseQueue.Count > 0)
        {
            NextCase();
            return;
        }
        WriteResultsAndExit();
    }

    /// <summary>
    /// Filters out VinTest frames from an exception, formats a user-friendly message,
    /// and extracts the last user code location as "path:line".
    /// Inner exceptions are included using the standard ---> nesting format.
    /// </summary>
    private static (string Message, string? Location) AnalyzeException(Exception e)
    {
        string? location = null;
        return (BuildExceptionMessage(e, ref location), location);
    }

    private void WriteResultsAndExit()
    {
        var testRun = new TestRunResult
        {
            Timestamp = DateTime.UtcNow,
            Suites = [.. suiteResults.Values],
        };

        string json = JsonConvert.SerializeObject(testRun, Formatting.Indented);
        // NOTE: this path is shared with the Cake library
        string dir = Path.Combine(sapi.DataBasePath, "TestResults");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "results.json"), json);

        foreach (var suite in testRun.Suites)
        {
            int passed = suite.TestCases.Count(tc => tc.Passed);
            int total = suite.TestCases.Count;
            sapi.Logger.Notification(
                $"[VinTest] Suite '{suite.SuiteName}': {passed}/{total} passed"
            );
        }

        sapi.Logger.Notification($"[VinTest] Test run {(testRun.Passed ? "PASSED" : "FAILED")}");
        Environment.Exit(testRun.Passed ? 0 : 1);
    }

    private static string BuildExceptionMessage(Exception e, ref string? location)
    {
        var st = new StackTrace(e, fNeedFileInfo: true);
        var frameLines = new List<string>();

        foreach (var frame in st.GetFrames())
        {
            var method = frame.GetMethod();
            if (method == null)
                continue;
            if ((method.DeclaringType?.Namespace ?? "").StartsWith("VinTest"))
                break;

            var file = frame.GetFileName();
            var lineNo = frame.GetFileLineNumber();
            if (!string.IsNullOrEmpty(file) && lineNo != 0)
                location = $"{file}:{lineNo}";

            var paramList = string.Join(
                ", ",
                method.GetParameters().Select(p => p.ParameterType.Name)
            );
            var sig = $"   at {method.DeclaringType?.FullName ?? "?"}.{method.Name}({paramList})";
            frameLines.Add(
                !string.IsNullOrEmpty(file) && lineNo != 0 ? $"{sig} in {file}:line {lineNo}" : sig
            );
        }

        var sb = new System.Text.StringBuilder();
        sb.Append($"{e.GetType().FullName}: {e.Message}");

        if (e.InnerException != null)
        {
            string? innerLocation = null;
            sb.Append("\n ---> ");
            sb.Append(BuildExceptionMessage(e.InnerException, ref innerLocation));
            sb.Append("\n --- End of inner exception stack trace ---");
        }

        if (frameLines.Count > 0)
            sb.Append("\n").Append(string.Join("\n", frameLines));

        return sb.ToString();
    }

    private void DelayThen(int ms, Action callback)
    {
        // declare+assign, otherwise the closure cannot capture it
        long id = 0;
        id = sapi.Event.RegisterGameTickListener(
            _ =>
            {
                sapi.Event.UnregisterGameTickListener(id);
                callback();
            },
            ms
        );
    }
}

/// <summary>
/// Overall result of a test run once the runner is done with it.
/// </summary>
internal class TestRunResult
{
    public DateTime Timestamp { get; set; }
    public bool Passed => Suites.All(s => s.Passed);
    public List<TestSuiteResult> Suites { get; set; } = [];
}

/// <summary>
/// Result of a single entire ITestSuite, containing multiple test cases.
/// </summary>
internal class TestSuiteResult
{
    public required string SuiteName { get; set; }
    public bool Passed => TestCases.All(tc => tc.Passed);
    public List<TestCaseResult> TestCases { get; set; } = [];
}

/// <summary>
/// Result of a single [GameTest] marked method.
/// </summary>
internal class TestCaseResult
{
    public required string Name { get; set; }
    public bool Passed { get; set; }
    public double DurationMs { get; set; }
    public List<AssertionResult> Assertions { get; set; } = [];
    public string? ExceptionLocation { get; set; }
    public string? ExceptionMessage { get; set; }
}

internal class AssertionResult
{
    public string Name { get; set; } = "";
    public bool Passed { get; set; }
    public string? Location { get; set; }
}
