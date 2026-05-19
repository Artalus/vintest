# VS Code Extension Reference

This guide covers how the VinTest VS Code extension works, its available settings, and known quirks.

> For installation and basic usage, see [VS Code Extension](../quickstart/vscode-extension.md).

## How it works

The extension activates in any workspace that contains `.cs` files.
On activation, it scans all `.cs` files for `[GameTestSuite]` / `[GameTest]` attributes and
populates the Test Explorer tree with the discovered suites and cases.

When you click **Run** or **Debug** on a test, the extension runs the Cake project associated
with that test:

```
dotnet run --project <CakeBuildProject> --target <CakeTarget> -- --test-filter
```

After VS exits and the Cake task finishes, the extension reads `TestResults/results.json` and
updates pass/fail statuses in the Test Explorer, generating clickable links to the assertion
source location on failure.

## Project discovery

By default, the extension auto-detects all Cake projects in the workspace by looking for
`.csproj` files that reference `VinTest.Cake`.

You can override this with the `vintest.projects` setting if the auto-detection somehow does not
work for your layout.

## Settings reference

### `vintest.projects`

**Type:** array of objects | **Default:** `[]`

User-provided list of VinTest projects.

If empty, the extension will try to auto-detect all Cake projects in the workspace.
The search criteria is as simple as ("`.csproj` file that mentions `VinTest.Cake` anywhere
in its contents).

Each entry must have `cakeBuildProject`; the other fields are optional:

```json
"vintest.projects": [
    {
        "cakeBuildProject": "D:/git/vs/MyMod/CakeBuild/CakeBuild.csproj", // (1)!
        "cake.dataPath": "D:/git/vs/MyMod/gamedata", // (1)!
        "cake.target": "RunGameTests"
    }
]
```

1. Path must be absolute.

!!! note

    While this setting is active, the extension will **not** auto-detect new projects in the workspace.

### `vintest.cake.vsPath`

**Type:** string | **Default:** `null`

Absolute path to the VintageStory installation directory, passed as
[`--vs-path`](cake-ref.md#cli-arguments-reference) to the Cake task.

See [Local Development — Using local Vintage Story installation](local-dev.md#using-local-vintage-story-installation)

### `vintest.cake.configuration`

**Type:** string | **Default:** `"Release"`

Dotnet build configuration passed as [`--configuration`](cake-ref.md#cli-arguments-reference)

!!! note "This setting is **ignored when debugging tests**"

    The debugger always uses `Debug` configuration so that debug symbols are available.

### `vintest.cake.ignoreLogErrors`

**Type:** boolean | **Default:** `false`

Mirrors the
[`--ignore-log-errors`](cake-ref.md#cli-arguments-reference) argument.

### `vintest.waitForOtherTests`

**Type:** number (milliseconds) | **Default:** `0`

Milliseconds to wait after a run is requested before actually
starting the Cake task (see [below](#conflicts-with-other-test-controllers)).

## Known issues

### Conflicts with other test controllers

If your workspace contains regular unit tests (MSTest/xUnit/NUnit) that another extension
(such as [C# Dev Kit](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit)
or [DotRush](https://marketplace.visualstudio.com/items?itemName=nromanov.dotrush))
handles, ==VinTest will conflict with it==.

The two test controllers will call `dotnet build` + `dotnet run` on the same projects
simultaneously, and their two processes will race over the same output DLLs.

Setting `"vintest.waitForOtherTests": 5000` delays VinTest controller startup by 5 seconds,
so it has a better chance to detect any concurrent `dotnet build` process and wait for it
to finish first, before calling `dotnet run`.

### Multiple mods in one workspace

When your workspace contains multiple mods, the extension spins up a separate
`dotnet run --project CakeBuild` for each detected mod, each using its own `gamedata/`
directory by default.
This causes VintageStory's session authorization to prompt you to re-login for every new VS
launch, because each new data directory starts without valid login information.

**Workaround 1 — shared data path**

Configure all projects to use the same `--data-path` via the per-project `cake.dataPath` field:

```json
"vintest.projects": [
    {
        "cakeBuildProject": "D:/git/vs/ModA/CakeBuild/CakeBuild.csproj",
        "cake.dataPath": "D:/git/vs/shared-gamedata"
    },
    {
        "cakeBuildProject": "D:/git/vs/ModB/CakeBuild/CakeBuild.csproj",
        "cake.dataPath": "D:/git/vs/shared-gamedata"
    }
]
```

This avoids repeated logins but may cause unexpected interactions if the mods share world
state.

**Workaround 2 — copy session credentials**

Copy the `sessionkey`, `sessionsignature`, and `useremail` values from the most recently used
`clientsettings.json` into the `clientsettings.json` of every mod's `gamedata/` directory.

VS uses these to skip the login prompt.
Your password is never stored — only the (temporary) session details are.
VS may expire them at any time; if that happens, just log in once and copy the values again.

#### How session invalidation works (presumably):

- You launch VS with a **new** data path `A/` — no session info, so you log in.
- VS issues session №1, stored in `A/clientsettings.json`.
- You launch VS with a **different new** data path `B/` — no session info there either, login.
- VS issues session №2 **and invalidates №1**.
- Now `A/` has expired credentials — you have to log in again.
- VS would issues session №3, invalidating №2, and the cycle repeats.
- Once you copy the fresh session from `B/` back into `A/`, both directories share the same
    valid session and VS starts without asking for a password.
