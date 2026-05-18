import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/** Fully parsed and ready configuration of this vscode workspace */
export interface WorkspaceConfig {
  /** Path to VS directory to pass to cake task */
  readonly cakeVsPath: string | undefined;
  /** Build configuration that cake task will `dotnet build` */
  readonly cakeConfiguration: string;
  /** Whether to use --ignore-log-errors in cake task */
  readonly cakeIgnoreLogErrors: boolean;
  /** Milliseconds to wait for other test controllers to start their builds */
  readonly waitForOtherTests: number;
  /** VinTest'able projects in this vscode workspace */
  readonly projects: readonly ProjectConfig[];
}

/** Fully parsed and ready configuration of a single VinTest'able mod folder in this vscode workspace */
export interface ProjectConfig {
  /** Path to where the entire mod project is located */
  readonly projectRoot: string;
  /** Display name shown in the Test Explorer (e.g. "PetMapMarkers.gametests") */
  readonly displayName: string;
  /** Path to cakebuild.csproj of this mod */
  readonly cakeProjectPath: string;
  /** Name of cake task to run */
  readonly cakeTarget: string;
  /** Path to where running cake task will store VS data */
  readonly cakeDataPath: string;
  /** Path to where running cake task will create PID file for debugger to attach */
  readonly pidFilePath: string;
}

/**
 * Construct the full workspace config needed for discovery and running.
 * Returns null when there is nothing to do (no projects found).
 * Throws on hard configuration errors (bad paths, empty settings, etc.).
 */
export async function resolveExtensionConfig(
  output: vscode.OutputChannel,
  debug: boolean,
): Promise<WorkspaceConfig | null> {
  const vsConfig = vscode.workspace.getConfiguration("vintest");

  if (!vsConfig.get<string>("cake.configuration")?.trim())
    throw new Error(
      '"vintest.cake.configuration" is empty - provide a valid value or remove the setting.',
    );

  const detected = await resolveProjects(vsConfig, output);
  if (detected === null) return null;

  if (detected.length === 0) {
    output.appendLine("[VinTest] No valid projects resolved.");
    return null;
  }

  const real: ProjectConfig[] = [];
  for (const d of detected) {
    const root = path.dirname(path.dirname(d.cakeProjPath));
    const dataPath = d.dataPathOverride
      ? path.resolve(root, d.dataPathOverride)
      : path.join(root, "gamedata");
    const pid = path.join(dataPath, "TestResults", "vs.pid");
    real.push({
      cakeProjectPath: d.cakeProjPath,
      projectRoot: root,
      cakeDataPath: dataPath,
      pidFilePath: pid,
      cakeTarget: d.cakeTargetOverride ?? "RunGameTests",
      displayName: path.basename(root),
    });
  }
  return {
    cakeVsPath: resolveVsPath(vsConfig, output),
    cakeConfiguration: debug
      ? "Debug"
      : vsConfig.get<string>("cake.configuration", "Release"),
    cakeIgnoreLogErrors: vsConfig.get<boolean>("cake.ignoreLogErrors", false),
    waitForOtherTests: vsConfig.get<number>("waitForOtherTests", 0),
    projects: real,
  };
}

/** Intermediate configuration of a single project; resolved from vscode's settings or autodetected */
interface DetectedProject {
  cakeProjPath: string;
  dataPathOverride?: string;
  cakeTargetOverride?: string;
}

/**
 * Resolve the raw list of cake project paths + per-project overrides.
 * Uses the explicit `vintest.projects` list if provided; otherwise auto-detects.
 * Returns null when auto-detection finds nothing (signals "nothing to do").
 * Returns an empty array when explicit settings were all invalid (caller reports the error).
 */
async function resolveProjects(
  vsConfig: vscode.WorkspaceConfiguration,
  output: vscode.OutputChannel,
): Promise<DetectedProject[] | null> {
  const projectSettings = vsConfig.get<
    {
      cakeBuildProject: string;
      "cake.dataPath"?: string;
      "cake.target"?: string;
    }[]
  >("projects", []);

  // if workspace provides us with projects set - ensure they are valid
  if (projectSettings.length > 0) {
    const result: DetectedProject[] = [];
    for (const setting of projectSettings) {
      const project = setting.cakeBuildProject?.trim();
      if (!project)
        throw new Error(
          "vintest.projects[].cakeBuildProject is empty - provide a valid value or remove the setting.",
        );
      const resolved = path.isAbsolute(project)
        ? project
        : resolveAcrossWorkspaceFolders(project);
      if (!resolved || !fs.existsSync(resolved)) {
        throw new Error(
          `vintest.projects: cakeBuildProject "${project}" not found.`,
        );
      }
      const rawDataPath = setting["cake.dataPath"]?.trim();
      // undefined setting should pass and cause autodetection in cake
      if (rawDataPath !== undefined && !rawDataPath)
        throw new Error(
          `vintest.projects[].cake.dataPath is empty - provide a valid value or remove the setting.`,
        );
      const rawTarget = setting["cake.target"]?.trim();
      if (rawTarget !== undefined && !rawTarget)
        throw new Error(
          `vintest.projects[].cake.target is empty - provide a valid value or remove the setting.`,
        );
      result.push({
        cakeProjPath: resolved,
        dataPathOverride: rawDataPath,
        cakeTargetOverride: rawTarget,
      });
    }
    return result;
  }

  // if not - try to discover what can
  const detected = await autoDetectAllCakeProjects();
  if (detected.length === 0) {
    output.appendLine(
      "[VinTest] No VinTest Cake project found - test operations unavailable.",
    );
    return null;
  }
  return detected.map((p) => ({ cakeProjPath: p }));
}

/** If workspace provides us with VS path, ensure it is a valid one */
function resolveVsPath(
  vsConfig: vscode.WorkspaceConfiguration,
  output: vscode.OutputChannel,
): string | undefined {
  const raw = vsConfig.get<string>("cake.vsPath")?.trim();
  //expect cake autodetect to kick in later
  if (raw === undefined) return undefined;

  if (!raw)
    throw new Error(
      '"vintest.cake.vsPath" is empty - provide a valid value or remove the setting.',
    );
  if (!fs.existsSync(raw))
    throw new Error(`vintest.cake.vsPath "${raw}" does not exist.`);

  output.appendLine(`[VinTest] cake.vsPath from settings: ${raw}`);
  return raw;
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
