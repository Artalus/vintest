import * as vscode from "vscode";

interface AssertionInfo {
  Name: string;
  Passed: boolean;
  Location?: string;
}

interface TestCaseInfo {
  Name: string;
  Passed: boolean;
  DurationMs: number;
  ExceptionMessage?: string;
  ExceptionLocation?: string;
  Assertions: AssertionInfo[];
}

interface TestSuiteInfo {
  SuiteName: string;
  Passed: boolean;
  TestCases: TestCaseInfo[];
}

interface TestRunInfo {
  Passed: boolean;
  Suites: TestSuiteInfo[];
}

export async function parseResults(
  resultsPath: string,
  controller: vscode.TestController,
  run: vscode.TestRun,
): Promise<void> {
  const bytes = await vscode.workspace.fs.readFile(
    vscode.Uri.file(resultsPath),
  );
  const raw = Buffer.from(bytes).toString("utf8");
  let data: TestRunInfo;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `results.json is not valid JSON - the process may have crashed mid-write. ` +
        `See the VinTest output channel for details.`,
    );
  }

  for (const suite of data.Suites) {
    for (const tc of suite.TestCases) {
      const item = findTestItem(controller, suite.SuiteName, tc.Name);
      if (!item) continue;

      if (tc.Passed) {
        run.passed(item, tc.DurationMs);
      } else {
        run.failed(item, buildFailMessage(tc), tc.DurationMs);
      }
    }
  }
}

function buildFailMessage(tc: TestCaseInfo): vscode.TestMessage {
  if (tc.ExceptionMessage) {
    const msg = new vscode.TestMessage(tc.ExceptionMessage);
    if (tc.ExceptionLocation) {
      const loc = parseLocation(tc.ExceptionLocation);
      if (loc) msg.location = loc;
    }
    return msg;
  }

  const failedAssertion = tc.Assertions.find((a) => !a.Passed);
  if (!failedAssertion) {
    return new vscode.TestMessage(
      "Test failed (no assertion details available)",
    );
  }

  const message = new vscode.TestMessage(
    `Assertion failed: ${failedAssertion.Name}`,
  );

  if (failedAssertion.Location) {
    const loc = parseLocation(failedAssertion.Location);
    if (loc) message.location = loc;
  }

  return message;
}

function findTestItem(
  controller: vscode.TestController,
  suiteName: string,
  caseName: string,
): vscode.TestItem | undefined {
  const suiteItem = controller.items.get(suiteName);
  if (!suiteItem) return undefined;
  return suiteItem.children.get(`${suiteName}.${caseName}`);
}

function parseLocation(location: string): vscode.Location | undefined {
  // Format produced by [CallerFilePath] + [CallerLineNumber]: "D:\path\to\file.cs:42"
  // Use lastIndexOf to safely skip the drive letter colon on Windows
  const lastColon = location.lastIndexOf(":");
  if (lastColon < 2) return undefined; // < 2 guards against bare drive letter

  const filePath = location.substring(0, lastColon);
  const lineStr = location.substring(lastColon + 1);
  const line = parseInt(lineStr, 10);
  if (isNaN(line) || line < 1) return undefined;

  const uri = vscode.Uri.file(filePath);
  const pos = new vscode.Position(line - 1, 0); // CallerLineNumber is 1-based
  return new vscode.Location(uri, pos);
}
