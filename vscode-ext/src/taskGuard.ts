import * as cp from "child_process";
import * as vscode from "vscode";

// Reactive count of VS Code tasks that could conflict with a dotnet build.
// Maintained by initBuildTaskTracking(), called once from extension.ts activate().
let buildTaskCount = 0;
const buildTaskEmitter = new vscode.EventEmitter<void>();

// Wire up task lifecycle listeners. Must be called once during extension activation
// so the counter is accurate for the entire extension lifetime.
export function initBuildTaskTracking(context: vscode.ExtensionContext): void {
  buildTaskCount = vscode.tasks.taskExecutions.filter(isConflictingTask).length;
  context.subscriptions.push(
    buildTaskEmitter,
    vscode.tasks.onDidStartTask((e) => {
      if (isConflictingTask(e.execution)) {
        buildTaskCount++;
        buildTaskEmitter.fire();
      }
    }),
    vscode.tasks.onDidEndTask((e) => {
      if (isConflictingTask(e.execution)) {
        buildTaskCount = Math.max(0, buildTaskCount - 1);
        buildTaskEmitter.fire();
      }
    }),
  );
}

export function waitOrCancel(
  p: Promise<void>,
  token: vscode.CancellationToken,
): Promise<void> {
  return new Promise<void>((resolve) => {
    p.then(resolve);
    token.onCancellationRequested(resolve);
  });
}

export async function waitForBuildTasks(
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
): Promise<boolean> {
  let waited = false;
  while (buildTaskCount > 0 && !token.isCancellationRequested) {
    waited = true;
    const names = vscode.tasks.taskExecutions
      .filter(isConflictingTask)
      .map((e) => e.task.name)
      .join(", ");
    output.appendLine(`[VinTest] Waiting for task(s) to finish: ${names}`);
    await waitOrCancel(
      new Promise<void>((resolve) => {
        const sub = buildTaskEmitter.event(() => {
          sub.dispose();
          resolve();
        });
      }),
      token,
    );
  }
  return waited;
}

export async function shutdownBuildServers(
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
): Promise<void> {
  output.appendLine(
    "[VinTest] Shutting down build servers to release file locks...",
  );
  await waitOrCancel(
    new Promise<void>((resolve) => {
      cp.exec("dotnet build-server shutdown", () => resolve());
    }),
    token,
  );
}

function isConflictingTask(exec: vscode.TaskExecution): boolean {
  const task = exec.task;
  return (
    task.definition.type === "dotnet" ||
    task.source === "dotnet" ||
    task.name.toLowerCase().includes("build")
  );
}
