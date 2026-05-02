using System;
using Vintagestory.API.Common;
using Vintagestory.API.Server;

namespace VinTest;

/// <summary>
/// Base class for ModSystem in your test mod.
/// </summary>
public abstract class GametestModsystemBase : ModSystem
{
    /// <summary>
    /// Server API, initialized upon StartServerSide().
    /// </summary>
    protected ICoreServerAPI SApi { get; private set; } = null!;

    /// <summary>
    /// Factory method to create the set of test suites to run.
    /// You are required to implement this, returning a collection of your suite implementations.
    /// </summary>
    /// <param name="player">The joining player.</param>
    /// <returns>An array of test suites.</returns>
    protected abstract object[] CreateSuites(IServerPlayer player);

    /// <summary>
    /// Delay between player joining and first testsuite starting.
    /// Customize this if your test world needs more time to load.
    /// </summary>
    protected virtual int StartupDelayMs => 2000;

    private bool _started;

    public override void StartServerSide(ICoreServerAPI api)
    {
        SApi = api;
        api.Logger.Notification("[VinTest] Test harness active");
        api.Event.PlayerNowPlaying += OnPlayerNowPlaying;
    }

    private void OnPlayerNowPlaying(IServerPlayer player)
    {
        if (_started)
            return;
        _started = true;

        var cfg = SApi.LoadModConfig<VinTestConfig>("vintestconfig.json");
        var runner = new Runner(SApi);

        try
        {
            runner.Start(CreateSuites(player), StartupDelayMs, cfg?.TestCaseFilter);
        }
        catch (Exception e)
        {
            SApi.Logger.Error($"[VinTest] Fatal error during test startup: {e.Message}");
            SApi.Event.RegisterCallback(dt => Environment.Exit(1), 1000);
            // to ensure VS logs the entire exception properly
            throw;
        }
    }
}

/// <summary>
/// Optional config read from JSON file under <c>ModConfig/</c>.
/// </summary>
public class VinTestConfig
{
    /// <summary>
    /// Case-insensitive substring to filter <c>SuiteName.CaseName</c>s by.
    /// When non-empty, only matching tests are enqueued; all others are skipped.
    /// </summary>
    public string? TestCaseFilter { get; set; }
}
