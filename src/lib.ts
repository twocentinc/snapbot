import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import {
    copyFile,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";

import { PNG } from "pngjs";

export interface LogOptions {
  raw?: boolean;
}

export type Logger = (message: unknown, options?: LogOptions) => void;

export type Appearance = "light" | "dark" | "system" | "both";
export type CaptureAppearance = Exclude<Appearance, "both">;
export type ApiEnvironment = string;

export interface StabilitySettings {
  minimumWaitMs: number;
  sampleIntervalMs: number;
  stableSamples: number;
  timeoutMs: number;
}

export type ScreenshotDefinition = StabilitySettings & {
  name: string;
  /** Final URL to open, including any `snapbot` state parameter. */
  deeplink: string;
  /** App UI states requested through `useSnapbotState`, e.g. a modal key. */
  state: string[];
  /** When true, a timeout is a warning instead of failing the run (for data-dependent screens). */
  optional: boolean;
  apiEnvironment: ApiEnvironment;
  backupCode: string;
  appearance: Appearance;
};

/** Fully resolved configuration consumed by one iOS capture run. */
export interface AppConfig {
  name: string;
  bundleIdentifier: string;
  scheme: string;
  xcodeScheme: string;
  iosProduct: string;
  appDirectory: string;
  configPath: string;
  apiEnvironment: ApiEnvironment;
  backupCode: string;
  appearance: Appearance;
  simulator: {
    name: string;
    deviceType: string;
    runtime: string;
  };
  metro: { port: number };
  defaults: StabilitySettings;
  screenshots: ScreenshotDefinition[];
}

export function isErrnoException(
  error: unknown,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Creates the line-oriented logger shared by capture and process helpers. */
export async function createLogger(
  logPath: string,
  { append = false }: { append?: boolean } = {},
): Promise<Logger> {
  await mkdir(path.dirname(logPath), { recursive: true });
  if (!append) await writeFile(logPath, "", "utf8");

  return (message: unknown, options: LogOptions = {}) => {
    const text = String(message);
    appendFileSync(
      logPath,
      options.raw ? text : `[${new Date().toISOString()}] ${text}\n`,
    );
    if (!options.raw) console.error(text);
  };
}

/** Replaces a JSON document without exposing a partially written summary. */
export async function writeJsonAtomic(
  target: string,
  value: unknown,
): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

/**
 * Claims an empty caller-owned output directory for one Snapbot process.
 * Returning a release function keeps cleanup explicit in the CLI lifecycle.
 */
export async function prepareOutputDirectory(
  outputDirectory: string,
): Promise<() => Promise<void>> {
  await mkdir(outputDirectory, { recursive: true });
  const lockDirectory = path.join(outputDirectory, ".snapbot-lock");
  try {
    await mkdir(lockDirectory);
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      throw new Error(`Another Snapbot process owns ${outputDirectory}.`);
    }
    throw error;
  }

  const release = async () =>
    rm(lockDirectory, { recursive: true, force: true });
  const entries = await readdir(outputDirectory);
  if (entries.some((entry) => entry !== ".snapbot-lock")) {
    await release();
    throw new Error(
      `Snapbot output folder must be empty: ${outputDirectory}. Choose another folder or clear it explicitly.`,
    );
  }
  await writeFile(path.join(lockDirectory, "pid"), `${process.pid}\n`, "utf8");
  return release;
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  log?: Logger | null;
  displayCommand?: string;
  detached?: boolean;
  allowFailure?: boolean;
}

export interface RunningProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  getStdout: () => string;
  getStderr: () => string;
}

export interface RunResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function assertPortAvailable(port: number): Promise<void> {
  const server = net.createServer();
  server.unref();

  try {
    server.listen({ host: "127.0.0.1", port });
    await once(server, "listening");
  } catch (error) {
    if (isErrnoException(error) && error.code === "EADDRINUSE") {
      throw new Error(
        `Metro port ${port} is already in use; refusing to stop an unknown process.`,
      );
    }
    throw error;
  } finally {
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
  }
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
}

export function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(quote).join(" ");
}

export function startProcess(
  command: string,
  args: string[],
  { cwd, env, log, displayCommand, detached = false }: ProcessOptions = {},
): RunningProcess {
  log?.(`$ ${displayCommand ?? formatCommand(command, args)}`);
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    log?.(chunk, { raw: true });
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    log?.(chunk, { raw: true });
  });

  return { child, getStdout: () => stdout, getStderr: () => stderr };
}

export async function run(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<RunResult> {
  const running = startProcess(command, args, options);
  const [exitCode, signal] = (await once(running.child, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  const result = {
    exitCode: exitCode ?? 1,
    signal,
    stdout: running.getStdout(),
    stderr: running.getStderr(),
  };

  if (result.exitCode !== 0 && !options.allowFailure) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${options.displayCommand ?? formatCommand(command, args)} failed (${result.exitCode})${detail ? `: ${detail}` : ""}`,
    );
  }

  return result;
}

export async function stopProcess(
  running: RunningProcess | undefined,
  log?: Logger,
): Promise<void> {
  if (!running?.child || running.child.exitCode !== null) return;

  const pid = running.child.pid;
  if (pid === undefined) return;

  const exited = once(running.child, "exit").then(() => true);
  const signal = (name: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, name);
      return true;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ESRCH") return false;
      if (!isErrnoException(error) || error.code !== "EPERM") throw error;

      // macOS can deny a signal to the whole detached process group after one
      // of Expo's descendants changes state. The child process is still ours,
      // so fall back to signaling it directly instead of failing cleanup.
      log?.(
        `Could not send ${name} to process group ${pid}; signaling process ${pid} directly`,
      );
      try {
        return running.child.kill(name);
      } catch (childError) {
        if (isErrnoException(childError) && childError.code === "ESRCH") {
          return false;
        }
        throw childError;
      }
    }
  };

  log?.(`Stopping process group ${pid}`);
  if (!signal("SIGTERM")) return;

  if (await Promise.race([exited, sleep(5_000).then(() => false)])) return;

  log?.(`Process group ${pid} did not stop; sending SIGKILL`);
  if (!signal("SIGKILL")) return;
  if (await Promise.race([exited, sleep(5_000).then(() => false)])) return;
  throw new Error(`Process ${pid} did not exit after SIGKILL.`);
}

export async function waitForMetro(
  port: number,
  timeoutMs: number,
  log?: Logger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/status`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      // Expo has returned both the legacy packager-status body and regular
      // HTTP responses here across releases. Because Snapbot reserves the port
      // before spawning Expo, any HTTP response proves that its server is up.
      await response.body?.cancel();
      log?.(`Metro is ready on port ${port}`);
      return;
    } catch {
      // Metro is still starting.
    }
    await sleep(500);
  }

  throw new Error(
    `Metro did not become ready on port ${port} within ${timeoutMs}ms.`,
  );
}

export interface DecodedPng {
  width: number;
  height: number;
  rgba: Buffer;
}

export interface PixelFingerprint {
  width: number;
  height: number;
  hash: string;
}

export function decodePngPixels(png: Buffer): DecodedPng {
  const { width, height, data } = PNG.sync.read(png);
  return { width, height, rgba: data };
}

export function hashPngPixels(png: Buffer): PixelFingerprint {
  const { width, height, rgba } = decodePngPixels(png);
  const hash = createHash("sha256")
    .update(`${width}x${height}\0`)
    .update(rgba)
    .digest("hex");
  return { width, height, hash };
}

/**
 * Two samples count as unchanged when at most this share of pixels differ.
 * Big enough for a blinking text cursor (a few hundred pixels), small enough
 * that spinners and animations still count as an unsettled screen.
 */
const STABLE_CHANGED_PIXEL_RATIO = 0.0005;
/** Per-channel difference treated as noise rather than a real change. */
const PIXEL_CHANNEL_TOLERANCE = 8;

/** Share of pixels (0–1) that differ between two decoded frames. */
export function changedPixelRatio(a: DecodedPng, b: DecodedPng): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  for (let index = 0; index < a.rgba.length; index += 4) {
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(
        (a.rgba[index + channel] ?? 0) - (b.rgba[index + channel] ?? 0),
      );
      if (delta > PIXEL_CHANNEL_TOLERANCE) {
        changed += 1;
        break;
      }
    }
  }
  return changed / (a.width * a.height);
}

export interface StabilityResult {
  stable: boolean;
  timedOut: boolean;
  samples: number;
  pixelHash: string;
  width: number;
  height: number;
}

/**
 * Samples pixels until the configured number of identical frames is reached.
 * iOS-specific process and screenshot operations remain injected by ios.ts.
 */
export async function captureWhenStable({
  outputPath,
  temporaryDirectory,
  settings,
  captureSample,
  assertAlive,
  log,
}: {
  outputPath: string;
  temporaryDirectory: string;
  settings: StabilitySettings;
  captureSample: (outputPath: string) => Promise<void>;
  assertAlive: () => void;
  log: Logger;
}): Promise<StabilityResult> {
  await mkdir(temporaryDirectory, { recursive: true });
  const startedAt = Date.now();
  await sleep(settings.minimumWaitMs);

  let previousHash: string | undefined;
  let previousFrame: DecodedPng | undefined;
  let stableCount = 0;
  let samples = 0;
  let currentPath: string | undefined;
  let dimensions: { width: number; height: number } | undefined;

  while (Date.now() - startedAt < settings.timeoutMs) {
    assertAlive();
    currentPath = path.join(
      temporaryDirectory,
      `sample-${String(samples).padStart(3, "0")}.png`,
    );
    await captureSample(currentPath);
    const png = await readFile(currentPath);
    const frame = decodePngPixels(png);
    const fingerprint = hashPngPixels(png);
    dimensions = { width: fingerprint.width, height: fingerprint.height };
    samples += 1;
    const changedRatio = previousFrame
      ? changedPixelRatio(previousFrame, frame)
      : 1;
    stableCount =
      changedRatio <= STABLE_CHANGED_PIXEL_RATIO ? stableCount + 1 : 1;
    previousFrame = frame;
    previousHash = fingerprint.hash;
    log(
      `Pixel sample ${samples}: ${fingerprint.hash.slice(0, 12)} (${(changedRatio * 100).toFixed(3)}% changed, ${stableCount}/${settings.stableSamples} stable)`,
    );

    if (stableCount >= settings.stableSamples) {
      await copyFile(currentPath, outputPath);
      await rm(temporaryDirectory, { recursive: true, force: true });
      return {
        stable: true,
        timedOut: false,
        samples,
        pixelHash: previousHash,
        ...dimensions,
      };
    }
    await sleep(settings.sampleIntervalMs);
  }

  if (!currentPath) {
    currentPath = path.join(temporaryDirectory, "timeout.png");
    await captureSample(currentPath);
    const fingerprint = hashPngPixels(await readFile(currentPath));
    previousHash = fingerprint.hash;
    dimensions = { width: fingerprint.width, height: fingerprint.height };
    samples = 1;
  }
  if (!previousHash || !dimensions) {
    throw new Error(
      "Screenshot capture completed without a pixel fingerprint.",
    );
  }
  await copyFile(currentPath, outputPath);
  await rm(temporaryDirectory, { recursive: true, force: true });
  log(`Pixel stability timed out; preserved the final frame at ${outputPath}`);
  return {
    stable: false,
    timedOut: true,
    samples,
    pixelHash: previousHash,
    ...dimensions,
  };
}
