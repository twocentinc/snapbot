import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    captureAppearances,
    iosBundleFailure,
    iosDeploymentTarget,
    repeatedFrameNames,
    simctlDeviceTypeIdentifier,
    simctlRuntimeIdentifier,
    simulatorAppPidFromLaunchctl,
    summarizeScreenshots,
    type ScreenshotResult,
} from "../src/ios.js";
import {
    prepareOutputDirectory,
    startProcess,
    stopProcess,
    waitForMetro,
} from "../src/lib.js";

function screenshotResult(
  name: string,
  overrides: Partial<ScreenshotResult> = {},
): ScreenshotResult {
  const stability = {
    stable: true,
    timedOut: false,
    samples: 3,
    pixelHash: name,
    width: 1,
    height: 1,
  };
  return {
    ...stability,
    name,
    configuredName: name,
    appearance: "dark",
    apiEnvironment: "dev",
    deeplink: `example://${name}`,
    state: [],
    optional: false,
    path: `/tmp/${name}.png`,
    authentication: { attempted: false, succeeded: null },
    setup: stability,
    navigationError: null,
    ...overrides,
  };
}

test("completes required and optional timeout captures with warnings", () => {
  const required = screenshotResult("team-web", {
    stable: false,
    timedOut: true,
  });
  const optional = screenshotResult("optional", {
    optional: true,
    stable: false,
    timedOut: true,
  });
  const setup = screenshotResult("setup");
  setup.setup = { ...setup.setup, stable: false, timedOut: true };
  const result = summarizeScreenshots([required, optional, setup]);

  assert.equal(result.status, "success");
  assert.equal(result.error, undefined);
  assert.match(
    result.warning ?? "",
    /saved final frames for: team-web, optional/,
  );
  assert.match(result.warning ?? "", /setup stability timed out for: setup/);
});

test("a timeout warning does not hide a navigation failure", () => {
  const result = summarizeScreenshots([
    screenshotResult("team-web", {
      timedOut: true,
      stable: false,
      navigationError: "No app can open this URL",
    }),
  ]);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /team-web \(No app can open this URL\)/);
  assert.match(result.warning ?? "", /saved final frames for: team-web/);
});

test("stable captures complete without timeout warnings", () => {
  assert.deepEqual(summarizeScreenshots([screenshotResult("home")]), {
    status: "success",
  });
});

test("finds the target iOS app PID in the simulator launchctl registry", () => {
  const output = `services = {
       123      -  UIKitApplication:com.apple.Preferences[ffff][rb-legacy]
     58117      -  UIKitApplication:com.example.app[e6fe][rb-legacy]
  }`;

  assert.equal(simulatorAppPidFromLaunchctl(output, "com.example.app"), 58117);
  assert.equal(simulatorAppPidFromLaunchctl(output, "com.example.other"), null);
});

test("expands both appearances into light and dark captures", () => {
  assert.deepEqual(captureAppearances("both"), ["light", "dark"]);
  assert.deepEqual(captureAppearances("dark"), ["dark"]);
  assert.deepEqual(captureAppearances("system"), ["system"]);
});

test("detects Metro iOS bundle failures without masking the diagnostic", () => {
  const failure = `iOS Bundling failed 4492ms expo-router/entry.js (5742 modules)
Unable to resolve "@twocents/passkeys" from "useBackupCodeImport.ts"`;

  assert.equal(iosBundleFailure("iOS Bundling 86.1%"), null);
  assert.equal(iosBundleFailure(failure), failure);
  assert.equal(
    iosBundleFailure(`${failure}\niOS Bundled 851ms expo-router/entry.js`),
    null,
  );
});

test("uses Expo's generated iOS deployment target", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "snapbot-deployment-target-"),
  );
  try {
    const iosDirectory = path.join(temporaryRoot, "ios");
    await mkdir(iosDirectory);
    assert.equal(await iosDeploymentTarget(iosDirectory), "16.4");

    await writeFile(
      path.join(iosDirectory, "Podfile.properties.json"),
      `${JSON.stringify({ "ios.deploymentTarget": "17.2" })}\n`,
      "utf8",
    );
    assert.equal(await iosDeploymentTarget(iosDirectory), "17.2");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects an invalid generated iOS deployment target", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "snapbot-deployment-target-"),
  );
  try {
    await writeFile(
      path.join(temporaryRoot, "Podfile.properties.json"),
      `${JSON.stringify({ "ios.deploymentTarget": "latest" })}\n`,
      "utf8",
    );
    await assert.rejects(
      iosDeploymentTarget(temporaryRoot),
      /invalid ios\.deploymentTarget: latest/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("claims only an empty caller-owned output directory", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "snapbot-output-"),
  );
  const outputDirectory = path.join(temporaryRoot, "capture");
  try {
    const release = await prepareOutputDirectory(outputDirectory);
    assert.deepEqual(await readdir(outputDirectory), [".snapbot-lock"]);
    await release();

    await writeFile(path.join(outputDirectory, "existing.txt"), "keep me\n");
    await assert.rejects(
      prepareOutputDirectory(outputDirectory),
      /output folder must be empty/,
    );
    assert.deepEqual(await readdir(outputDirectory), ["existing.txt"]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("accepts an HTTP response as proof that Metro is listening", async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end("Expo response");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    await waitForMetro(address.port, 1_000);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("falls back to signaling the child when macOS denies a group signal", async () => {
  const running = startProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)"],
    { detached: true },
  );
  const originalKill = process.kill;
  let groupSignalAttempts = 0;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0) {
      groupSignalAttempts += 1;
      throw Object.assign(new Error("group signal denied"), { code: "EPERM" });
    }
    return originalKill(pid, signal);
  }) as typeof process.kill;

  try {
    await stopProcess(running);
    assert.equal(groupSignalAttempts, 1);
    assert.equal(running.child.signalCode, "SIGTERM");
  } finally {
    process.kill = originalKill;
    if (running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill("SIGKILL");
      await once(running.child, "exit");
    }
  }
});

test("maps config simulator names to simctl identifiers", () => {
  assert.equal(
    simctlDeviceTypeIdentifier("iPhone 17 Pro"),
    "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  );
  assert.equal(
    simctlRuntimeIdentifier("iOS 26.5"),
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  );
});

test("flags captures that repeat the previous entry's exact frame", () => {
  const shot = (configuredName: string, appearance: string, pixelHash: string) => ({
    name: `${configuredName}-${appearance}`,
    configuredName,
    appearance,
    pixelHash,
  });
  assert.deepEqual(
    repeatedFrameNames([
      shot("home", "light", "a"),
      shot("home", "dark", "b"),
      shot("settings", "light", "a"),
      shot("settings", "dark", "c"),
      shot("profile", "light", "d"),
      shot("profile", "dark", "d"),
    ]),
    ["settings-light"],
  );
});
