# Writing Tests

This guide covers the VinTest test authoring API in depth.

> For a quick introduction, see [Getting Started](../quickstart/getting-started.md).

## Test suites and test cases

Tests are organized into **suites** — plain C# classes marked with `[GameTestSuite]`.
Each suite contains one or more **test cases** — `public` methods marked with `[GameTest]`,
returning `IEnumerable<TestStep>`.

```cs
[GameTestSuite]
public class PetTests
{
    [GameTest]
    public IEnumerable<TestStep> WolvesAreTameable() =>
        new TestChain()
            .Assert("wolf entity has tameable behavior", () => /* verify */);

    [GameTest]
    public IEnumerable<TestStep> WolvesEatMeat() =>
        new TestChain()
            .Do(() => /* feed meat to wolf */)
            .Wait(/* give it time to process */)
            .Assert("wolf got tamed status", () => /* verify */);
}
```

!!! abstract "Of Tests and Times"

    When speaking about software development in general, relying on the concept of time in tests
    is often A Bad Idea.
    Fixed delays make tests slow, or fragile, or both.
    And a test that only passes because you waited long enough and (restarted it a few times) is
    _usually_ not a test you can/should trust.

    Yet Vintage Story is a game, VinTest is a mod that runs inside the game loop, and so some things
    genuinely take time — entities load, timers fire, AI ticks, NPCs move around.

    Still, it would be a good idea keep time dependencies to a minimum.
    Prefer `.AssertEventually()` over `.Wait()` when it makes more sense: it passes as soon as the
    condition holds (given quick enough poll rate).
    Reserve `.Wait()` for situations where you need to let the game process something for a
    fixed duration before you can meaningfully observe the result.

## Naming convention

Each test case is identified by `SuiteName.CaseName`: the suite class name followed by the test
method name.

```
PetTests.WolvesAreTameable
PetTests.WolvesEatMeat
```

This identifier is used in log output and in filtering.

!!! tip "Keep your class and method names descriptive but not too verbose."

    :fontawesome-solid-x:{ style="color: #ff0000;"} `TestTame`
    <br>:fontawesome-solid-question-circle:{ style="color: #ffff00;"} `Wolf_Tame_Meter_Fills_Partially_If_Player_Feeds_It_Meat`
    <br>:fontawesome-solid-check-circle:{ style="color: #00ff00;"} `FeedingMeat_TamesPartially`

!!! tip "Keep test methods focused on a single thing"

    Though they still may have multiple assertions to verify that thing

## The `TestChain` API

`TestChain` is a builder class that describes what a test does, step by step.
You chain calls to it and return the result from your test method.

Steps are not executed immediately when the method is called — they are collected and then
executed one by one by the runner on subsequent game loop ticks.
This allows the runner to interleave them with the game loop (e.g. wait for an entity to
spawn before asserting something about it).

??? abstract "Why was it done this way"

    The Vintage Story game loop is essentially single-threaded.
    A function cannot simply sleep for ten seconds — it would freeze the entire game.

    Instead, a test method _describes_ what should happen via a sequence of (not directly exposed)
    `TestStep` objects, and then the runner *executes* them one at a time as callbacks, interleaved
    with normal game ticks.
    When a step needs to wait, the runner schedules the next step as a deferred callback and returns
    control to the game loop immediately — the same mechanism VS uses for its own timed events.

    This is why test methods return `IEnumerable<TestStep>` rather than running imperatively.
    Alternatively you could `yield return new Step(...)`, but that's just too much boilerplate.

As a rule of thumb: if a callback throws, or an `.Assert()` condition returns `false`, the test
case stops at that step and is marked as failed.

### `.Assert()`

[`TestChain.Assert`](/vintest/api/VinTest.TestChain/#testchainassertstring-funcbool-string-int-method)
— the core step.
Evaluates a `bool`-returning callback and records the result.
If the condition returns `false` the test case is marked as failed and stops.

```cs
new TestChain()
    .Assert("player is alive", () => player.Entity.Alive)
    .Assert("health is above 50", () => player.Entity.WatchedAttributes
        .GetTreeAttribute("health").GetFloat("currenthealth") > 50f)
```

The source file and line number parameters are populated automatically by the compiler via the
reflection magicks of
[`CallerFilePath` / `CallerLineNumber`](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/caller-information)
attributes — **do not pass them manually**.
They record the assertion's source location, which `VinTest.Cake` and the VS Code extension
surface as a clickable link when a test fails.

### `.Do()`

[`TestChain.Do`](/vintest/api/VinTest.TestChain/#testchaindoaction-method)
— simply executes a callback.

```cs
Entity? wolf = null;
new TestChain()
    .Do(() => wolf = SpawnWolf(sapi))
    .Assert("wolf is in the world", () => wolf.Alive)
```

Keep your `.Assert()`s shorter by putting the execution code in `.Do()`s.

!!! note

    Data flows between the steps via
    [captured variables](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/statements-expressions-operators/lambda-expressions#capture-of-outer-variables-and-variable-scope-in-lambda-expressions):
    a variable declared outside the chain and assigned in a `.Do()` is visible to every
    subsequent step.

!!! tip "`warning CS8602/CS8604: "possible null reference"`"

    The compiler warns when you access a member of a nullable variable without a null check,
    because in a generic case it cannot guarantee that 1) the initialization lambda will execute,
    and 2) it will do so before the acces lambda does.
    If _your code flow_ guarantees that instead, use the `!` (null-forgiving) operator to silence
    such warnings:

    ```cs
    // EITHER:
    .Assert("", () => wolf!.Alive)
    // OR:
    Entity wolf = null!;
    ```

### `.Wait()`

[`TestChain.Wait`](/vintest/api/VinTest.TestChain/#testchainwaitint-method)
— pause.
Once the chain execution reaches this step, it unconditionally waits for the given number of
milliseconds before proceeding to the next step.
Use this to give the game time to process events before asserting.

```cs
new TestChain()
    .Do(() => ScheduleExplosion(pos, 100))
    .Wait(1000)
    .Assert("block was destroyed", () => /* verify */)
```

!!! tip "Do not use arbitrary intervals without explaining why"

    :fontawesome-solid-x:{ style="color: #ff0000;"} `.Wait(123)`
    <br>:fontawesome-solid-check-circle:{ style="color: #00ff00;"}
    `.Wait(20_000) // chunks unload after ~10s`
    <br>:fontawesome-solid-check-circle:{ style="color: #00ff00;"} :octicons-arrow-down-16:

    ```cs
    // give OnTick() enough time to trigger
    int waitInterval = system.updateInterval * 3
    ...
    .Wait(waitInterval)
    ```

### `.WaitIf()`

[`TestChain.WaitIf`](/vintest/api/VinTest.TestChain/#testchainwaitifint-funcbool-method)
— same as `.Wait()`, but only waits if the condition is `true` at the moment the step runs.
Otherwise the wait is skipped and execution continues immediately.

```cs
bool needChunksToLoad = false;
new TestChain()
    .Do(() => needChunksToLoad = TeleportIfFarAway())
    .WaitIf(chunkLoadMs, () => needChunksToLoad)
    .Assert("entity is loaded", () => /* verify */)
```

### `.AssertEventually()`

Polls a condition repeatedly until it returns `true` or the timeout is reached.
If the timeout is reached without the condition becoming `true`, the test case fails.
Useful for asserting on things that take _a while_.

```cs
new TestChain()
    .Do(() => SpawnDrifterNearby())
    .AssertEventually(
        "drifter found the player",
        maxMs: 5000,
        breakWhen: () => PlayerWasAttacked(),
        // pollIntervalMs: 500  // optional
    )
    .Assert("player took damage", () => PlayerHealthDecreased())
```

### Notes

!!! bug "Do not throw inside a test method directly"

    ```cs
    // WRONG: the exception fires when the runner collects steps, not when it runs them
    [GameTest]
    public IEnumerable<TestStep> BadTest()
    {
        var entity = FindEntity(); // throws if not found yet
        return new TestChain().Assert("entity exists", () => entity != null);
    }

    // CORRECT: put any code that might fail inside a callback
    [GameTest]
    public IEnumerable<TestStep> GoodTest()
    {
        Entity? entity = null;
        return new TestChain()
            .Do(() => entity = FindEntity())
            .Assert("entity exists", () => entity != null);
    }
    ```

    Any exception thrown _outside_ a callback will propagate up during step collection and
    crash the entire runner before it has a chance to produce meaningful results.

## Injecting dependencies into suites

Suites are instantiated in `CreateSuites()`, which is called after the player has spawned.
Pass API instances, players and other useful dependencies into your suite constructors there:

```cs
public class EconomyTests
{
    private readonly ICoreServerAPI sapi;
    private readonly EconomySystem economy;
    private readonly IServerPlayer player;

    public EconomyTests(ICoreServerAPI s, EconomySystem e, IServerPlayer p)
    {
        sapi = s;
        economy = e;
        player = p;
    }

    // ...
}

public class YourTestModSystem : GametestModsystemBase
{
    protected override object[] CreateSuites(IServerPlayer player) =>
    [
        new EconomyTests(SApi, SApi.ModLoader.GetModSystem<EconomySystem>(), player),
    ];
}
```

!!! tip "C# 12 primary constructors"

    With [modern C#](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/instance-constructors#primary-constructors),
    you can declare "parameter-initialized" fields directly on the class:

    ```cs
    public class EconomyTests(ICoreServerAPI sapi, EconomySystem economy, IServerPlayer player)
    {
        // sapi, economy, player are available throughout the class body
    }
    ```

## Startup delay

By default, VinTest waits 2000 ms after the player joins before running the first test.
This gives the world time to finish loading before tests begin.

If your test world takes longer to settle (or you need less), override
[`StartupDelayMs`](/vintest/api/VinTest.GametestModsystemBase/#gametestmodsystembasestartupdelayms-property):

```cs
public class YourTestModSystem : GametestModsystemBase
{
    protected override int StartupDelayMs => 5000;

    protected override object[] CreateSuites(IServerPlayer player) => [/* ... */];
}
```

## Interaction with `VinTest.Cake`

These things are much easier to do if you use the cake task to drive your tests — but in the end
it boils down to Cake writing parameters into `ModConfig/vintestconfig.json`, and the framework
internals reacting to set parameters.

### Filtering tests

!!! note "`VinTest.Cake` → [`--test-filter` parameter](cake-ref.md#cli-arguments-reference)"

Instead of running every test on every launch, you can run a subset by filtering.

The filter is a comma-separated list of case-insensitive substrings.
A test case is run only if its `SuiteName.CaseName` contains at least one of the substrings.

```json title="gamedata/ModConfig/vintestconfig.json"
{
    "TestCaseFilter": "Economy,Crafting"
}
```

This runs only test cases whose full name contains `"economy"` or `"crafting"`.

!!! warning "'Contains', not 'equals'"

    It is technically possible to run a really weird set of tests by writing
    `"TestCaseFilter": "a"` to the file.

### Manual mode

!!! note "`VinTest.Cake` → [`--manual-mode` parameter](cake-ref.md#cli-arguments-reference)"

When `ManualMode` is enabled, VinTest loads normally but does not run tests automatically.
Use this to launch VS in a known state for manual debugging the tests, or initializing the world.

Enable it in `vintestconfig.json`:

```json title="gamedata/ModConfig/vintestconfig.json"
{
    "ManualMode": true
}
```

You can hook into this in your `ModSystem` to register debug commands or do custom setup:

```cs
public class YourTestModSystem : GametestModsystemBase
{
    protected override object[] CreateSuites(IServerPlayer player) => [/* ... */];

    protected override void OnManualModeReady(IServerPlayer player)
    {
        SApi.RegisterCommand("debugthing", "...", "", (p, g, a) => DebugThing());
        CreateEntitiesInWorld();
    }
}
```
