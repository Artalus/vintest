using Vintagestory.API.Server;
using VinTest;

namespace MyMod.GameTests;

// Inherit your modsystem from VinTest base, not from VS ModSystem.
//
public class TestModSystem : GametestModsystemBase
{
    // If your main mod needs more time to do meaningful stuff before you can test it,
    // change the default delay to avoid false negatives.
    // protected override int StartupDelayMs => 20_000;

    // This method gets called by the base class once the player has spawned, upon
    // sapi.Event.PlayerNowPlaying firing.
    // You need to initialize and return your test suites here, passing any dependencies they need.
    protected override object[] CreateSuites(IServerPlayer player)
    {
        return
        [
            new GreenTests(player),
            // SApi property gets initialized during StartServerSide() in base class implementation
            new RedTests(this.SApi, player),
        ];
    }
}
