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

export async function discoverAll(
  controller: vscode.TestController,
  workspaceRoot?: string,
  output?: vscode.OutputChannel,
): Promise<void> {
  const base = workspaceRoot ? vscode.Uri.file(workspaceRoot) : undefined;
  const pattern: vscode.GlobPattern = base
    ? new vscode.RelativePattern(base, "**/*.cs")
    : "**/*.cs";
  const files = await vscode.workspace.findFiles(
    pattern,
    "{**/bin/**,**/obj/**,**/node_modules/**}",
  );
  output?.appendLine(
    `[VinTest] Found ${files.length} .cs file(s) under ${workspaceRoot ?? "workspace"}`,
  );
  await Promise.all(files.map((uri) => discoverInFile(controller, uri)));
}

export async function discoverInFile(
  controller: vscode.TestController,
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
      controller.items,
      (_, item) => item.uri?.toString() === uri.toString(),
    );
    return;
  }

  const suites = parseFile(text, uri);

  // Remove suite items from this file that no longer exist after re-parse.
  const newSuiteNames = new Set(suites.map((s) => s.className));
  deleteWhere(
    controller.items,
    (id, item) =>
      item.uri?.toString() === uri.toString() && !newSuiteNames.has(id),
  );

  for (const info of suites) {
    // Reuse the existing suite item when possible so VS Code can track range
    // updates in place. Deleting and re-creating items with the same ID causes
    // gutter decorations to stop updating until the editor is reopened.
    let suiteItem = controller.items.get(info.className);
    if (!suiteItem) {
      suiteItem = controller.createTestItem(
        info.className,
        info.className,
        uri,
      );
      suiteItem.canResolveChildren = false;
      controller.items.add(suiteItem);
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

export function setupFileWatcher(
  controller: vscode.TestController,
  workspaceRoot?: string,
): vscode.FileSystemWatcher {
  const base = workspaceRoot ? vscode.Uri.file(workspaceRoot) : undefined;
  const pattern: vscode.GlobPattern = base
    ? new vscode.RelativePattern(base, "**/*.cs")
    : "**/*.cs";
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  watcher.onDidChange((uri) =>
    discoverInFile(controller, uri).catch(console.error),
  );
  watcher.onDidCreate((uri) =>
    discoverInFile(controller, uri).catch(console.error),
  );
  watcher.onDidDelete((uri) => {
    deleteWhere(
      controller.items,
      (_, item) => item.uri?.toString() === uri.toString(),
    );
  });

  return watcher;
}
