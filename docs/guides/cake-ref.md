# Cake Integration Reference

This guide covers the customization points in
[`GameTestsTaskBase`](/vintest/api/VinTest.Cake.GameTestsTaskBase_TContext_/)
and
[`ContextBase`](/vintest/api/VinTest.Cake.ContextBase/),
and explains how the task drives the test lifecycle.

> For the initial setup, see [Cake Integration](../quickstart/cake-integration.md).

!!! note "Remember: all `../paths` here are resolved relative to `CakeBuild.csproj`"

## Execution flow

When you run your `RunGameTests` Cake target,
[`GameTestsTaskBase.Run()`](/vintest/api/VinTest.Cake.GameTestsTaskBase_TContext_/#gameteststaskbasetcontextruntcontext-method)
performs the following steps in order:

1. **Cleanup** — deletes any previous mod binaries and VS log files, restores the world save
    from a `.orig` backup (if one exists).
1. **Write config** — writes `ModConfig/vintestconfig.json` into the data directory, passing
    some of the CLI arguments to the in-game runner
    (See [Writing Tests — Interaction with VinTest.Cake](writing-tests.md#interaction-with-vintestcake)).
1. **Prepare** — calls your [`Prepare()`](/vintest/api/VinTest.Cake.GameTestsTaskBase_TContext_/#gameteststaskbasetcontextpreparetcontext-method) override.
    Does nothing by default; create any extra config files or perform additional cleanup here.
1. **Build** — calls your [`Build()`](/vintest/api/VinTest.Cake.GameTestsTaskBase_TContext_/#gameteststaskbasetcontextbuildtcontext-method) override.
    By default will build the gametests project, which in turn will cause building the main mod.
1. **Launch** — starts `VintageStory.exe` with `--addModPath`, `--addOrigin`, `--dataPath`,
    and `--openWorld` arguments.
1. **Wait** — polls for `TestResults/results.json` until VS exits or the timeout is reached.
    In [`ManualMode`](writing-tests.md#manual-mode), simply waits for VS to exit.
1. **Scan logs** — reads VS log files from `Logs/`, classifies each line, and collects any
    errors or warnings.
1. **Print** — reports test pass/fail counts and prints the filtered log.

## Customizing the build step

If _somehow_ just building the gametests project is not enough in your case, you can override the
[`Build()`](/vintest/api/VinTest.Cake.GameTestsTaskBase_TContext_/#gameteststaskbasetcontextbuildtcontext-method)
method to change what gets compiled before VS launches:

```cs
protected override void Build(TContext context)
{
    // ...
}
```

!!! warning "Do not rebuild the Cake project itself"

    The default `Build()` intentionally does not rely on building a solution (if one is present),
    and skips rebuilding the CakeBuild project itself.
    The Cake executable is already running and its DLL is locked; trying to rebuild it would
    cause MSBuild to fail.

## Customizing asset and mod paths

[`GetModBinaryPaths()`](/vintest/api/VinTest.Cake.GameTestsTaskBase_TContext_/#gameteststaskbasetcontextgetmodbinarypathstcontext-method)
returns the list of directories passed to `--addModPath`.
By default it uses `../<ProjectName>/bin/<Configuration>/Mods` output directories of both the main mod
and the gametests mod.

[`GetAssetsPaths()`](/vintest/api/VinTest.Cake.GameTestsTaskBase_TContext_/#gameteststaskbasetcontextgetassetspathstcontext-method)
returns directories passed to `--addOrigin`.
It defaults to `../<ProjectName>/assets/`.

These paths are based on the structure of
[:octicons-mark-github-24: vsmodtemplate](https://github.com/anegostudios/vsmodtemplate).
If your mod layout differs from that, you can override both methods (and return more than one path,
if needed):

```cs
protected override IEnumerable<string> GetAssetsPaths(BuildContext context)
{
    return [
        Path.GetFullPath("../assets/"),
        Path.GetFullPath("../more-assets/"),
    ];
}

// or, if your mod has no assets:
protected override IEnumerable<string> GetAssetsPaths(BuildContext context)
{
    return [];
}
```

## Creating additional mod files

Override
[`Prepare()`](/vintest/api/VinTest.Cake.GameTestsTaskBase_TContext_/#gameteststaskbasetcontextpreparetcontext-method)
to create any mod-specific files before VS launches.
This runs after the generic cleanup, so files you write here are fresh for each run.

```cs
protected override void Prepare(BuildContext context)
{
    var configPath = Path.Combine(context.DataPath, "ModConfig", "mymod.json");
    File.WriteAllText(configPath, """{"SomeFlag": true}""");
}
```

## Log filtering

After VS exits, the task scans its `<DataPath>/Logs/` directory and classifies each log line into
one of three categories based on ==substring matching==:

| Type    | Default patterns                   | Color  | Effect on build                               |
| ------- | ---------------------------------- | ------ | --------------------------------------------- |
| Error   | `[Error]`                          | Red    | Fails the task (unless `--ignore-log-errors`) |
| Warning | `[Warning]`,<br>`not found. Hint:` | Yellow | Printed, no failure                           |
| Capture | `[VinTest]`                        | Normal | Printed                                       |

??? info "The "not found" hint"

    The `not found. Hint` pattern is part of the warning about patch operation failing on a
    "missing" clientside/serverside JSON:

    ```
    [VerboseDebug] Patch 0 in petai:patches/entities/player.json: File game:entities/humanoid/player.json not found. Hint: This asset is usually only loaded Server side
    ```

    It indicates that, due to the lack of `side: server` or `side: client` in the patch file, VS
    client (or server) is trying to patch a file that it never loaded.
    It is harmless, and so not considered an error by default, but can be quite verbose and
    deserves to be highlighted.

Lines that match no bucket are not printed by the Cake task at all.

You can override the
[`AdditionalLogErrors`](/vintest/api/VinTest.Cake.GameTestsTaskBase_TContext_/#gameteststaskbasetcontextadditionallogerrors-property),
[`AdditionalLogWarnings`](/vintest/api/VinTest.Cake.GameTestsTaskBase_TContext_/#gameteststaskbasetcontextadditionallogwarnings-property), and
[`AdditionalLogCapture`](/vintest/api/VinTest.Cake.GameTestsTaskBase_TContext_/#gameteststaskbasetcontextadditionallogcapture-property)
properties to add your own substrings to each category:

```cs
protected override string[] AdditionalLogErrors => ["FATAL", "[MyMod] critical:"];
protected override string[] AdditionalLogWarnings => ["[MyMod] warn:"];
protected override string[] AdditionalLogCapture => ["[MyMod]"];
```

Once initial classification is done,
[`LogSuppressions`](/vintest/api/VinTest.Cake.GameTestsTaskBase_TContext_/#gameteststaskbasetcontextlogsuppressions-property)
lets you change the level of specific lines using ==regex patterns==.
Each entry is a `(Pattern, Level?)` pair:

- If `Level` is `null`, the matching line is dropped entirely (not printed, does not count as error).
- Otherwise the category of the line is changed — so a very specific regular line can become an
    error, and a very specific error can be silenced.

```cs
protected override IEnumerable<(string Pattern, LogLevel? TargetLevel)> LogSuppressions
{
    return [
        // drop a noisy line that always appears
        (@"\[Error\] Font '.*' not found", null),
        // demote a known false-positive error to warning
        (@"\[Error\] Old world format", LogLevel.Warning),
    ];
}
```

Patterns are compiled as case-insensitive regular expressions.

!!! abstract "To filter or not to filter"

    The main purpose of this mechanism is to prevent you from drowning in warnings about a faulty
    3rdparty mod that you depend on, and to customize what deserves a build failure and what
    deserves a simple highlight.
    Nevertheless, it is a good idea to keep your code as warning-free as possible without silencing anything.

## CLI arguments reference

[`ContextBase`](/vintest/api/VinTest.Cake.ContextBase/)'s
is constructed by the Cake internals.
The sole purpose of this class is to parse the command-line parameters passed after `--`,
provide sensible defaults for the omitted arguments, and expose everything through properties.

```pwsh title="powershell" hl_lines="6-14"
dotnet run --project ./CakeBuild --target RunGameTests

# the above call without any arguments is fully equivalent to:

dotnet run --project ./CakeBuild --target RunGameTests -- # (1)!
  --vs-path <see below> `
  --configuration Release `
  --data-path ../gamedata `
  --test-world autotest `
  --test-timeout 300 `
  --test-filter "" `
  --manual-mode false `
  --ignore-log-errors false `
```

1. Note the `--` separating Cake's own parameters from the task parameters

The parameters map into following properties:

- `--vs-path` ([`VsPath`](/vintest/api/VinTest.Cake.ContextBase/#contextbasevspath-property))
    — Path to the VintageStory installation directory containing `VintageStory.exe`.

    > If left empty, will first check the `Directory.Build.props` file, then the
    > `VINTAGE_STORY` environment variable.
    > See [Local Development — Using local Vintage Story installation](local-dev.md#using-local-vintage-story-installation).

- `--configuration` ([`BuildConfiguration`](/vintest/api/VinTest.Cake.ContextBase/#contextbasebuildconfiguration-property))
    — Build configuration passed to `dotnet build`.

- `--data-path` ([`DataPath`](/vintest/api/VinTest.Cake.ContextBase/#contextbasedatapath-property))
    — Path to the Vintage Story data directory (`Saves/`, `Logs/`, `ModConfig/`, etc.).
    If the directory does not exist, Vintage Story will create it.

- `--test-world` ([`TestWorldName`](/vintest/api/VinTest.Cake.ContextBase/#contextbasetestworldname-property))
    — Name of the world save to open.
    If no save with such name exist, Vintage Story will create a new creative world.

- `--test-timeout` ([`TestRunTimeoutSeconds`](/vintest/api/VinTest.Cake.ContextBase/#contextbasetestruntimeoutseconds-property))
    — Seconds to wait for all tests to finish before timing out with an error.
    Effectively caps the max execution time for your entire test project.

- `--test-filter` ([`TestCaseFilter`](/vintest/api/VinTest.Cake.ContextBase/#contextbasetestcasefilter-property))
    — Comma-separated substrings to filter `SuiteName.CaseName`.
    When empty, all tests run.
    See [Writing Tests — Filtering tests](writing-tests.md#filtering-tests).

- `--manual-mode` ([`ManualMode`](/vintest/api/VinTest.Cake.ContextBase/#contextbasemanualmode-property))
    — Launch Vintage Story without running tests automatically; the task indefinitely waits for the game to exit.
    See [Writing Tests — Manual mode](writing-tests.md#manual-mode).

    > Should be activated as `--manual-mode true`

- `--ignore-log-errors` ([`IgnoreLogErrors`](/vintest/api/VinTest.Cake.ContextBase/#contextbaseignorelogerrors-property))
    — When set, captured log lines matching error patterns are printed but **do not fail the task**.

    > Should be activated as `--ignore-log-errors true`

## Additional computed properties

[`ContextBase`](/vintest/api/VinTest.Cake.ContextBase/)
also exposes a few derived properties:

- [`AutotestsProjectName`](/vintest/api/VinTest.Cake.ContextBase/#contextbaseautotestsprojectname-property)
    — `"{ProjectName}.gametests"` by default; override to change.

- [`TestResultsPath`](/vintest/api/VinTest.Cake.ContextBase/#contextbasetestresultspath-property)
    — Full path to `<DataPath>/TestResults/results.json`.

- [`PidFilePath`](/vintest/api/VinTest.Cake.ContextBase/#contextbasepidfilepath-property)
    — Full path to `<DataPath>/TestResults/vs.pid`.
