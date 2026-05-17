using System.Collections.Generic;
using System.Linq;
using Vintagestory.API.Server;
using VinTest;

namespace MyMod.GameTests;

// Your test classes are required to be marked with [GameTestSuite], and test methods with [GameTest].
[GameTestSuite]
public class GreenTests(IServerPlayer player)
{
    [GameTest]
    public IEnumerable<TestStep> Success() =>
        new TestChain().Assert(
            "no player shall join without a valid id",
            () => !string.IsNullOrEmpty(player.PlayerUID)
        );
}

// Here are some examples on how your tests mail fail.
[GameTestSuite]
public class RedTests(ICoreServerAPI sapi, IServerPlayer player)
{
    [GameTest]
    public IEnumerable<TestStep> AssertionFailed() =>
        new TestChain().Assert(
            "here be drifters",
            () => sapi.World.LoadedEntities.Values.Any(e => e.Code.Path == "drifter")
        );

    [GameTest]
    public IEnumerable<TestStep> ExceptionInDo()
    {
        var modsystem = sapi.ModLoader.GetModSystem<MyModSystem>();
        return new TestChain()
            .Do(() => modsystem.TurnIntoDrifter(player))
            .AssertEventually(
                "this is such a bad idea",
                10_000,
                () => player.Entity.Code.Path == "drifter"
            );
    }

    [GameTest]
    public IEnumerable<TestStep> ExceptionInAssert()
    {
        var modsystem = sapi.ModLoader.GetModSystem<MyModSystem>();
        return new TestChain().Assert(
            "hm",
            () =>
            {
                modsystem.TurnIntoDrifter(player);
                return true;
            }
        );
    }

    // Do *NOT* put any code that may throw outside of .Do() or .Assert() !
    // Test runner is fully active at that point, and the test mod will fail silently without
    // producing any meaningful results.
    // [GameTest]
    // public IEnumerable<TestStep> ExceptionInBody() {
    //     CatastrophicFailure();
    //     return new TestChain();
    // }
    // private static void CatastrophicFailure() => throw new System.Exception("oh no");
}
