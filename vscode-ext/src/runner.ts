import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { PassThrough } from "stream";
import {
  resolveExtensionConfig,
  getWaitForOtherTests,
  type RunConfig,
} from "./config";
import { parseResults } from "./resultsParser";

// Serializes all dotnet invocations so at most one runs at a time.
// Prevents build-output conflicts with concurrent processes (e.g. C# Dev Kit
// discovery builds) and queues multiple vintest suites correctly.
let runQueue: Promise<void> = Promise.resolve();

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

export async function runHandler(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
  debug = false,
): Promise<void> {
  output.show(true);

  const run = controller.createTestRun(request);
  markEnqueued(run, request, controller);

  const previous = runQueue;
  let release!: () => void;
  runQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    // Give other test controllers (e.g. C# Dev Kit) time to start their builds
    // before we begin checking for conflicting tasks. Runs in parallel for all
    // queued VinTest projects, so total wall-clock cost is one sleep, not N.
    const initialDelay = getWaitForOtherTests();
    if (initialDelay > 0) {
      await waitOrCancel(
        new Promise<void>((resolve) => setTimeout(resolve, initialDelay)),
        token,
      );
      if (token.isCancellationRequested) {
        output.appendLine("[VinTest] Run cancelled.");
        return;
      }
    }

    await waitOrCancel(previous, token);
    if (token.isCancellationRequested) {
      output.appendLine("[VinTest] Run cancelled.");
      return;
    }

    const waitedForTasks = await waitForBuildTasks(token, output);
    if (token.isCancellationRequested) {
      output.appendLine("[VinTest] Run cancelled.");
      return;
    }

    if (waitedForTasks) {
      await shutdownBuildServers(token, output);
      if (token.isCancellationRequested) {
        output.appendLine("[VinTest] Run cancelled.");
        return;
      }
    }

    output.clear();

    const runConfig = await resolveExtensionConfig(output, debug);
    if (runConfig === null) {
      output.appendLine("[VinTest] No project configured - test run skipped.");
      return;
    }

    const resultsPath = path.join(
      runConfig.dataPath,
      "TestResults",
      "results.json",
    );

    if (fs.existsSync(resultsPath)) {
      fs.unlinkSync(resultsPath);
    }

    markStarted(run, request, controller);

    const filter = buildFilter(request);
    if (request.exclude && request.exclude.length > 0) {
      output.appendLine(
        "[VinTest] Warning: test exclusions are not supported and will be ignored.",
      );
    }
    const args = buildArgs(runConfig, filter, debug);

    output.appendLine(`> dotnet ${args.join(" ")}`);
    if (filter) output.appendLine(`  (filter: "${filter}")`);
    output.appendLine("");

    const cwd = runConfig.workspaceRoot;
    const child = cp.spawn("dotnet", args, { stdio: "pipe", cwd });

    // Redirect stderr into stdout (2>&1) at the stream level.
    // Prevents interleaved output caused by Cake using different log levels on each stream.
    const merged = new PassThrough();
    child.stdout!.pipe(merged, { end: false });
    child.stderr!.pipe(merged, { end: false });
    let closedPipes = 0;
    const onPipeEnd = () => {
      if (++closedPipes === 2) merged.end();
    };
    child.stdout!.on("end", onPipeEnd);
    child.stderr!.on("end", onPipeEnd);
    merged.on("data", (d: Buffer) => output.append(d.toString()));

    const stopDebugPoller = debug
      ? attachDebuggerWhenReady(runConfig.pidFilePath, token, output)
      : undefined;

    token.onCancellationRequested(() => {
      output.appendLine("\n[VinTest] Run cancelled.");
      child.kill();
    });

    await waitForExit(child, token);
    stopDebugPoller?.();

    if (token.isCancellationRequested) return;

    if (fs.existsSync(resultsPath)) {
      await parseResults(resultsPath, controller, run);
    } else {
      const msg = new vscode.TestMessage(
        "Test run did not produce results.json - the process may have timed out or crashed. " +
          "See the VinTest output channel for details.",
      );
      markRunError(run, request, controller, msg);
    }
  } catch (err) {
    output.appendLine(`\n[VinTest] Error: ${err}`);
    const msg = new vscode.TestMessage(String(err));
    markRunError(run, request, controller, msg);
  } finally {
    release();
    run.end();
  }
}

function waitOrCancel(
  p: Promise<void>,
  token: vscode.CancellationToken,
): Promise<void> {
  return new Promise<void>((resolve) => {
    p.then(resolve);
    token.onCancellationRequested(resolve);
  });
}

// Waits until no VS Code task that could conflict with a dotnet build is running.
// Uses the reactive buildTaskCount maintained by initBuildTaskTracking(), so it
// correctly detects tasks that start while we are already waiting.
async function waitForBuildTasks(
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

// After a build task finishes, VBCSCompiler (the Roslyn compiler server it
// spawned) may still hold write locks on obj/ DLLs. Shutting down build
// servers explicitly releases those locks before we start our own build.
async function shutdownBuildServers(
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

function buildArgs(
  runConfig: RunConfig,
  filter: string | undefined,
  debug: boolean,
): string[] {
  const args = [
    "run",
    "--project",
    runConfig.cakeProjPath,
    "--",
    "--target",
    runConfig.cakeTarget,
    "--configuration",
    runConfig.configuration,
  ];
  if (runConfig.vsPath) {
    args.push("--vs-path");
    args.push(runConfig.vsPath);
  }
  if (runConfig.ignoreLogErrors) args.push("--ignore-log-errors");
  if (debug) {
    args.push("--test-timeout");
    args.push("0");
  }
  if (filter) {
    args.push("--test-filter");
    args.push(filter);
  }
  return args;
}

/**
 * Determine the `--test-filter` value from the run request.
 *
 * The C# runner supports comma-separated values, each matched as a
 * case-insensitive substring against `SuiteName.CaseName`.
 *
 * - No include / empty: no filter (run all)
 * - One or more items: join their ids with `,`
 *   Suite item id = `SuiteName`  → matches all tests in that suite
 *   Test item id  = `Suite.Name` → matches that specific test
 */
function buildFilter(request: vscode.TestRunRequest): string | undefined {
  const items = request.include;
  if (!items || items.length === 0) return undefined;
  return items.map((i) => i.id).join(",");
}

function markEnqueued(
  run: vscode.TestRun,
  request: vscode.TestRunRequest,
  controller: vscode.TestController,
): void {
  if (!request.include || request.include.length === 0) {
    controller.items.forEach((suite) => {
      run.enqueued(suite);
      suite.children.forEach((test) => run.enqueued(test));
    });
    return;
  }
  for (const item of request.include) {
    run.enqueued(item);
    item.children.forEach((child) => run.enqueued(child));
  }
}

function markStarted(
  run: vscode.TestRun,
  request: vscode.TestRunRequest,
  controller: vscode.TestController,
): void {
  if (!request.include || request.include.length === 0) {
    controller.items.forEach((suite) => {
      run.started(suite);
      suite.children.forEach((test) => run.started(test));
    });
    return;
  }
  for (const item of request.include) {
    run.started(item);
    item.children.forEach((child) => run.started(child));
  }
}

function markRunError(
  run: vscode.TestRun,
  request: vscode.TestRunRequest,
  controller: vscode.TestController,
  message: vscode.TestMessage,
): void {
  let suites: vscode.TestItem[];
  if (request.include) {
    suites = [...new Set(request.include.map((i) => i.parent ?? i))];
  } else {
    suites = [];
    controller.items.forEach((i) => suites.push(i));
  }
  for (const suite of suites) {
    run.errored(suite, message);
    suite.children.forEach((child) => run.skipped(child));
  }
}

function waitForExit(
  child: cp.ChildProcess,
  token: vscode.CancellationToken,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    child.on("close", finish);
    token.onCancellationRequested(finish);
  });
}

function attachDebuggerWhenReady(
  pidFilePath: string,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
): () => void {
  const poll = setInterval(async () => {
    if (token.isCancellationRequested) {
      clearInterval(poll);
      return;
    }
    if (!fs.existsSync(pidFilePath)) return;

    clearInterval(poll);
    const pidStr = fs.readFileSync(pidFilePath, "utf8").trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) {
      output.appendLine("[VinTest] Debug: PID file contained invalid value.");
      return;
    }
    output.appendLine(`[VinTest] Attaching debugger to PID ${pid}...`);
    const folder = vscode.workspace.workspaceFolders?.[0];
    const attached = await vscode.debug.startDebugging(folder, {
      type: "coreclr",
      request: "attach",
      name: "VinTest: Attach to VintageStory",
      processId: pid,
      justMyCode: false,
      requireExactSource: false,
      symbolOptions: {
        searchPaths: [`\${workspaceFolder}/**`],
      },
    });
    if (attached) {
      output.appendLine("[VinTest] Debugger attached.");
    } else {
      output.appendLine("[VinTest] Debug: startDebugging returned false.");
    }
  }, 500);
  return () => clearInterval(poll);
}
