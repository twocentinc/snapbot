import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    assertPortAvailable,
    captureWhenStable,
    errorMessage,
    hashPngPixels,
    isErrnoException,
    run,
    sleep,
    startProcess,
    stopProcess,
    waitForMetro,
    type ApiEnvironment,
    type AppConfig,
    type Appearance,
    type CaptureAppearance,
    type Logger,
    type RunningProcess,
    type StabilityResult,
    type StabilitySettings,
} from "./lib.js";

export function captureAppearances(
  appearance: Appearance,
): CaptureAppearance[] {
  return appearance === "both" ? ["light", "dark"] : [appearance];
}

export function screenshotOutputName(
  name: string,
  configuredAppearance: Appearance,
  appearance: CaptureAppearance,
): string {
  return configuredAppearance === "both" ? `${name}-${appearance}` : name;
}

/**
 * Names of captures whose pixels exactly match the previous capture of the
 * same appearance from a different config entry. Distinct entries rarely look
 * identical, so this usually means an overlay (an error screen, a permission
 * prompt) stayed on top or the deep link never navigated.
 */
export function repeatedFrameNames(
  screenshots: ReadonlyArray<{
    name: string;
    configuredName: string;
    appearance: string;
    pixelHash: string;
  }>,
): string[] {
  const lastByAppearance = new Map<
    string,
    { configuredName: string; pixelHash: string }
  >();
  const repeated: string[] = [];
  for (const screenshot of screenshots) {
    const previous = lastByAppearance.get(screenshot.appearance);
    if (
      previous &&
      previous.configuredName !== screenshot.configuredName &&
      previous.pixelHash === screenshot.pixelHash
    ) {
      repeated.push(screenshot.name);
    }
    lastByAppearance.set(screenshot.appearance, screenshot);
  }
  return repeated;
}

/** Reads the minimum iOS version produced by Expo prebuild for this app. */
export async function iosDeploymentTarget(
  iosDirectory: string,
): Promise<string> {
  const propertiesPath = path.join(iosDirectory, "Podfile.properties.json");
  let properties: Record<string, unknown> = {};
  try {
    properties = JSON.parse(await readFile(propertiesPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }

  const configured = properties["ios.deploymentTarget"];
  if (configured === undefined) return "16.4";
  if (
    typeof configured !== "string" ||
    !/^\d+(?:\.\d+){1,2}$/.test(configured)
  ) {
    throw new Error(
      `${propertiesPath} has an invalid ios.deploymentTarget: ${String(configured)}`,
    );
  }
  return configured;
}

interface SimctlDevice {
  name: string;
  udid: string;
  state: string;
  isAvailable: boolean;
  deviceTypeIdentifier: string;
}

interface ResolvedSimulator extends SimctlDevice {
  runtimeIdentifier: string;
  runtime: string;
  deviceType: string;
}

function runtimeDisplayName(identifier: string): string {
  const value = identifier.split("SimRuntime.")[1] ?? identifier;
  const match = value.match(/^([A-Za-z]+)-(\d+)-(\d+)$/);
  return match
    ? `${match[1]} ${match[2]}.${match[3]}`
    : value.replaceAll("-", " ");
}

function normalizedDeviceType(identifier: string): string {
  return (identifier.split("SimDeviceType.")[1] ?? identifier).replaceAll(
    "-",
    " ",
  );
}

/** Inverse of normalizedDeviceType: "iPhone 17 Pro" → simctl's device type id. */
export function simctlDeviceTypeIdentifier(deviceType: string): string {
  return `com.apple.CoreSimulator.SimDeviceType.${deviceType.trim().replaceAll(" ", "-")}`;
}

/** Inverse of runtimeDisplayName: "iOS 26.5" → simctl's runtime id. */
export function simctlRuntimeIdentifier(runtime: string): string {
  return `com.apple.CoreSimulator.SimRuntime.${runtime.trim().replace(/\s+/, "-").replaceAll(".", "-")}`;
}

/** Resolves the exact preconfigured simulator instead of choosing implicitly. */
async function resolveSimulator(
  config: AppConfig,
  log: Logger,
): Promise<ResolvedSimulator> {
  const result = await run("xcrun", ["simctl", "list", "--json", "devices"], {
    log,
  });
  const parsed = JSON.parse(result.stdout) as {
    devices: Record<string, SimctlDevice[]>;
  };
  const candidates: ResolvedSimulator[] = [];
  for (const [runtimeIdentifier, devices] of Object.entries(parsed.devices)) {
    for (const device of devices) {
      if (device.isAvailable && device.name === config.simulator.name) {
        candidates.push({
          ...device,
          runtimeIdentifier,
          runtime: runtimeDisplayName(runtimeIdentifier),
          deviceType: normalizedDeviceType(device.deviceTypeIdentifier),
        });
      }
    }
  }

  const matches = candidates.filter(
    (candidate) =>
      candidate.runtime === config.simulator.runtime &&
      candidate.deviceType === config.simulator.deviceType,
  );
  if (matches.length > 1) {
    throw new Error(
      `Found ${matches.length} simulators named ${config.simulator.name}: ${matches.map((item) => item.udid).join(", ")}. Delete the extras with \`xcrun simctl delete <udid>\` so Snapbot knows which one to use.`,
    );
  }
  const simulator = matches[0];
  if (!simulator) {
    if (candidates.length > 0) {
      throw new Error(
        `Simulator ${config.simulator.name} exists but is ${candidates.map((item) => `${item.deviceType} on ${item.runtime}`).join(", ")}, not ${config.simulator.deviceType} on ${config.simulator.runtime}. Rename or delete it.`,
      );
    }
    log(
      `Creating simulator ${config.simulator.name} (${config.simulator.deviceType}, ${config.simulator.runtime})`,
    );
    await run(
      "xcrun",
      [
        "simctl",
        "create",
        config.simulator.name,
        simctlDeviceTypeIdentifier(config.simulator.deviceType),
        simctlRuntimeIdentifier(config.simulator.runtime),
      ],
      { log },
    );
    return resolveSimulator(config, log);
  }
  log(`Using simulator ${simulator.name} (${simulator.udid})`);
  return simulator;
}

async function bootSimulator(
  simulator: ResolvedSimulator,
  log: Logger,
): Promise<void> {
  if (simulator.state !== "Booted") {
    await run("xcrun", ["simctl", "boot", simulator.udid], { log });
  } else {
    log("Reusing the already booted simulator");
  }
  await run("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"], {
    log,
  });
  // Normalize visible status-bar state so it does not create noisy diffs.
  await run(
    "xcrun",
    [
      "simctl",
      "status_bar",
      simulator.udid,
      "override",
      "--time",
      "9:41",
      "--batteryState",
      "charged",
      "--batteryLevel",
      "100",
      "--wifiBars",
      "3",
      "--cellularBars",
      "4",
    ],
    { log },
  );
}

async function setSimulatorAppearance(
  simulator: ResolvedSimulator,
  appearance: CaptureAppearance,
  log: Logger,
): Promise<void> {
  if (appearance === "system") {
    log("Using the simulator's current system appearance");
    return;
  }
  await run(
    "xcrun",
    ["simctl", "ui", simulator.udid, "appearance", appearance],
    { log },
  );
  log(`Simulator appearance is ${appearance}`);
}

async function shutdownSimulator(
  simulator: ResolvedSimulator | undefined,
  log: Logger,
): Promise<void> {
  if (!simulator) return;
  await run("xcrun", ["simctl", "status_bar", simulator.udid, "clear"], {
    log,
    allowFailure: true,
  });
  await run("xcrun", ["simctl", "shutdown", simulator.udid], {
    log,
    allowFailure: true,
  });
  log(`Simulator ${simulator.name} is shut down`);
}

async function openUrl(
  simulator: ResolvedSimulator,
  url: string,
  log: Logger,
  displayUrl = url,
): Promise<void> {
  await run("xcrun", ["simctl", "openurl", simulator.udid, url], {
    log,
    displayCommand: `xcrun simctl openurl ${simulator.udid} ${displayUrl}`,
  });
}

/** Approves only this app's scheme so unattended deep links need no first-open tap. */
export async function approveSimulatorDeepLinks(
  simulatorUdid: string,
  config: Pick<AppConfig, "scheme" | "bundleIdentifier">,
  log: Logger,
): Promise<void> {
  // Expo CLI uses this same LaunchServices preference for simctl openurl:
  // https://github.com/expo/expo/blob/main/packages/@expo/cli/src/start/platforms/ios/simctl.ts
  // Write through the device's preferences service to preserve other apps'
  // approvals. CoreSimulator matches these keys by case, even though URL
  // schemes are case-insensitive. Startup uses the configured spelling, while
  // new URL() lowercases the scheme for authentication and capture links.
  const schemes = new Set([config.scheme, config.scheme.toLowerCase()]);
  try {
    for (const scheme of schemes) {
      await run(
        "xcrun",
        [
          "simctl",
          "spawn",
          simulatorUdid,
          "defaults",
          "write",
          "com.apple.launchservices.schemeapproval",
          `com.apple.CoreSimulator.CoreSimulatorBridge-->${scheme}`,
          "-string",
          config.bundleIdentifier,
        ],
        { log },
      );
    }
  } catch (error) {
    throw new Error(
      `Could not approve ${config.scheme} deep links for ${config.bundleIdentifier}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  log(`Approved ${config.scheme} deep links for ${config.bundleIdentifier}`);
}

/** Starts the app with Expo's developer overlays disabled for this process. */
export async function launchSimulatorApp(
  simulatorUdid: string,
  bundleIdentifier: string,
  log: Logger,
): Promise<void> {
  // Expo DevMenu reads these UserDefaults keys. Launch arguments override the
  // defaults without changing the app's saved preferences or native build.
  await run(
    "xcrun",
    [
      "simctl",
      "launch",
      simulatorUdid,
      bundleIdentifier,
      "-EXDevMenuIsOnboardingFinished", "YES",
      "-EXDevMenuShowsAtLaunch", "NO",
      "-EXDevMenuShowFloatingActionButton", "NO",
    ],
    { log },
  );
}

async function takeSimulatorScreenshot(
  simulator: ResolvedSimulator,
  outputPath: string,
  log: Logger,
): Promise<void> {
  // CoreSimulator's screenshot service can be denied access to removable or
  // network-backed project volumes even when the Snapbot process can write
  // there. Capture into macOS's local temporary directory, then let Node copy
  // the completed PNG into the caller-owned output folder.
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "snapbot-screenshot-"),
  );
  const temporaryPath = path.join(temporaryDirectory, "screenshot.png");
  try {
    await run(
      "xcrun",
      ["simctl", "io", simulator.udid, "screenshot", temporaryPath],
      { log },
    );
    await mkdir(path.dirname(outputPath), { recursive: true });
    await copyFile(temporaryPath, outputPath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function assertProcessAlive(pid: number | null): asserts pid is number {
  if (!pid) throw new Error("The app launch did not return a process id.");
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ESRCH") {
      throw new Error(
        `The simulator app process ${pid} exited before capture readiness.`,
      );
    }
    throw error;
  }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extracts an app PID from simctl launchctl output without shell pipelines. */
export function simulatorAppPidFromLaunchctl(
  output: string,
  bundleIdentifier: string,
): number | null {
  const pattern = new RegExp(
    `^\\s*(\\d+)\\s+.*UIKitApplication:${escapeRegularExpression(bundleIdentifier)}(?:\\[|\\s|$)`,
    "m",
  );
  return Number(output.match(pattern)?.[1]) || null;
}

async function findSimulatorAppPid(
  simulator: ResolvedSimulator,
  bundleIdentifier: string,
  log: Logger,
): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const processes = await run(
      "xcrun",
      ["simctl", "spawn", simulator.udid, "launchctl", "print", "user/501"],
      { log: null },
    );
    const pid = simulatorAppPidFromLaunchctl(
      processes.stdout,
      bundleIdentifier,
    );
    if (pid) {
      log(`Found simulator app process ${pid}`);
      return pid;
    }
    await sleep(250);
  }
  throw new Error(
    `Could not find a running simulator process for ${bundleIdentifier}.`,
  );
}

function runtimeEnvironment(config: AppConfig): Record<string, string> {
  return {
    CI: "1",
    EXPO_PUBLIC_API_ENV: config.apiEnvironment,
    EXPO_PUBLIC_SNAPBOT: "1",
    RCT_METRO_PORT: String(config.metro.port),
  };
}

function expoExecutable(config: AppConfig): string {
  // Resolve the app's installed Expo binary directly. Snapbot therefore works
  // with npm, pnpm, Yarn, or Bun without installing dependencies during a run.
  return path.join(config.appDirectory, "node_modules", ".bin", "expo");
}

async function startMetro(
  config: AppConfig,
  log: Logger,
): Promise<RunningProcess> {
  await assertPortAvailable(config.metro.port);
  const running = startProcess(
    expoExecutable(config),
    ["start", "--dev-client", "--port", String(config.metro.port)],
    {
      cwd: config.appDirectory,
      env: runtimeEnvironment(config),
      log,
      detached: true,
    },
  );
  try {
    await waitForMetro(config.metro.port, 60_000, log);
  } catch (error) {
    await stopProcess(running, log);
    throw error;
  }
  return running;
}

/** Returns Metro's terminal iOS bundle diagnostic when its latest result failed. */
export function iosBundleFailure(output: string): string | null {
  const failureMarker = "iOS Bundling failed";
  const failureIndex = output.lastIndexOf(failureMarker);
  if (failureIndex === -1) return null;

  const successfulBundles = Array.from(output.matchAll(/iOS Bundled \d+ms/g));
  const successIndex = successfulBundles.at(-1)?.index ?? -1;
  if (successIndex > failureIndex) return null;

  const diagnostic = output.slice(failureIndex).trim();
  const maximumLength = 8_000;
  return diagnostic.length > maximumLength
    ? `${diagnostic.slice(0, maximumLength)}\n…`
    : diagnostic;
}

async function waitForJavaScriptBundle(
  metro: RunningProcess,
  timeoutMs: number,
  log: Logger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = `${metro.getStdout()}\n${metro.getStderr()}`;
    const bundleFailure = iosBundleFailure(output);
    if (bundleFailure) {
      throw new Error(`The iOS JavaScript bundle failed:\n${bundleFailure}`);
    }
    if (/iOS Bundled \d+ms/.test(output)) {
      log("The iOS JavaScript bundle is loaded");
      return;
    }
    if (metro.child.exitCode !== null) {
      throw new Error("Metro exited before the iOS JavaScript bundle loaded.");
    }
    await sleep(250);
  }
  throw new Error(
    `The iOS JavaScript bundle did not finish within ${timeoutMs}ms.`,
  );
}

/** Builds the Expo dev client, installs it, and returns its simulator PID. */
async function buildAndLaunch(
  config: AppConfig,
  simulator: ResolvedSimulator,
  metro: RunningProcess,
  log: Logger,
): Promise<number> {
  const env = runtimeEnvironment(config);
  await run(expoExecutable(config), ["prebuild", "--platform", "ios"], {
    cwd: config.appDirectory,
    env,
    log,
  });

  const iosDirectory = path.join(config.appDirectory, "ios");
  const deploymentTarget = await iosDeploymentTarget(iosDirectory);
  log(`Using iOS deployment target ${deploymentTarget}`);
  await run("pod", ["install"], { cwd: iosDirectory, env, log });
  const derivedDataPath = path.join(
    iosDirectory,
    "build",
    "SnapbotDerivedData",
  );
  await run(
    "xcodebuild",
    [
      "-workspace",
      path.join(iosDirectory, `${config.xcodeScheme}.xcworkspace`),
      "-scheme",
      config.xcodeScheme,
      "-configuration",
      "Debug",
      "-sdk",
      "iphonesimulator",
      "-destination",
      `id=${simulator.udid}`,
      "-derivedDataPath",
      derivedDataPath,
      // Xcode 27 rejects legacy deployment targets declared by a handful of
      // transitive Pods. Use Expo's generated app minimum across the workspace
      // rather than lowering every target to a stale hardcoded version.
      `IPHONEOS_DEPLOYMENT_TARGET=${deploymentTarget}`,
      `RCT_METRO_PORT=${config.metro.port}`,
      "build",
    ],
    { cwd: config.appDirectory, env, log },
  );

  const appPath = path.join(
    derivedDataPath,
    "Build",
    "Products",
    "Debug-iphonesimulator",
    config.iosProduct,
  );
  await run("xcrun", ["simctl", "install", simulator.udid, appPath], { log });
  // iOS otherwise leaves an "Open in <app>?" alert above SpringBoard and the
  // app never requests its JavaScript bundle. Repeat after each install so new
  // simulators and additional apps work without manual preparation.
  await approveSimulatorDeepLinks(simulator.udid, config, log);
  // Pre-grant every permission simctl can (photos, microphone, location, …)
  // so no system prompt covers later captures. simctl cannot grant the
  // camera; apps must avoid requesting it unprompted in Snapbot builds.
  await run(
    "xcrun",
    ["simctl", "privacy", simulator.udid, "grant", "all", config.bundleIdentifier],
    { log, allowFailure: true },
  );
  await run(
    "xcrun",
    ["simctl", "terminate", simulator.udid, config.bundleIdentifier],
    { log, allowFailure: true },
  );
  await launchSimulatorApp(simulator.udid, config.bundleIdentifier, log);

  const metroUrl = `http://127.0.0.1:${config.metro.port}`;
  const developmentClientUrl = `${config.scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}`;
  await openUrl(simulator, developmentClientUrl, log);
  await waitForJavaScriptBundle(metro, 120_000, log);
  const pid = await findSimulatorAppPid(
    simulator,
    config.bundleIdentifier,
    log,
  );
  await sleep(1_000);
  assertProcessAlive(pid);
  log(`The simulator app process ${pid} is alive after bundle load`);
  return pid;
}

interface AuthenticationResult {
  attempted: boolean;
  succeeded: boolean | null;
  reused?: boolean;
  stable?: boolean;
  timedOut?: boolean;
}

export interface ScreenshotResult extends StabilityResult {
  name: string;
  configuredName: string;
  deeplink: string;
  state: string[];
  optional: boolean;
  path: string;
  apiEnvironment: ApiEnvironment;
  appearance: CaptureAppearance;
  authentication: AuthenticationResult;
  setup: StabilityResult;
  navigationError: string | null;
}

export interface AppCaptureResult {
  app: string;
  configPath?: string;
  apiEnvironment?: ApiEnvironment;
  appearance?: AppConfig["appearance"];
  startedAt?: string;
  finishedAt?: string;
  status: "running" | "success" | "failed";
  screenshots: ScreenshotResult[];
  simulator?: {
    name: string;
    udid: string;
    runtime: string;
    deviceType: string;
  };
  error?: string;
  warning?: string;
  failureScreenshot?: FailureFrame | null;
}

interface FailureFrame {
  path: string;
  width: number;
  height: number;
  pixelHash: string;
}

interface AppResultError extends Error {
  appResult?: AppCaptureResult;
}

/** Final frames remain usable when animations prevent visual stability. */
export function summarizeScreenshots(
  screenshots: ScreenshotResult[],
): Pick<AppCaptureResult, "status" | "warning" | "error"> {
  const warnings: string[] = [];
  const timedOut = screenshots.filter((item) => item.timedOut);
  if (timedOut.length > 0) {
    warnings.push(
      `Pixel stability timed out; saved final frames for: ${timedOut.map((item) => item.name).join(", ")}.`,
    );
  }
  const setupTimedOut = screenshots.filter((item) => item.setup.timedOut);
  if (setupTimedOut.length > 0) {
    warnings.push(
      `Screenshot setup stability timed out for: ${setupTimedOut.map((item) => item.name).join(", ")}.`,
    );
  }
  const repeated = repeatedFrameNames(screenshots);
  if (repeated.length > 0) {
    warnings.push(
      `Identical to the previous capture, so likely stuck behind an overlay or a navigation that did not happen: ${repeated.join(", ")}.`,
    );
  }
  const navigationFailed = screenshots.filter(
    (item) => item.navigationError !== null,
  );
  return {
    status: navigationFailed.length > 0 ? "failed" : "success",
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
    ...(navigationFailed.length > 0
      ? {
          error: `Deep link navigation failed for: ${navigationFailed.map((item) => `${item.name} (${item.navigationError})`).join(", ")}.`,
        }
      : {}),
  };
}

async function prepareScreenshot({
  config,
  backupCode,
  appearance,
  simulator,
  appPid,
  outputDirectory,
  outputName,
  settings,
  log,
}: {
  config: AppConfig;
  backupCode: string;
  appearance: CaptureAppearance;
  simulator: ResolvedSimulator;
  appPid: number;
  outputDirectory: string;
  outputName: string;
  settings: StabilitySettings;
  log: Logger;
}): Promise<StabilityResult> {
  await setSimulatorAppearance(simulator, appearance, log);

  // simctl controls the device appearance. The debug-only staging route also
  // applies app-owned theme state and optional authentication before capture.
  const url = new URL(`${config.scheme}://snapbot`);
  if (backupCode) url.searchParams.set("backupCode", backupCode);
  url.searchParams.set("apiEnvironment", config.apiEnvironment);
  url.searchParams.set("appearance", appearance);
  const displayedParameters = new URLSearchParams();
  if (backupCode) displayedParameters.set("backupCode", "<redacted>");
  displayedParameters.set("apiEnvironment", config.apiEnvironment);
  displayedParameters.set("appearance", appearance);
  await openUrl(
    simulator,
    url.toString(),
    log,
    `${config.scheme}://snapbot?${displayedParameters.toString()}`,
  );

  const setupDirectory = path.join(outputDirectory, ".setup");
  await mkdir(setupDirectory, { recursive: true });
  const stability = await captureWhenStable({
    outputPath: path.join(setupDirectory, `${outputName}.png`),
    temporaryDirectory: path.join(
      outputDirectory,
      ".samples",
      `setup-${outputName}`,
    ),
    settings,
    captureSample: (samplePath) =>
      takeSimulatorScreenshot(simulator, samplePath, log),
    assertAlive: () => assertProcessAlive(appPid),
    log,
  });
  await rm(setupDirectory, { recursive: true, force: true });
  log(
    stability.timedOut
      ? "Screenshot setup did not visually settle before its timeout; continuing so the visible state can be captured"
      : "Screenshot appearance and session setup reached a visually stable state",
  );
  return stability;
}

async function captureFailureFrame(
  simulator: ResolvedSimulator,
  outputDirectory: string,
  log: Logger,
): Promise<FailureFrame | null> {
  const outputPath = path.join(outputDirectory, "failure.png");
  try {
    await mkdir(outputDirectory, { recursive: true });
    await takeSimulatorScreenshot(simulator, outputPath, log);
    const { width, height, hash } = hashPngPixels(await readFile(outputPath));
    return { path: outputPath, width, height, pixelHash: hash };
  } catch (error) {
    log(`Could not capture failure frame: ${errorMessage(error)}`);
    return null;
  }
}

async function captureApp({
  outputDirectory,
  config,
  log,
}: {
  outputDirectory: string;
  config: AppConfig;
  log: Logger;
}): Promise<AppCaptureResult> {
  await mkdir(outputDirectory, { recursive: true });

  let simulator: ResolvedSimulator | undefined;
  let metro: RunningProcess | undefined;
  const result: AppCaptureResult = {
    app: config.name,
    configPath: config.configPath,
    apiEnvironment: config.apiEnvironment,
    appearance: config.appearance,
    startedAt: new Date().toISOString(),
    status: "running",
    screenshots: [],
  };

  try {
    simulator = await resolveSimulator(config, log);
    result.simulator = {
      name: simulator.name,
      udid: simulator.udid,
      runtime: simulator.runtime,
      deviceType: simulator.deviceType,
    };
    await bootSimulator(simulator, log);
    // Preserve the resolved type inside screenshot callbacks; `simulator`
    // remains optional only so the outer cleanup can handle setup failures.
    const activeSimulator = simulator;
    let activeEnvironment: ApiEnvironment | null = null;
    let authenticationKey: string | null = null;
    let appPid: number | null = null;

    for (const screenshot of config.screenshots) {
      const screenshotConfig = {
        ...config,
        apiEnvironment: screenshot.apiEnvironment,
      };
      if (activeEnvironment !== screenshot.apiEnvironment) {
        await stopProcess(metro, log);
        metro = await startMetro(screenshotConfig, log);
        appPid = await buildAndLaunch(screenshotConfig, simulator, metro, log);
        activeEnvironment = screenshot.apiEnvironment;
        authenticationKey = null;
      }

      for (const appearance of captureAppearances(screenshot.appearance)) {
        assertProcessAlive(appPid);
        const outputName = screenshotOutputName(
          screenshot.name,
          screenshot.appearance,
          appearance,
        );
        const nextAuthenticationKey = screenshot.backupCode
          ? `${screenshot.apiEnvironment}\0${screenshot.backupCode}`
          : null;
        const shouldAuthenticate = Boolean(
          nextAuthenticationKey && nextAuthenticationKey !== authenticationKey,
        );
        let authentication: AuthenticationResult;
        if (shouldAuthenticate) {
          authentication = { attempted: true, succeeded: null };
        } else if (nextAuthenticationKey) {
          authentication = { attempted: false, succeeded: true, reused: true };
        } else {
          authentication = { attempted: false, succeeded: null };
          log(
            "No backupCode is configured; restoring the simulator's saved credentials when available",
          );
        }

        const setup = await prepareScreenshot({
          config: screenshotConfig,
          backupCode: shouldAuthenticate ? screenshot.backupCode : "",
          appearance,
          simulator,
          appPid,
          outputDirectory,
          outputName,
          settings: screenshot,
          log,
        });
        if (shouldAuthenticate) {
          authentication = {
            ...authentication,
            stable: setup.stable,
            timedOut: setup.timedOut,
          };
          authenticationKey = nextAuthenticationKey;
        }

        const outputPath = path.join(outputDirectory, `${outputName}.png`);
        log(`Opening ${screenshot.deeplink} in ${appearance} appearance`);
        let navigationError: string | null = null;
        try {
          await openUrl(simulator, screenshot.deeplink, log);
        } catch (error) {
          navigationError = errorMessage(error);
          log(
            `Deep link failed; capturing the visible error state: ${navigationError}`,
          );
        }

        const stability = await captureWhenStable({
          outputPath,
          temporaryDirectory: path.join(
            outputDirectory,
            ".samples",
            outputName,
          ),
          settings: screenshot,
          captureSample: (samplePath) =>
            takeSimulatorScreenshot(activeSimulator, samplePath, log),
          assertAlive: () => assertProcessAlive(appPid),
          log,
        });
        result.screenshots.push({
          name: outputName,
          configuredName: screenshot.name,
          deeplink: screenshot.deeplink,
          state: screenshot.state,
          optional: screenshot.optional,
          path: outputPath,
          apiEnvironment: screenshot.apiEnvironment,
          appearance,
          authentication,
          setup,
          navigationError,
          ...stability,
        });
        console.log(outputPath);
      }
    }

    Object.assign(result, summarizeScreenshots(result.screenshots));
    if (result.warning) {
      log(result.warning);
    }
    return result;
  } catch (error) {
    result.status = "failed";
    result.error = errorMessage(error);
    if (simulator) {
      result.failureScreenshot = await captureFailureFrame(
        simulator,
        outputDirectory,
        log,
      );
    }
    throw Object.assign(new Error(result.error), { appResult: result });
  } finally {
    result.finishedAt = new Date().toISOString();
    await stopProcess(metro, log);
    await shutdownSimulator(simulator, log);
  }
}

export async function captureConfiguredApp({
  outputDirectory,
  config,
  log,
}: {
  outputDirectory: string;
  config: AppConfig;
  log: Logger;
}): Promise<AppCaptureResult> {
  try {
    return await captureApp({ outputDirectory, config, log });
  } catch (error) {
    const appResult = (error as AppResultError).appResult;
    return (
      appResult ?? {
        app: config.name,
        configPath: config.configPath,
        status: "failed",
        screenshots: [],
        error: errorMessage(error),
      }
    );
  }
}
