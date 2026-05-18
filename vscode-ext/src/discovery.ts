import * as vscode from "vscode";

const GAMETEST_SUITE_MARKER = "[GameTestSuite]";
const GAMETEST_MARKER = "[GameTest]";
const CLASS_REGEX = /class\s+(\w+)/;
const METHOD_REGEX = /public\s+IEnumerable<TestStep>\s+(\w+)\s*\(/;

interface TestMethod {
  name: string;
  line: number;
}

interface SuiteInfo {
  className: string;
  methods: TestMethod[];
  uri: vscode.Uri;
}

function deleteWhere(
  collection: vscode.TestItemCollection,
  predicate: (id: string, item: vscode.TestItem) => boolean,
): void {
  const toDelete: string[] = [];
  for (const [id, item] of collection) {
    if (predicate(id, item)) toDelete.push(id);
  }
  toDelete.forEach((id) => collection.delete(id));
}

export interface ProjectInfo {
  projectRoot: string;
  displayName: string;
}

/**
 * Discovers all test suites for every given project and populates the controller.
 * Each project becomes a top-level TestItem; suites and methods are nested under it.
 */
export async function discoverAll(
  controller: vscode.TestController,
  projects: ProjectInfo[],
  output?: vscode.OutputChannel,
): Promise<void> {
  // Remove project items whose workspaceRoot is no longer in the list.
  const activeRoots = new Set(projects.map((p) => p.projectRoot));
  deleteWhere(controller.items, (id) => !activeRoots.has(id));

  for (const { projectRoot, displayName } of projects) {
    // Reuse existing project item to preserve VS Code gutter state.
    let projectItem = controller.items.get(projectRoot);
    if (!projectItem) {
      projectItem = controller.createTestItem(projectRoot, displayName);
      projectItem.canResolveChildren = false;
      controller.items.add(projectItem);
    } else {
      projectItem.label = displayName;
    }

    const base = vscode.Uri.file(projectRoot);
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(base, "**/*.cs"),
      "{**/bin/**,**/obj/**,**/node_modules/**}",
    );
    output?.appendLine(
      `[VinTest] Found ${files.length} .cs file(s) under ${projectRoot} (${displayName})`,
    );
    await Promise.all(
      files.map((uri) => discoverInFile(controller, projectItem!, uri)),
    );
  }
}

/**
 * Scans a single C# file for test suites and registers/updates them under the
 * appropriate project TestItem (identified by the file path being within its workspaceRoot).
 */
export async function discoverInFile(
  controller: vscode.TestController,
  projectItem: vscode.TestItem,
  uri: vscode.Uri,
): Promise<void> {
  let text: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    text = Buffer.from(bytes).toString("utf8");
  } catch {
    return;
  }

  if (
    !text.includes(GAMETEST_SUITE_MARKER) ||
    !text.includes(GAMETEST_MARKER)
  ) {
    // File no longer has any test suites; clean up any previously discovered items.
    deleteWhere(
      projectItem.children,
      (_, item) => item.uri?.toString() === uri.toString(),
    );
    return;
  }

  const suites = parseFile(text, uri);

  // Remove suite items from this file that no longer exist after re-parse.
  const newSuiteNames = new Set(suites.map((s) => s.className));
  deleteWhere(
    projectItem.children,
    (id, item) =>
      item.uri?.toString() === uri.toString() && !newSuiteNames.has(id),
  );

  for (const info of suites) {
    let suiteItem = projectItem.children.get(info.className);
    if (!suiteItem) {
      suiteItem = controller.createTestItem(
        info.className,
        info.className,
        uri,
      );
      suiteItem.canResolveChildren = false;
      projectItem.children.add(suiteItem);
    }

    // Remove child items that no longer exist.
    const newMethodIds = new Set(
      info.methods.map((m) => `${info.className}.${m.name}`),
    );
    deleteWhere(suiteItem.children, (id) => !newMethodIds.has(id));

    // Update ranges of existing children; create new ones as needed.
    for (const method of info.methods) {
      const testId = `${info.className}.${method.name}`;
      let testItem = suiteItem.children.get(testId);
      if (!testItem) {
        testItem = controller.createTestItem(testId, method.name, uri);
        suiteItem.children.add(testItem);
      }
      testItem.range = new vscode.Range(method.line, 0, method.line, 0);
    }
  }
}

function stripLine(
  raw: string,
  inBlock: boolean,
): { effective: string; inBlock: boolean } {
  let effective = "";
  let j = 0;
  while (j < raw.length) {
    if (inBlock) {
      if (raw[j] === "*" && raw[j + 1] === "/") {
        inBlock = false;
        j += 2;
      } else {
        j++;
      }
    } else {
      if (raw[j] === "/" && raw[j + 1] === "*") {
        inBlock = true;
        j += 2;
      } else if (raw[j] === "/" && raw[j + 1] === "/") {
        break;
      } else {
        effective += raw[j];
        j++;
      }
    }
  }
  return { effective, inBlock };
}

function parseFile(text: string, uri: vscode.Uri): SuiteInfo[] {
  const lines = text.split("\n");
  const suites: SuiteInfo[] = [];
  let pendingSuite: { className: string; methods: TestMethod[] } | null = null;
  let inBlockComment = false;
  let ifFalseDepth = 0;

  const commitPending = () => {
    if (pendingSuite && pendingSuite.methods.length > 0) {
      suites.push({ ...pendingSuite, uri });
    }
    pendingSuite = null;
  };

  for (let i = 0; i < lines.length; i++) {
    // Strip block-comment spans and line-comment tails, tracking state across lines.
    const { effective, inBlock: nextBlock } = stripLine(
      lines[i],
      inBlockComment,
    );
    inBlockComment = nextBlock;

    // Handle #if false / #if 0 preprocessor blocks.
    const pp = effective.trim();
    if (ifFalseDepth > 0) {
      if (/^#if\b/.test(pp)) ifFalseDepth++;
      else if (/^#endif\b/.test(pp)) ifFalseDepth--;
      continue;
    }
    if (/^#if\s+(false|0)\b/.test(pp)) {
      ifFalseDepth = 1;
      continue;
    }

    if (effective.includes(GAMETEST_SUITE_MARKER)) {
      commitPending();
      let lookBlock = inBlockComment;
      for (let k = i + 1; k < lines.length; k++) {
        const { effective: eff, inBlock: lb } = stripLine(lines[k], lookBlock);
        lookBlock = lb;
        const m = CLASS_REGEX.exec(eff);
        if (m) {
          pendingSuite = { className: m[1], methods: [] };
          break;
        }
      }
    }

    if (pendingSuite && effective.includes(GAMETEST_MARKER)) {
      let lookBlock = inBlockComment;
      for (let k = i + 1; k < lines.length; k++) {
        const { effective: eff, inBlock: lb } = stripLine(lines[k], lookBlock);
        lookBlock = lb;
        const trimmed = eff.trim();
        if (!trimmed) continue;
        const m = METHOD_REGEX.exec(trimmed);
        if (m) {
          pendingSuite.methods.push({ name: m[1], line: k });
        }
        break;
      }
    }
  }

  commitPending();
  return suites;
}

/**
 * Creates one FileSystemWatcher per project root and returns them all.
 * Each watcher re-discovers test items when .cs files change within that root.
 */
export function setupFileWatchers(
  controller: vscode.TestController,
  projects: ProjectInfo[],
): vscode.FileSystemWatcher[] {
  return projects.map(({ projectRoot: workspaceRoot }) => {
    const base = vscode.Uri.file(workspaceRoot);
    const pattern = new vscode.RelativePattern(base, "**/*.cs");
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const getProjectItem = () => controller.items.get(workspaceRoot);

    watcher.onDidChange((uri) => {
      const pi = getProjectItem();
      if (pi) discoverInFile(controller, pi, uri).catch(console.error);
    });
    watcher.onDidCreate((uri) => {
      const pi = getProjectItem();
      if (pi) discoverInFile(controller, pi, uri).catch(console.error);
    });
    watcher.onDidDelete((uri) => {
      const pi = getProjectItem();
      if (pi) {
        deleteWhere(
          pi.children,
          (_, item) => item.uri?.toString() === uri.toString(),
        );
      }
    });

    return watcher;
  });
}
