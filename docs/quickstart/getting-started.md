---
icon: fontawesome/regular/circle-dot
---

# Getting Started

This part walks you through adding VinTest to an existing Vintage Story mod project.

## Prerequisites

- .NET SDK 8.0 or later
- A working VintageStory installation
- A world save for testing. The world must be fully initialized — the player must have created a
    character and spawned in at least once.

!!! tip "Separate your test environment"

    Keep your testing environment isolated from your regular VS data via
    [`--dataPath`](https://wiki.vintagestory.at/Client_startup_parameters)
    launch parameter.
    Your file directory would look like this:

    ```hl_lines="2"
    mod-workspace/
      custom-data-path/
      YourMod/
        YourMod.csproj
      YourMod.gametests/
        YourMod.gametests.csproj
      the-mod.slnx
    ```

## Setting up the tests

**Create the test project**

Add a new C# project to your solution. By convention it is named `<YourMod>.gametests`:

```xml title="YourMod.gametests/YourMod.gametests.csproj" linenums="1" hl_lines="9-21"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath>
    <OutputPath>bin\$(Configuration)\Mods\mod</OutputPath>
    <Nullable>enable</Nullable>
  </PropertyGroup>

  <ItemGroup>
    <Reference Include="VintagestoryAPI"> <!-- (1)! -->
      <HintPath>$(VINTAGE_STORY)/VintagestoryAPI.dll</HintPath> <!-- (2)! -->
      <Private>false</Private> <!-- (3)! -->
    </Reference>
  </ItemGroup>

  <ItemGroup>
    <PackageReference Include="VinTest" Version="0.0.0" /> <!-- (4)! -->
    <ProjectReference Include="../YourMod/YourMod.csproj"> <!-- (5)! -->
      <Private>false</Private> <!-- (6)! -->
    </ProjectReference>
  </ItemGroup>

  <ItemGroup>
    <Content Include="modinfo.json"> <!-- (7)! -->
      <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
    </Content>
  </ItemGroup>
</Project>
```

1. Just like with any regular mod, gametests need VS DLLs to be built and run.
1. `VINTAGE_STORY` is an MSBuild property you must set to your VS installation path.
    See [Local Development — Using local Vintage Story installation](../guides/local-dev.md#using-local-vintage-story-installation).
1. `<Private>` controls whether the referenced DLL should be copied to the output directory (`true`) or not (`false`).
    Gametests are a mod — they get loaded by VS itself and do not need its DLLs
    to be copied to the output.
1. `PackageReference`d things come from
    [NuGet](https://www.nuget.org/)
    in an automagical way whenever you `dotnet build` your project.
    Usually you'd want to get a pinned VinTest version from NuGet, updating it as you see fit.
1. Gametests need the main mod DLLs in order to build and run.
1. The main mod will already be loaded by VS; its DLLs need not be copied.
1. We will point VS to our output directory, and so it will expect a `modinfo.json` file there.
    See the [:octicons-mark-github-24: example project](https://github.com/Artalus/vintest/tree/main/example/MyMod.gametests)
    for a minimal one.

______________________________________________________________________

**Write your first test**

```cs title="YourMod.gametests/YourTests.cs" linenums="1" hl_lines="4 7-16"
using System.Collections.Generic;
using VinTest;

[GameTestSuite] // (1)!
public class YourTestSuite
{
    [GameTest] // (2)!
    public IEnumerable<TestStep> MathWorks() // (3)!
    {
        return new TestChain().Assert( // (4)!
            "two plus two is four", // (5)!
            () => { // (6)!
              return 2 + 2 == 4;
            }
        );
    }
}
```

1. Marks this class as a test suite — a collection of test cases.
    `VinTest` runner discovers it automatically at startup by scanning for this attribute.
1. Marks this method as a test case — a single scenario to be tested.
1. Your test methods must return `IEnumerable<TestStep>`.
1. `.Assert()` calls are the core of the test method, verifying the state of the world.
1. First argument labels what you check for.
1. Second argument is a
    [lambda expression](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/lambda-operator)
    that contains the actual logic of your check.
    It should return a `bool` value, where `true` indicates that the check has passed.

> See [Writing Tests](../guides/writing-tests.md) for the full API reference.

!!! tip "The test case could be even terser if we go all the way with the modern `=>` syntax"

    ```cs
    public IEnumerable<TestStep> MathWorks() =>
        new TestChain().Assert(
            "two plus two is four",
            () => 2 + 2 == 4
        );
    ```

______________________________________________________________________

**Create the tests entry point**

Every VS mod needs a `ModSystem` entry point.
For your gametests mod, inherit from
[`GametestModsystemBase`](/vintest/api/VinTest.GametestModsystemBase/) instead of the regular `ModSystem`:

```cs title="YourMod.gametests/TestModSystem.cs" linenums="1" hl_lines="4 6 8"
using Vintagestory.API.Server;
using VinTest;

public class YourTestModSystem : GametestModsystemBase // (1)!
{
    protected override object[] CreateSuites(IServerPlayer player) // (2)!
    {
        return [new YourTestSuite()];
    }
}
```

1. The [`GametestModsystemBase`](/vintest/api/VinTest.GametestModsystemBase/)
    base class contains the boilerplate code to automate running tests.
1. This method gets called once the player has fully spawned in the world.

Your entry point class must implement
[`CreateSuites`](/vintest/api/VinTest.GametestModsystemBase/#gametestmodsystembasecreatesuitesiserverplayer-method) method.
It should return all of the test suite objects you want to be run.
It is done so you can inject any necessary dependencies into your suite classes at the moment of construction.

!!! warning

    If you create more test suite classes, do not forget to `new` them here!

## Run VS with your tests

Build both mods and launch VS:

```pwsh title="powershell"
VintageStory.exe `
  --addModPath "./YourMod/bin/Debug/Mods" "./YourMod.gametests/bin/Debug/Mods" `
  --dataPath "./gamedata" `
  --openWorld "autotest"
```

Once VS finishes loading and the player has spawned in the world, the test mod will run all suites and exit the game.
Open `gamedata/Logs/server-main.log` and look for `[VinTest]` lines:

```
19.5.2026 13:22:45 [Notification] [VinTest] > > >  YourTestSuite.MathWorks
19.5.2026 13:22:45 [Notification] [VinTest] Suite 'YourTestSuite': 1/1 passed
```

## Next steps

This is the bare minimum with which you might be able to bring automated testing procedures into your mod development.

Yet re-running VS and digging through its log files is quite tedious.

If you have `CakeBuild` in your project, see the [Cake Integration guide](cake-integration.md)
on how to automate the full build-run-report cycle with a single `dotnet run` command.
