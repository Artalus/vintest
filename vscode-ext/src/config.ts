import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export interface RunConfig {
  readonly cakeProjPath: string;
  readonly workspaceRoot: string;
  readonly dataPath: string;
  readonly pidFilePath: string;
  readonly vsPath: string | undefined;
  readonly configuration: string;
  readonly ignoreLogErrors: boolean;
  readonly cakeTarget: string;
}

export function getWaitForOtherTests(): number {
  return vscode.workspace
    .getConfiguration("vintest")
    .get<number>("waitForOtherTests", 0);
}

/**
 * Resolves the full extension config needed for both test discovery and running.
 * Returns null if there is nothing to do (no project found, or user cancelled
 * the project-selection dialog). Throws on hard configuration errors.
 */
export async function resolveExtensionConfig(
  output: vscode.OutputChannel,
  debug: boolean,
): Promise<RunConfig | null> {
  const vsConfig = vscode.workspace.getConfiguration("vintest");

  for (const key of [
    "cakeBuildProject",
    "dataPath",
    "vsPath",
    "configuration",
    "cakeTarget",
  ]) {
    const err = checkExplicitlyEmpty(vsConfig, key);
    if (err) throw new Error(err);
  }

  const cakeProjSetting = vsConfig.get<string>("cakeBuildProject", "").trim();
  let cakeProjPath: string;
  let needDataPathDialog = false;

  if (cakeProjSetting) {
    if (path.isAbsolute(cakeProjSetting)) {
      if (!fs.existsSync(cakeProjSetting))
        throw new Error(
          `Cake build project "${cakeProjSetting}" does not exist.`,
        );
      cakeProjPath = cakeProjSetting;
    } else {
      const resolved = resolveAcrossWorkspaceFolders(cakeProjSetting);
      if (!resolved)
        throw new Error(
          `Cake build project "${cakeProjSetting}" not found in any workspace folder.`,
        );
      cakeProjPath = resolved;
    }
  } else {
    const candidates = await autoDetectAllCakeProjects();
    if (candidates.length === 0) {
      output.appendLine(
        "[VinTest] No VinTest Cake project found - test operations unavailable.",
      );
      return null;
    }
    if (candidates.length === 1) {
      cakeProjPath = candidates[0];
    } else {
      const selected = await promptAndSaveCakeProject(candidates);
      if (selected === undefined) {
        output.appendLine(
          "[VinTest] No project selected. " +
            "Set vintest.cakeBuildProject in settings to enable testing.",
        );
        return null;
      }
      cakeProjPath = selected;
      needDataPathDialog = true;
    }
  }

  const workspaceRoot = path.dirname(path.dirname(cakeProjPath));

  let dataPath: string;
  if (needDataPathDialog) {
    const resolved = await promptAndSaveDataPath(workspaceRoot);
    if (resolved === undefined) {
      output.appendLine(
        "[VinTest] No data path selected. " +
          "Set vintest.dataPath in settings to enable testing.",
      );
      return null;
    }
    dataPath = resolved;
  } else {
    const dataPathSetting = vsConfig.get<string>("dataPath", "");
    dataPath = dataPathSetting
      ? path.resolve(workspaceRoot, dataPathSetting)
      : path.join(workspaceRoot, "gamedata");
  }

  const pidFilePath = path.join(dataPath, "TestResults", "vs.pid");

  let vsPath: string | undefined;
  const vsPathSetting = vsConfig.get<string>("vsPath", "").trim();
  if (vsPathSetting) {
    if (!fs.existsSync(vsPathSetting))
      throw new Error(`vintest.vsPath "${vsPathSetting}" does not exist.`);
    output.appendLine(`[VinTest] vsPath from settings: ${vsPathSetting}`);
    vsPath = vsPathSetting;
  }

  return {
    cakeProjPath,
    workspaceRoot,
    dataPath,
    pidFilePath,
    vsPath,
    configuration: debug
      ? "Debug"
      : vsConfig.get<string>("configuration", "Release"),
    ignoreLogErrors: vsConfig.get<boolean>("ignoreLogErrors", false),
    cakeTarget: vsConfig.get<string>("cakeTarget", "RunGameTests"),
  };
}

function checkExplicitlyEmpty(
  config: vscode.WorkspaceConfiguration,
  key: string,
): string | undefined {
  if (config.get<string>(key, "").trim() !== "") return undefined;
  const info = config.inspect<string>(key);
  const isExplicitlySet = [
    info?.globalValue,
    info?.workspaceValue,
    info?.workspaceFolderValue,
  ].some((v) => v !== undefined && v.trim() === "");
  if (isExplicitlySet)
    return `"vintest.${key}" is set to an empty string - provide a valid value or remove the setting.`;
  return undefined;
}

function resolveAcrossWorkspaceFolders(relative: string): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const candidate = path.join(folder.uri.fsPath, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function autoDetectAllCakeProjects(): Promise<string[]> {
  const csprojFiles = await vscode.workspace.findFiles(
    /*include*/ "**/*.csproj",
    /*exclude*/ "{**/bin/**,**/obj/**}",
  );
  const results: string[] = [];
  for (const uri of csprojFiles) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      if (text.includes('"VinTest.Cake"')) results.push(uri.fsPath);
    } catch {
      // skip unreadable files
    }
  }
  return results;
}

async function promptAndSaveCakeProject(
  candidates: string[],
): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const items = candidates.map((cakeProjPath) => {
    const containingFolder = folders.find((f) =>
      cakeProjPath.startsWith(f.uri.fsPath),
    );
    return {
      label:
        containingFolder?.name ?? path.basename(path.dirname(cakeProjPath)),
      description: vscode.workspace.asRelativePath(cakeProjPath, false),
      cakeProjPath,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: "VinTest: Multiple test projects found - select one",
    placeHolder: "Select the Cake build project to use for testing",
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  await vscode.workspace
    .getConfiguration("vintest")
    .update(
      "cakeBuildProject",
      picked.cakeProjPath,
      vscode.ConfigurationTarget.Workspace,
    );
  return picked.cakeProjPath;
}

async function promptAndSaveDataPath(
  workspaceRoot: string,
): Promise<string | undefined> {
  const defaultPath = path.join(workspaceRoot, "gamedata");
  const result = await vscode.window.showInputBox({
    title: "VinTest: Set data directory path",
    prompt:
      "Path to the VintageStory data directory (Saves/, Logs/, TestResults/). " +
      "If left blank, will use default VinTest.Cake behavior (gamedata/ next to your mod).",
    value: defaultPath,
    ignoreFocusOut: true,
  });
  if (result === undefined) return undefined;
  const trimmed = result.trim();
  if (trimmed) {
    await vscode.workspace
      .getConfiguration("vintest")
      .update("dataPath", trimmed, vscode.ConfigurationTarget.Workspace);
  }
  return trimmed || defaultPath;
}
