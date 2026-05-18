import * as vscode from "vscode";
import { resolveExtensionConfig } from "./config";
import { discoverAll, setupFileWatchers, type ProjectInfo } from "./discovery";
import { runHandler } from "./runner";
import { initBuildTaskTracking } from "./taskGuard";

export function activate(context: vscode.ExtensionContext): void {
  const controller = vscode.tests.createTestController("vintest", "VinTest");
  context.subscriptions.push(controller);

  const output = vscode.window.createOutputChannel("VinTest");
  context.subscriptions.push(output);

  initBuildTaskTracking(context);

  let watchers: vscode.FileSystemWatcher[] = [];
  context.subscriptions.push({
    dispose: () => watchers.forEach((w) => w.dispose()),
  });

  async function runDiscovery(): Promise<void> {
    let wsConfig;
    try {
      wsConfig = await resolveExtensionConfig(output, false);
    } catch (err) {
      vscode.window.showErrorMessage(`VinTest: ${err}`);
      return;
    }

    // Tear down previous watchers and clear stale items.
    watchers.forEach((w) => w.dispose());
    watchers = [];
    controller.items.replace([]);

    if (wsConfig === null) return;

    const projects: ProjectInfo[] = wsConfig.projects.map((p) => ({
      projectRoot: p.projectRoot,
      displayName: p.displayName,
    }));

    output.appendLine(
      `[VinTest] Discovering tests across ${projects.length} project(s)...`,
    );
    await discoverAll(controller, projects, output);

    let suiteCount = 0;
    let methodCount = 0;
    controller.items.forEach((projectItem) => {
      projectItem.children.forEach((suite) => {
        suiteCount++;
        suite.children.forEach(() => methodCount++);
      });
    });
    output.appendLine(
      `[VinTest] Discovery complete: ${suiteCount} suite(s), ${methodCount} method(s)`,
    );

    watchers = setupFileWatchers(controller, projects);
  }

  controller.resolveHandler = () => runDiscovery();
  controller.refreshHandler = (_token) => runDiscovery();

  controller.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    (request, token) => runHandler(controller, request, token, output),
    /* isDefault */ true,
  );

  controller.createRunProfile(
    "Debug",
    vscode.TestRunProfileKind.Debug,
    (request, token) =>
      runHandler(controller, request, token, output, /* debug */ true),
    /* isDefault */ false,
  );
}

export function deactivate(): void {}
