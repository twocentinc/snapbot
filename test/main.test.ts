import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadAppConfig } from "../src/main.js";

function config(overrides: Record<string, unknown> = {}) {
  return {
    name: "example-app",
    appDirectory: "apps/example",
    bundleIdentifier: "com.example.app",
    scheme: "example",
    xcodeScheme: "ExampleApp",
    iosProduct: "ExampleApp.app",
    apiEnvironment: "preview",
    backupCode: "root-code",
    appearance: "both",
    simulator: {
      name: "Snapbot iPhone",
      deviceType: "iPhone 17 Pro",
      runtime: "iOS 26.5",
    },
    metro: { port: 8090 },
    defaults: {
      minimumWaitMs: 750,
      sampleIntervalMs: 250,
      stableSamples: 3,
      timeoutMs: 15_000,
    },
    screenshots: [
      { name: "home", deeplink: "example://home" },
      {
        name: "settings",
        deeplink: "example://settings",
        apiEnvironment: "production-canary",
        backupCode: "screen-code",
        appearance: "dark",
      },
      {
        name: "anonymous",
        deeplink: "example://profile",
        backupCode: "",
        appearance: "light",
      },
    ],
    ...overrides,
  };
}

test("loads one self-contained app config and resolves its paths", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "snapbot-config-"),
  );
  try {
    const configDirectory = path.join(temporaryRoot, "configuration");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, "snapbot.json"),
      `${JSON.stringify(config())}\n`,
      "utf8",
    );

    const loaded = await loadAppConfig(
      temporaryRoot,
      "configuration/snapbot.json",
    );
    assert.equal(loaded.name, "example-app");
    assert.equal(loaded.scheme, "example");
    assert.equal(loaded.appDirectory, path.join(temporaryRoot, "apps/example"));
    assert.equal(
      loaded.configPath,
      path.join(temporaryRoot, "configuration/snapbot.json"),
    );
    assert.deepEqual(
      loaded.screenshots.map(({ apiEnvironment, backupCode, appearance }) => ({
        apiEnvironment,
        backupCode,
        appearance,
      })),
      [
        {
          apiEnvironment: "preview",
          backupCode: "root-code",
          appearance: "both",
        },
        {
          apiEnvironment: "production-canary",
          backupCode: "screen-code",
          appearance: "dark",
        },
        { apiEnvironment: "preview", backupCode: "", appearance: "light" },
      ],
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects deep links that do not use the configured app scheme", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "snapbot-config-"),
  );
  try {
    await writeFile(
      path.join(temporaryRoot, "snapbot.json"),
      `${JSON.stringify(
        config({ screenshots: [{ name: "home", deeplink: "other://home" }] }),
      )}\n`,
      "utf8",
    );
    await assert.rejects(
      loadAppConfig(temporaryRoot, "snapbot.json"),
      /must use the example scheme/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("appends requested app states to the deep link", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "snapbot-config-"),
  );
  try {
    await writeFile(
      path.join(temporaryRoot, "snapbot.json"),
      `${JSON.stringify(
        config({
          screenshots: [
            { name: "home", deeplink: "example://home" },
            {
              name: "create-post",
              deeplink: "example://arena?tab=hot",
              state: "arena.createPost",
            },
            {
              name: "onboarding-bio",
              deeplink: "example://onboarding",
              state: ["onboarding.flow", "onboarding.step:bio"],
            },
          ],
        }),
      )}\n`,
      "utf8",
    );
    const loaded = await loadAppConfig(temporaryRoot, "snapbot.json");
    const [home, createPost, onboarding] = loaded.screenshots;
    assert.equal(home?.deeplink, "example://home");
    assert.deepEqual(home?.state, []);

    const createPostUrl = new URL(createPost?.deeplink ?? "");
    assert.equal(createPostUrl.searchParams.get("tab"), "hot");
    assert.equal(createPostUrl.searchParams.get("snapbot"), "arena.createPost");
    assert.equal(
      new URL(onboarding?.deeplink ?? "").searchParams.get("snapbot"),
      "onboarding.flow,onboarding.step:bio",
    );
    assert.deepEqual(onboarding?.state, [
      "onboarding.flow",
      "onboarding.step:bio",
    ]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("defaults screenshots to required and keeps explicit optional ones", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "snapbot-config-"),
  );
  try {
    await writeFile(
      path.join(temporaryRoot, "snapbot.json"),
      `${JSON.stringify(
        config({
          screenshots: [
            { name: "home", deeplink: "example://home" },
            { name: "reactions", deeplink: "example://room", optional: true },
          ],
        }),
      )}\n`,
      "utf8",
    );
    const loaded = await loadAppConfig(temporaryRoot, "snapbot.json");
    assert.deepEqual(
      loaded.screenshots.map(({ optional }) => optional),
      [false, true],
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects malformed states and deep links that already set one", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "snapbot-config-"),
  );
  try {
    for (const [screenshot, message] of [
      [{ name: "home", deeplink: "example://home", state: "a,b" }, /state/],
      [
        {
          name: "home",
          deeplink: "example://home?snapbot=arena.createPost",
          state: "arena.createPost",
        },
        /already sets snapbot/,
      ],
    ] as const) {
      await writeFile(
        path.join(temporaryRoot, "snapbot.json"),
        `${JSON.stringify(config({ screenshots: [screenshot] }))}\n`,
        "utf8",
      );
      await assert.rejects(
        loadAppConfig(temporaryRoot, "snapbot.json"),
        message,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("accepts mixed-case Expo schemes after URL normalization", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "snapbot-config-"),
  );
  try {
    await writeFile(
      path.join(temporaryRoot, "snapbot.json"),
      `${JSON.stringify(
        config({
          scheme: "ExampleApp",
          screenshots: [{ name: "home", deeplink: "ExampleApp://home" }],
        }),
      )}\n`,
      "utf8",
    );
    const loaded = await loadAppConfig(temporaryRoot, "snapbot.json");
    assert.equal(loaded.screenshots[0]?.deeplink, "ExampleApp://home");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("reads the backup code from the environment variable backupCodeEnv names", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "snapbot-config-"),
  );
  const variable = "SNAPBOT_TEST_BACKUP_CODE";
  const write = (overrides: Record<string, unknown>) =>
    writeFile(
      path.join(temporaryRoot, "snapbot.json"),
      `${JSON.stringify(
        config({
          backupCode: "",
          screenshots: [{ name: "home", deeplink: "example://home" }],
          ...overrides,
        }),
      )}\n`,
      "utf8",
    );
  try {
    process.env[variable] = "env-code";
    await write({ backupCodeEnv: variable });
    const loaded = await loadAppConfig(temporaryRoot, "snapbot.json");
    assert.equal(loaded.backupCode, "env-code");
    assert.equal(loaded.screenshots[0]?.backupCode, "env-code");

    delete process.env[variable];
    await assert.rejects(
      loadAppConfig(temporaryRoot, "snapbot.json"),
      /SNAPBOT_TEST_BACKUP_CODE, but it is not set/,
    );

    process.env[variable] = "env-code";
    await write({ backupCode: "inline-code", backupCodeEnv: variable });
    await assert.rejects(
      loadAppConfig(temporaryRoot, "snapbot.json"),
      /either backupCode or backupCodeEnv/,
    );
  } finally {
    delete process.env[variable];
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
