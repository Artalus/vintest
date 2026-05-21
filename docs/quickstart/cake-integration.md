---
icon: fontawesome/regular/circle-dot
---

# Cake Integration

This part describes how to automate the entire build-run-report cycle, so you only have to run
a single command.

!!! abstract

    [Cake](https://cakebuild.net/) is a C# build automation library.
    Popular VS mod templates — including Anego's very own
    [:octicons-mark-github-24: vsmodtemplate](https://github.com/anegostudios/vsmodtemplate)
    — ship with a `CakeBuild/` project already in the repo.
    If your mod does not have one, copy it from the template and take a look at
    [Cake Frosting quickstart](https://cakebuild.net/docs/getting-started/setting-up-a-new-frosting-project).

## Add game tests task to `CakeBuild`

**Reference `VinTest.Cake` in your project file**

Update your `CakeBuild.csproj` C# project to use the [`VinTest.Cake`](/vintest/api/VinTest.Cake/) library:

```xml title="CakeBuild/CakeBuild.csproj" linenums="1" hl_lines="5 10"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <RunWorkingDirectory>$(MSBuildProjectDirectory)</RunWorkingDirectory> <!-- (1)! -->
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Cake.Frosting" Version="6.1.0" />
    <PackageReference Include="VinTest.Cake" Version="0.1.0" />
  </ItemGroup>

  <ItemGroup>
    <Reference Include="VintagestoryAPI">
      <HintPath>$(VINTAGE_STORY)/VintagestoryAPI.dll</HintPath>
      <Private>false</Private>
    </Reference>
  </ItemGroup>
</Project>
```

1. Ensures `dotnet run` always executes from the `CakeBuild/` directory, so relative paths to
    your mod projects and assets resolve correctly.

**Inherit your `BuildContext` from `ContextBase`**

```cs title="CakeBuild/Program.cs" linenums="1" hl_lines="11 13 14"
using Cake.Core;
using Cake.Frosting;
using VinTest.Cake;

public static class Program
{
    public static int Main(string[] args) =>
        new CakeHost().UseContext<BuildContext>().Run(args);
}

public class BuildContext : ContextBase // (1)!
{
    public override string ProjectName => "YourMod"; // (2)!
    // public string BuildConfiguration { get; }  (3)

    public BuildContext(ICakeContext context) : base(context) {
        // Any additional argument parsing and initialization goes to the constructor
    }
}
```

1. [`ContextBase`](/vintest/api/VinTest.Cake.ContextBase/)
    parses VinTest-specific CLI arguments from `dotnet run -- ...`, and exposes them as
    typed properties on the context object.
1. Name of your main mod's C# project, without the `.csproj` extension.
    **If your cake had a `public const string` _field_ with this name, replace it with _property_.**
1. If your cake had a property with this name, remove it and use the one from the base class.

At the very least, you must define the
[`ProjectName`](/vintest/api/VinTest.Cake.ContextBase/#contextbaseprojectname-property)
property.
It will be used to deduce the value of the satellite
[`AutotestsProjectName`](/vintest/api/VinTest.Cake.ContextBase/#contextbaseautotestsprojectname-property)
property (`<ProjectName>.gametests` by default).
If you wish to name your gametests project differently, you will also need to override the `AutotestsProjectName` property.

!!! danger "`warning CS0108: 'BuildContext.BuildConfiguration' hides inherited member 'ContextBase.BuildConfiguration'`"

    If your mod already had `CakeBuild` created from a template, your `BuildContext` almost
    certainly has a `BuildConfiguration` property, parsed from `configuration` CLI arg.
    [`ContextBase`](/vintest/api/VinTest.Cake.ContextBase/)
    already defines this property, parsing it from the same argument.
    [Warning CS0108](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/cs0108)
    means that you are *allowed* to "redefine" a field with the same name, but it is *highly sus*.
    In this case, you need to remove the property from `BuildContext` and use one from the base class.

    _Note that if you have renamed the properties in your `BuildContext`, **you will not see this
    compiler warning, and might encounter weird issues later.**_

**Create new task to run the game tests**

```cs title="CakeBuild/Program.cs" linenums="20"
[TaskName("RunGameTests")] // (1)!
public class RunGameTestsTask : GameTestsTaskBase<BuildContext> {
    protected override IEnumerable<string> GetAssetsPaths(BuildContext context) =>
        [
            // Default implementation of this method is:
            //   return [ Path.GetFullPath($"../{context.ProjectName}/assets/") ];
            // If your assets are in a different directory, return the path(s) here.
            // If your mod does not have assets, you need to explicitly return an empty list here.
        ];
}
```

1. `RunGameTests` is the default task name the [VS Code extension](vscode-extension.md) looks for.
    If you choose a different name, you will need to update the extension settings accordingly.

[`GameTestsTaskBase`](/vintest/api/VinTest.Cake.GameTestsTaskBase_TContext_/) has _a lot_ of
extension points that you can tweak to suit your mod.
You are strongly encouraged to override those, but mostly it is supposed to Just Work by default.

## Run the New And Improved `CakeBuild` task

If this is your first time launching VS with this custom datapath, you should take a moment to
initialize the world.

```pwsh title="powershell" hl_lines="8"
dotnet run `
  --project ./CakeBuild `
  --target RunGameTests `
  -- `
    --vs-path "D:/VintageStory/1.22.2" `
    --data-path "../gamedata" `
    --test-world "autotest" `
    --manual-mode true
```

> See [Cake Task Reference](../guides/cake-ref.md) for in-depth explanation of properties and CLI args.

!!! tip

    Rather than passing `--vs-path` on every invocation, set the `VINTAGE_STORY` environment
    variable or add a `Directory.Build.props` at the solution root.
    See [Local Development — Using local Vintage Story installation](../guides/local-dev.md#using-local-vintage-story-installation).

!!! tip

    `gamedata` and `autotest` are default values for their parameters; so if you follow this naming
    convention you may omit them entirely.

The `--manual-mode true` argument will prevent `VinTest` from running tests any automation _yet_.
This will allow you to create a character, spawn in the world, and do any manual preparations that
your mod tests would require.

Once the world is in the desired state and you exited VS, copy
`<DataPath>/Saves/<TestWorldName>.vcdbs` to `<DataPath>/Saves/<TestWorldName>.vcdbs.orig`.
On every subsequent run, the task will restore the world from that `.orig` snapshot before launching
VS — so all tests would always start from the same known state.

Once ready, run the task in an automatic mode:

```pwsh title="powershell"
dotnet run `
  --project ./CakeBuild `
  --target RunGameTests `
  -- `
    --vs-path "D:/VintageStory/1.22.2" `
    --data-path "../gamedata" `
    --test-world "autotest" `
    # (1)!
```

1. No more `--manual-mode`.

With this, the cake task will:

- build both your main mod and the test mod
- launch VS with both mods active
- load the specified world
- wait for all test suites to finish, and for VS to exit
- parse the results from the `results.json` file that `VinTest` creates
- print a summary and some filtered logs

!!! info "Test by default"

    Most mods would also have some `[TaskName("Package")]` task to create a `.zip` archive with the
    mod to be published, and `[TaskName("Default")]` depending on it.
    If `Default` task is defined, you could run just
    `dotnet run --project CakeBuild` without specifying `--target`.
    <br>If this is your case, you should make either the `Package` or the `Default` task also
    depend on `RunGameTests`.
    This way you can't package a mod that fails tests.

## Next steps

If you use VS Code, see the [VS Code extension quickstart](vscode-extension.md) to surface test results
directly in the Test Explorer without leaving the editor.
