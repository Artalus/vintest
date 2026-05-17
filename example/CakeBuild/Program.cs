using System.Collections.Generic;
using System.IO;
using Cake.Common.IO;
using Cake.Core;
using Cake.Core.Diagnostics;
using Cake.Frosting;
using VinTest.Cake;

namespace CakeBuild;

// This will stay the same as in default CakeBuild template.
public static class Program
{
    public static int Main(string[] args) => new CakeHost().UseContext<BuildContext>().Run(args);
}

// Your build context must inherit from VinTest's base that provides common properties and methods
// for the tests task.
public class BuildContext : ContextBase
{
    // At the very least, you will need to provide the name of your main mod's project
    public override string ProjectName => "MyMod";

    // This is the default "convention", but you may choose a different name for your tests project.
    // Beware that it will mess with vscode extension defaults too.
    // public override string AutotestsProjectName => $"{ProjectName}.gametests";

    public BuildContext(ICakeContext context)
        : base(context)
    {
        // modinfo parsing and other initialization can be done here
    }
}

// You can use any name for your task, but this is the default that vscode extension will look for.
// Note the lack of IsDependentOn("Build") - base class has its own Build() method.
[TaskName("RunGameTests")]
public sealed class RunGameTestsTask : GameTestsTaskBase<BuildContext>
{
    // You are advised to prefix log messages in your mod, so you can capture them here
    protected override string[] AdditionalLogCapture => ["MyModTest", "MyMod"];

    protected override IEnumerable<(string Pattern, LogLevel? TargetLevel)> LogSuppressions =>
        [
            ("you can disable something if you are sure it is not related to your mod", null),
            ("or promote something if you know it indicates an issue", LogLevel.Error),
        ];

    protected override IEnumerable<string> GetAssetsPaths(BuildContext context) =>
        [
            // Default value is `../{context.ProjectName}/assets`.
            // If your assets are in a different directory, return the path(s) here.
            // If your mod does not have assets, you need to explicitly return an empty list here.
        ];

    // This method is called before Build(); you can do all necessary cleanup here, create config
    // files for your mod, and so on.
    protected override void Prepare(BuildContext context)
    {
        var configDir = Path.Combine(context.DataPath, "ModConfig");
        context.EnsureDirectoryExists(configDir);
        File.WriteAllText(
            Path.Combine(configDir, "MyModConfig.json"),
            @"{
                ""create a custom config"": ""for your mod"",
                ""if it needs"": 1
            }"
        );
    }
}

// `dotnet run --project CakeBuild` without `--target` will look for task named `Default`.
// It is up to you if you want to run tests by default, or have a `Package` default task depending
// on `RunGameTests`, or do something entirely different.
[TaskName("Default")]
[IsDependentOn(typeof(RunGameTestsTask))]
public class DefaultTask : FrostingTask { }
