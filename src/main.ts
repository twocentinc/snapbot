#!/usr/bin/env tsx

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
    captureAppearances,
    captureConfiguredApp,
    screenshotOutputName,
    type AppCaptureResult,
} from "./ios.js";
import {
    createLogger,
    errorMessage,
    prepareOutputDirectory,
    run,
    writeJsonAtomic,
    type AppConfig,
    type ScreenshotDefinition,
} from "./lib.js";

const APPEARANCES = ["light", "dark", "system", "both"] as const;
// Must match SNAPBOT_STATE_PARAMETER in react-native-snapbot.
const SNAPBOT_STATE_PARAMETER = "snapbot";
const appearanceSchema = z.enum(APPEARANCES);
const nonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, {
    message: "Must be a non-empty string",
  });
const appNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
  message: "Must be lowercase kebab-case",
});
const schemeSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9+.-]*$/, {
  message: "Must be a valid URL scheme without ://",
});
const stabilityObjectSchema = z.object({
  minimumWaitMs: z.number().int().min(0),
  sampleIntervalMs: z.number().int().min(50),
  stableSamples: z.number().int().min(2),
  timeoutMs: z.number().int().min(1_000),
});
const stabilitySchema = stabilityObjectSchema.refine(
  ({ minimumWaitMs, timeoutMs }) => minimumWaitMs < timeoutMs,
  { message: "minimumWaitMs must be less than timeoutMs" },
);
// One `key` or `key:value` entry handed to the app's `useSnapbotState` hook.
// Commas separate entries in the deep link, so neither part may contain one.
const stateEntrySchema = z.string().regex(/^[A-Za-z0-9._-]+(:[^,]+)?$/, {
  message: "Must be a state key such as arena.createPost or onboarding.step:3",
});
const screenshotSchema = z
  .object({
    name: appNameSchema,
    deeplink: nonEmptyStringSchema,
    state: z
      .union([stateEntrySchema, z.array(stateEntrySchema).min(1)])
      .optional(),
    optional: z.boolean().optional(),
    apiEnvironment: nonEmptyStringSchema.optional(),
    backupCode: z.string().optional(),
    appearance: appearanceSchema.optional(),
  })
  .extend(stabilityObjectSchema.partial().shape);
const appConfigSchema = z.object({
  name: appNameSchema,
  appDirectory: nonEmptyStringSchema,
  bundleIdentifier: nonEmptyStringSchema,
  scheme: schemeSchema,
  xcodeScheme: nonEmptyStringSchema,
  iosProduct: nonEmptyStringSchema,
  apiEnvironment: nonEmptyStringSchema,
  backupCode: z.string().default(""),
  // Name of an environment variable holding the backup code, so the code
  // itself never has to live in a committed config.
  backupCodeEnv: nonEmptyStringSchema.optional(),
  appearance: appearanceSchema.default("light"),
  simulator: z.object({
    name: nonEmptyStringSchema,
    deviceType: nonEmptyStringSchema,
    runtime: nonEmptyStringSchema,
  }),
  metro: z.object({ port: z.number().int().min(1_024).max(65_535) }),
  defaults: stabilitySchema,
  screenshots: z.array(screenshotSchema).min(1),
});

function parseSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Reads the root backup code from the config or from its named env variable. */
function resolveBackupCode(
  parsed: { backupCode: string; backupCodeEnv?: string },
  configPath: string,
): string {
  if (!parsed.backupCodeEnv) return parsed.backupCode;
  if (parsed.backupCode) {
    throw new Error(
      `${configPath}: set either backupCode or backupCodeEnv, not both.`,
    );
  }
  const value = process.env[parsed.backupCodeEnv]?.trim();
  if (!value) {
    throw new Error(
      `${configPath}: backupCodeEnv names ${parsed.backupCodeEnv}, but it is not set. Pass --dotenv with a file that defines it.`,
    );
  }
  return value;
}

/** Loads and resolves one user-owned snapbot.json before capture starts. */
export async function loadAppConfig(
  projectRoot: string,
  configFile: string,
): Promise<AppConfig> {
  const configPath = path.resolve(projectRoot, configFile);
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Required Snapbot config does not exist: ${configPath}`);
    }
    throw new Error(`Could not read ${configPath}: ${errorMessage(error)}`);
  }

  const parsed = parseSchema(appConfigSchema, parsedValue, configPath);
  const backupCode = resolveBackupCode(parsed, configPath);
  const seenNames = new Set<string>();
  const outputNameOwners = new Map<string, string>();
  const screenshots = parsed.screenshots.map(
    (raw, index): ScreenshotDefinition => {
      const prefix = `${configPath}: screenshots[${index}]`;
      if (seenNames.has(raw.name)) {
        throw new Error(
          `${configPath}: duplicate screenshot name ${raw.name}.`,
        );
      }
      seenNames.add(raw.name);

      const configuredAppearance = raw.appearance ?? parsed.appearance;
      for (const appearance of captureAppearances(configuredAppearance)) {
        const outputName = screenshotOutputName(
          raw.name,
          configuredAppearance,
          appearance,
        );
        const owner = outputNameOwners.get(outputName);
        if (owner !== undefined) {
          throw new Error(
            `${prefix}: screenshot ${raw.name} would write ${outputName}.png, which ${owner} already writes.`,
          );
        }
        outputNameOwners.set(outputName, raw.name);
      }

      let url: URL;
      try {
        url = new URL(raw.deeplink);
      } catch {
        throw new Error(`${prefix}.deeplink is not a valid URL.`);
      }
      // URL schemes are case-insensitive, and WHATWG parsing normalizes the
      // protocol even when an Expo app declares a mixed-case scheme.
      if (url.protocol.toLowerCase() !== `${parsed.scheme.toLowerCase()}:`) {
        throw new Error(
          `${prefix}.deeplink must use the ${parsed.scheme} scheme.`,
        );
      }

      const state =
        raw.state === undefined
          ? []
          : Array.isArray(raw.state)
            ? raw.state
            : [raw.state];
      if (state.length > 0) {
        if (url.searchParams.has(SNAPBOT_STATE_PARAMETER)) {
          throw new Error(
            `${prefix}.deeplink already sets ${SNAPBOT_STATE_PARAMETER}; use the state field instead.`,
          );
        }
        url.searchParams.set(SNAPBOT_STATE_PARAMETER, state.join(","));
      }

      const settings = parseSchema(
        stabilitySchema,
        {
          minimumWaitMs: raw.minimumWaitMs ?? parsed.defaults.minimumWaitMs,
          sampleIntervalMs:
            raw.sampleIntervalMs ?? parsed.defaults.sampleIntervalMs,
          stableSamples: raw.stableSamples ?? parsed.defaults.stableSamples,
          timeoutMs: raw.timeoutMs ?? parsed.defaults.timeoutMs,
        },
        prefix,
      );

      return {
        ...settings,
        name: raw.name,
        deeplink: state.length > 0 ? url.toString() : raw.deeplink,
        state,
        optional: raw.optional ?? false,
        apiEnvironment: raw.apiEnvironment ?? parsed.apiEnvironment,
        backupCode: raw.backupCode ?? backupCode,
        appearance: raw.appearance ?? parsed.appearance,
      };
    },
  );

  return {
    name: parsed.name,
    bundleIdentifier: parsed.bundleIdentifier,
    scheme: parsed.scheme,
    xcodeScheme: parsed.xcodeScheme,
    iosProduct: parsed.iosProduct,
    appDirectory: path.resolve(projectRoot, parsed.appDirectory),
    configPath,
    apiEnvironment: parsed.apiEnvironment,
    backupCode,
    appearance: parsed.appearance,
    simulator: parsed.simulator,
    metro: parsed.metro,
    defaults: parsed.defaults,
    screenshots,
  };
}

interface CliOptions {
  command: string;
  configPath?: string;
  projectRoot: string;
  outputDirectory?: string;
  execScript?: string;
  envFile?: string;
}

/** Stable, organization-neutral result passed to optional integrations. */
interface RunSummary {
  status: "running" | "success" | "failed";
  command: "capture";
  outputDirectory: string;
  startedAt: string;
  finishedAt?: string;
  app?: AppCaptureResult;
  error?: string;
}

interface CaptureExecutionResult {
  summary: RunSummary;
  execError?: string;
}

function usage(): string {
  return `Usage:
  snapbot capture --config <snapbot.json> --output <folder>
                  [--project-root <path>] [--exec <executable>]
                  [--dotenv <path>]

Snapbot writes one capture directly into the requested output folder. Relative
paths are resolved from --project-root, which defaults to the current working
directory. The output folder must be empty. --dotenv loads variables (such as
the one a config's backupCodeEnv names) before the config is read.
`;
}

function parseArguments(argv: string[]): CliOptions {
  const [command = "help", ...rest] = argv;
  let projectRoot = process.cwd();
  let configPath: string | undefined;
  let outputPath: string | undefined;
  let execPath: string | undefined;
  // Deliberately not `--env-file`: tsx hands that name to Node itself, which
  // then resolves it from the wrong directory and exits before Snapbot runs.
  let envFilePath: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const [flag, inlineValue] = argument.split("=", 2);
    if (
      ["--config", "--output", "--project-root", "--exec", "--dotenv"].includes(
        flag,
      )
    ) {
      const value = inlineValue ?? rest[++index];
      if (!value) throw new Error(`${flag} requires a value.`);
      if (flag === "--config") configPath = value;
      if (flag === "--output") outputPath = value;
      if (flag === "--project-root") projectRoot = path.resolve(value);
      if (flag === "--exec") execPath = value;
      if (flag === "--dotenv") envFilePath = value;
      continue;
    }
    throw new Error(`Unknown argument ${argument}.\n\n${usage()}`);
  }

  const resolvedProjectRoot = path.resolve(projectRoot);
  return {
    command,
    configPath,
    projectRoot: resolvedProjectRoot,
    outputDirectory: outputPath
      ? path.resolve(resolvedProjectRoot, outputPath)
      : undefined,
    execScript: execPath
      ? path.resolve(resolvedProjectRoot, execPath)
      : undefined,
    envFile: envFilePath
      ? path.resolve(resolvedProjectRoot, envFilePath)
      : undefined,
  };
}

async function executeCapture(
  options: CliOptions & { configPath: string; outputDirectory: string },
): Promise<CaptureExecutionResult> {
  const config = await loadAppConfig(options.projectRoot, options.configPath);
  const releaseOutput = await prepareOutputDirectory(options.outputDirectory);
  try {
    const summaryPath = path.join(options.outputDirectory, "summary.json");
    const log = await createLogger(
      path.join(options.outputDirectory, "run.log"),
    );
    const summary: RunSummary = {
      status: "running",
      command: "capture",
      outputDirectory: options.outputDirectory,
      startedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(summaryPath, summary);

    try {
      log(`Starting capture for ${config.name}`);
      summary.app = await captureConfiguredApp({
        outputDirectory: options.outputDirectory,
        config,
        log,
      });
      summary.status = summary.app.status;
    } catch (error) {
      summary.status = "failed";
      summary.error = errorMessage(error);
      log(`Run failed: ${summary.error}`);
    } finally {
      summary.finishedAt = new Date().toISOString();
      await writeJsonAtomic(summaryPath, summary);
    }

    let execError: string | undefined;
    if (options.execScript) {
      log(`Executing ${options.execScript}`);
      try {
        // Execute the integration directly so its shebang selects Bash, Node,
        // Python, or any other runtime without Snapbot knowing which it uses.
        await run(options.execScript, [summaryPath], {
          cwd: options.projectRoot,
          env: {
            SNAPBOT_PROJECT_ROOT: options.projectRoot,
            SNAPBOT_OUTPUT_DIRECTORY: options.outputDirectory,
            SNAPBOT_SUMMARY_PATH: summaryPath,
          },
          log,
        });
      } catch (error) {
        execError = errorMessage(error);
        log(`Exec script failed: ${execError}`);
      }
    }
    return { summary, ...(execError ? { execError } : {}) };
  } finally {
    await releaseOutput();
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help" || options.command === "--help") {
    console.log(usage());
    return;
  }
  if (options.command !== "capture") {
    throw new Error(`Unknown command ${options.command}.\n\n${usage()}`);
  }
  if (!options.configPath || !options.outputDirectory) {
    throw new Error(`capture requires --config and --output.\n\n${usage()}`);
  }
  if (options.envFile) {
    // Load before the config is read so backupCodeEnv can resolve. Existing
    // environment variables win, matching Node's own --env-file behavior.
    try {
      process.loadEnvFile(options.envFile);
    } catch (error) {
      throw new Error(
        `Could not read --dotenv ${options.envFile}: ${errorMessage(error)}`,
      );
    }
  }

  const result = await executeCapture({
    ...options,
    configPath: options.configPath,
    outputDirectory: options.outputDirectory,
  });
  if (result.summary.status === "failed" || result.execError) {
    process.exitCode = 1;
  }
}

// Package-manager binaries normally invoke this file through a node_modules
// symlink. Compare canonical paths so the CLI still starts in that layout,
// while importing helpers from this module remains side-effect free.
const invokedPath = process.argv[1]
  ? realpathSync(path.resolve(process.argv[1]))
  : "";
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
