import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { PassThrough } from "stream";
import {
  resolveExtensionConfig,
  type WorkspaceConfig,
  type ProjectConfig,
} from "./config";
import { parseResults } from "./resultsParser";
import {
  waitOrCancel,
  waitForBuildTasks,
  shutdownBuildServers,
} from "./taskGuard";

// Serializes all dotnet invocations so at most one runs at a time.
// Prevents build-output conflicts with concurrent processes (e.g. C# Dev Kit
// discovery builds) and ensures only one VintageStory instance is ever alive.
let runQueue: Promise<void> = Promise.resolve();

export async function runHandler(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
  debug = false,
): Promise<void> {
  output.show(true);

  const run = controller.createTestRun(request);
  for (const item of includedItems(request, controller)) run.enqueued(item);

  const previous = runQueue;
  let release!: () => void;
  runQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    const config = await resolveExtensionConfig(output, debug);
    if (config === null) {
      output.appendLine("[VinTest] No project configured - test run skipped.");
      return;
    }

    // Give other test controllers (e.g. C# Dev Kit) time to start their builds.
    if (config.waitForOtherTests > 0) {
      await waitOrCancel(
        new Promise<void>((resolve) =>
          setTimeout(resolve, config.waitForOtherTests),
        ),
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

    // Determine which projects are needed for this request.
    const projectsToRun =
      !request.include || request.include.length === 0
        ? config.projects
        : config.projects.filter((p) =>
            request.include!.some(
              (item) => parentProjectOfItem(item) === p.projectRoot,
            ),
          );

    if (request.exclude && request.exclude.length > 0) {
      output.appendLine(
        "[VinTest] Warning: test exclusions are not supported and will be ignored.",
      );
    }

    // Run each project in sequence - never spawn two VintageStory instances.
    for (const project of projectsToRun) {
      if (token.isCancellationRequested) break;
      await runSingleProject(
        controller,
        run,
        request,
        config,
        project,
        debug,
        token,
        output,
      );
    }
  } catch (err) {
    output.appendLine(`\n[VinTest] Error: ${err}`);
    const msg = new vscode.TestMessage(String(err));
    for (const item of includedItems(request, controller)) {
      if (!item.children.size) run.errored(item, msg);
    }
  } finally {
    release();
    run.end();
  }
}

async function runSingleProject(
  controller: vscode.TestController,
  run: vscode.TestRun,
  request: vscode.TestRunRequest,
  wsConfig: WorkspaceConfig,
  project: ProjectConfig,
  debug: boolean,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
): Promise<void> {
  // Mark items belonging to this project as started.
  for (const item of projectItems(project.projectRoot, request, controller))
    run.started(item);

  const resultsPath = path.join(
    project.cakeDataPath,
    "TestResults",
    "results.json",
  );
  if (fs.existsSync(resultsPath)) fs.unlinkSync(resultsPath);

  const filter = buildFilterForProject(
    project.projectRoot,
    request.include ?? [],
  );
  const args = buildArgs(wsConfig, project, filter, debug);

  output.appendLine(`\n[VinTest] Running project: ${project.displayName}`);
  output.appendLine(`> dotnet ${args.join(" ")}`);
  if (filter) output.appendLine(`  (filter: "${filter}")`);
  output.appendLine("");

  const child = cp.spawn("dotnet", args, {
    stdio: "pipe",
    cwd: project.projectRoot,
  });

  // Merge stderr into stdout to avoid interleaved Cake log output.
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
    ? attachDebuggerWhenReady(project.pidFilePath, token, output)
    : undefined;

  token.onCancellationRequested(() => {
    output.appendLine("\n[VinTest] Run cancelled.");
    child.kill();
  });

  await waitForExit(child, token);
  stopDebugPoller?.();

  if (token.isCancellationRequested) return;

  if (fs.existsSync(resultsPath)) {
    await parseResults(resultsPath, controller, run, project.projectRoot);
  } else {
    const msg = new vscode.TestMessage(
      "Test run did not produce results.json - the process may have timed out or crashed. " +
        "See the VinTest output channel for details.",
    );
    for (const item of projectItems(project.projectRoot, request, controller)) {
      item.children.forEach((child) => run.errored(child, msg));
      run.errored(item, msg);
    }
  }
}

function buildArgs(
  wsConfig: WorkspaceConfig,
  project: ProjectConfig,
  filter: string | undefined,
  debug: boolean,
): string[] {
  const args = [
    "run",
    "--project",
    project.cakeProjectPath,
    "--",
    "--target",
    project.cakeTarget,
    "--configuration",
    wsConfig.cakeConfiguration,
    "--data-path",
    project.cakeDataPath,
  ];
  if (wsConfig.cakeVsPath) {
    args.push("--vs-path");
    args.push(wsConfig.cakeVsPath);
  }
  if (wsConfig.cakeIgnoreLogErrors) {
    args.push("--ignore-log-errors");
    args.push("true");
  }
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

/**
 * Return the top-level ancestor (project item) of any test item.
 */
function parentProjectOfItem(item: vscode.TestItem): string {
  let current = item;
  // project items are supposed to be topmost and will have no parent
  while (current.parent) current = current.parent;
  return current.id;
}

/**
 * Build the --test-filter value for a single project run.
 *
 * - No include list → no filter (run all)
 * - Project item included → no filter (run all in project)
 * - Suite item included → filter = suite label
 * - Method item included → filter = suite.method (parent label + "." + own label)
 */
function buildFilterForProject(
  projectRoot: string,
  includeItems: readonly vscode.TestItem[],
): string | undefined {
  // include had no items => run everything
  if (includeItems.length === 0) return undefined;

  const relevant = includeItems.filter(
    (item) => parentProjectOfItem(item) === projectRoot,
  );
  if (relevant.length === 0)
    // should be unreachable
    throw new Error(
      `No relevant items for ${projectRoot} in [${includeItems.map((i) => i.id).join(", ")}]`,
    );

  // include had project root itself => run everything
  if (relevant.some((item) => item.id === projectRoot)) return undefined;

  const filters = relevant.map((item) => {
    const isProjectItem = !item.parent;
    const isSuiteItem = item.parent && item.parent.id === projectRoot;
    if (isProjectItem || isSuiteItem) {
      // suite-level: filter by suite name
      return item.label;
    }
    // method-level: filter by SuiteName.MethodName
    return `${item.parent!.label}.${item.label}`;
  });
  return [...new Set(filters)].join(",");
}

/** Iterate all items covered by the request (or all items if no include). */
function* includedItems(
  request: vscode.TestRunRequest,
  controller: vscode.TestController,
): Generator<vscode.TestItem> {
  if (request.include && request.include.length > 0) {
    for (const item of request.include) yield* walkItems(item);
  } else {
    for (const [, item] of controller.items) yield* walkItems(item);
  }
}

/** Iterate all items belonging to a specific project that are covered by the request. */
function* projectItems(
  projectRoot: string,
  request: vscode.TestRunRequest,
  controller: vscode.TestController,
): Generator<vscode.TestItem> {
  const projectItem = controller.items.get(projectRoot);
  if (!projectItem) return;
  if (!request.include || request.include.length === 0) {
    yield* walkItems(projectItem);
  } else {
    for (const item of request.include) {
      if (parentProjectOfItem(item) === projectRoot) yield* walkItems(item);
    }
  }
}

function* walkItems(item: vscode.TestItem): Generator<vscode.TestItem> {
  yield item;
  for (const [, child] of item.children) yield* walkItems(child);
}
