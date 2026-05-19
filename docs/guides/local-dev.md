# Local Development

This guide explains how to work with a local copy of VinTest components rather than
NuGet/VSIX versions — useful when you are developing VinTest itself or testing
unreleased changes.

## Using local Vintage Story installation

The convention among mod projects is that instead of hardcoding `C:/Path/To/Your/VintageStory/`,
in your `.csproj`s, you should use `VINTAGE_STORY` property pointing to _your own local_
Vintage Story installation directory (the one that contains `VintagestoryAPI.dll`).

!!! abstract "Why?"

    This makes life easier for other developers if you share your project sources (f.x. on GitHub).

    If you hardcode your local paths everywhere, then just by getting sources of your mod folks
    would end up with already invalid paths.
    Which they'd have to amend for themselves right away.
    And by doing so, they immediately risk breaking the setup _for you_,
    if they decide to propose changes to your mod back (through pull requests), and the changes
    accidentally include the amended paths.

    ```xml
    <Reference Include="VintagestoryAPI">
        <!-- BAD: expects people to have disk E:, have exactly VS 1.21.7, have it installed exactly there -->
        <HintPath>E:/Games/VintageStoryManaged/1.21.7/VintagestoryAPI.dll</HintPath>
        <!-- BAD: expects to have VS exactly three directories above the mod workspace -->
        <HintPath>../../../VintageStory/VintagestoryAPI.dll</HintPath>
        <!-- GOOD: everyone decide for themselves where their VS is -->
        <HintPath>$(VINTAGE_STORY)/VintagestoryAPI.dll</HintPath>
    ```

To fill this property with a value, you can:

- use [`dotnet build -p` flag](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build);
- or set up
    [environment variable](https://wiki.vintagestory.at/Modding:Setting_up_your_Development_Environment#Setup_the_Environment)
    with the same name;
- or provide
    [`Directory.Build.props`](https://learn.microsoft.com/en-us/visualstudio/msbuild/customize-by-directory?view=visualstudio)
    file that all `dotnet` commands would pick up automatically.

```xml title="Directory.Build.props" linenums="1" hl_lines="3"
<Project>
  <PropertyGroup>
    <VINTAGE_STORY>C:/Path/To/Your/VintageStory/</VINTAGE_STORY>
  </PropertyGroup>
</Project>
```

!!! note "Ignore that!"

    This file contains a local path that will be different for everyone, so add it to `.gitignore`.

If multiple values are provided for property `X`, dotnet resolves them in this order:

- environment variable `X=1` is used as a fallback if everything else fails
- —> it is overridden with `<X>2</X>` value from `.props` file, if present
- — —> if `.csproj` defines its own `<X>3</X>`, it is used instead of the value from `.props`
- — — —> if the build is triggered with flag `-p X=4`, it overrides everything else

!!! info "Same thing for `VinTest.Cake`"

    `--vs-path` falls in the same steps:

    - envvar `VINTAGE_STORY` is used as fallback
    - `<VINTAGE_STORY>` from `Directory.Build.props` is read, if present
    - both are overriden by explicitly providing `--vs-path` argument to `dotnet run`

## Using local VinTest builds

The cleanest approach is to add a
[`Directory.Build.targets`](https://learn.microsoft.com/en-us/visualstudio/msbuild/customize-by-directory?view=visualstudio)
file (and add it to `.gitignore`), swapping the NuGet package references for local project references:

```xml title="Directory.Build.targets" linenums="1" hl_lines="3 4 8 9"
<Project>
  <ItemGroup Condition="'$(MSBuildProjectName)' == 'YourMod.gametests'">
    <PackageReference Remove="VinTest" />
    <ProjectReference Include="../vintest/VinTest/VinTest.csproj" />
  </ItemGroup>

  <ItemGroup Condition="'$(MSBuildProjectName)' == 'CakeBuild'">
    <PackageReference Remove="VinTest.Cake" />
    <ProjectReference Include="../vintest/VinTest.Cake/VinTest.Cake.csproj" />
  </ItemGroup>
</Project>
```

Each `<ItemGroup>` targets a specific project by name:

- `'$(MSBuildProjectName)' == 'YourMod.gametests'` — matches the gametests project.
- `'$(MSBuildProjectName)' == 'CakeBuild'` — matches the Cake build project.

Adjust the `Include` paths to point to wherever your `vintest/` directory is relative to
the mod workspace.

When you are done with local development and want to go back to NuGet versions, simply delete
the `Directory.Build.targets` file or comment out its contents.

## Building the VS Code extension from source

```
cd vscode-ext
npm install
npm run compile
```

After successfully building the extension, install it in VS Code via the
`Developer: Install Extension from Location...` command, pointing it at the `vscode-ext/` directory.

After each recompile, reload the VS Code window (`Developer: Reload Window`) to pick up the
updated extension code.

Instead, you can use `npm run watch` to trigger automatic recompilation every time
a `.ts` file changes.
