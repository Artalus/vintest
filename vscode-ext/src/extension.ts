import * as vscode from "vscode";
import { resolveExtensionConfig, type RunConfig } from "./config";
import { discoverAll, setupFileWatcher } from "./discovery";
import { runHandler } from "./runner";

export function activate(context: vscode.ExtensionContext): void {
  const controller = vscode.tests.createTestController("vintest", "VinTest");
  context.subscriptions.push(controller);

  const output = vscode.window.createOutputChannel("VinTest");
  context.subscriptions.push(output);

  let watcher: vscode.FileSystemWatcher | undefined;
  // Dispose watcher on extension deactivation regardless of how it was created.
  context.subscriptions.push({ dispose: () => watcher?.dispose() });

  async function runDiscovery(): Promise<void> {
    let config: RunConfig | null;
    try {
      config = await resolveExtensionConfig(output, false);
    } catch (err) {
      vscode.window.showErrorMessage(`VinTest: ${err}`);
      return;
    }
    if (config === null) return;
    // Config resolved - tear down previous watcher and clear stale items.
    watcher?.dispose();
    watcher = undefined;
    controller.items.replace([]);
    output.appendLine(`[VinTest] Discovering in: ${config.workspaceRoot}`);
    await discoverAll(controller, config.workspaceRoot, output);
    let suiteCount = 0;
    let methodCount = 0;
    controller.items.forEach((suite) => {
      suiteCount++;
      suite.children.forEach(() => methodCount++);
    });
    output.appendLine(
      `[VinTest] Discovery complete: ${suiteCount} suite(s), ${methodCount} method(s)`,
    );
    watcher = setupFileWatcher(controller, config.workspaceRoot);
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
