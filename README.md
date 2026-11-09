# Snapbot

This private repository contains the Snapbot CLI and the reusable
[`react-native-snapbot`](packages/react-native-snapbot) support package.

For development, use Node.js 22 or newer and run `pnpm install`, `pnpm test`,
`pnpm typecheck`, and `pnpm --filter react-native-snapbot typecheck`.

Snapbot produces repeatable screenshots of an Expo iOS app. It builds a debug
client, opens each configured deep link in an iOS Simulator, waits until the
decoded pixels stop changing, and saves the resulting PNGs alongside a
machine-readable run summary.

Snapbot is intentionally a local capture tool. It does not require a hosted
service, upload screenshots, call an application backend, change Git branches,
name or retain runs, or install a scheduler. If you need any of those
behaviors, use the post-run exec described below.

## Requirements

- macOS with Xcode and the requested iOS Simulator runtime installed
- Node.js 22 or newer
- an Expo app with `expo-dev-client` and its JavaScript dependencies installed
- CocoaPods available as `pod`

Snapbot runs the app's own `node_modules/.bin/expo` executable, so npm, pnpm,
Yarn, and Bun projects are all supported. Install your app dependencies before
starting a capture.

## Installation

Install the CLI as a development dependency and add the route package to the
Expo app:

```sh
pnpm install -D snapbot
pnpm install react-native-snapbot
```

## Add the setup route

Install `react-native-snapbot` in the Expo app and create an
`app/snapbot.tsx` route. Expo Router requires the small file-system route; the
package owns parameter parsing, the setup screen, and the production redirect.

```tsx
import { SnapbotRoute, type SnapbotConfiguration } from "react-native-snapbot";
import { useCallback } from "react";

export default function SnapbotScreen() {
  const configure = useCallback(
    async ({ appearance, backupCode }: SnapbotConfiguration) => {
      if (appearance) await saveThemePreference(appearance);
      if (backupCode) await signInForScreenshots(backupCode);
      return true;
    },
    [],
  );

  return (
    <SnapbotRoute
      apiEnvironment={process.env.EXPO_PUBLIC_API_ENV ?? "development"}
      configure={configure}
    />
  );
}
```

`configure` is application-owned. It may set theme state, restore a fixture
account, seed local data, or do nothing. Return `false` while another part of
your app intentionally keeps the setup screen pending, throw to show a static
error state, or return `true`/`void` when setup is complete. In production
builds the route redirects to `/` without running setup.

## Configure a capture

Create a JSON file anywhere in your project. All paths are resolved from the
project root, not from the config file's directory.

```json
{
  "name": "example-app",
  "appDirectory": "apps/example-app",
  "bundleIdentifier": "com.example.app",
  "scheme": "example",
  "xcodeScheme": "ExampleApp",
  "iosProduct": "ExampleApp.app",
  "apiEnvironment": "development",
  "backupCodeEnv": "SNAPBOT_BACKUP_CODE",
  "appearance": "both",
  "simulator": {
    "name": "iPhone 17 Pro (iOS 26.5)",
    "deviceType": "iPhone 17 Pro",
    "runtime": "iOS 26.5"
  },
  "metro": {
    "port": 8090
  },
  "defaults": {
    "minimumWaitMs": 750,
    "sampleIntervalMs": 250,
    "stableSamples": 3,
    "timeoutMs": 15000
  },
  "screenshots": [
    {
      "name": "home",
      "deeplink": "example://home"
    },
    {
      "name": "settings",
      "deeplink": "example://settings",
      "appearance": "dark"
    },
    {
      "name": "settings-filter",
      "deeplink": "example://settings",
      "state": "settings.filter"
    },
    {
      "name": "room-reactions",
      "deeplink": "example://rooms",
      "state": ["rooms.openFirstRoom", "room.allReactions"],
      "optional": true
    }
  ]
}
```

The configured simulator name is dedicated to Snapbot. If it does not exist,
Snapbot creates it from `deviceType` and `runtime` (for example `iPhone 17 Pro`
and `iOS 26.5`, which must be installed in Xcode). If two simulators share the
name, Snapbot stops and lists their UDIDs so you can delete the extras with
`xcrun simctl delete <udid>`. The URL scheme must match every screenshot deep
link. `iosProduct` is the `.app` name produced beneath Xcode's
`Debug-iphonesimulator` directory.

### App states (`state`)

Modals, sheets, steps, and tabs that have no route of their own are opened with
`state`: one `key` or `key:value` string, or a list of them. Snapbot appends
them to the deep link as `?snapbot=key,key:value`, and the app opens them with
the `useSnapbotState` hook from `react-native-snapbot`. Use a list when one
screenshot needs several states at once, such as a tab view plus a modal, or a
sheet inside another sheet. Do not set a `snapbot` query parameter in
`deeplink` yourself.

### Optional screenshots (`optional`)

Set `"optional": true` on screenshots that depend on data the screenshot
account may not have, such as a room with reactions. This flag is retained in
the summary as metadata. Visual-stability timeouts are warnings for all
screenshots, including those without `optional`. Deep-link navigation errors
still fail the run.

### When a capture counts as stable

Snapbot samples the screen until consecutive frames match. Frames may differ by
up to 0.05% of their pixels and still count as matching, which tolerates a
blinking text cursor while spinners and animations keep the screen unsettled.
The saved `pixelHash` is still exact, so comparing runs by hash can flag a
screen whose cursor happened to blink.

Root `apiEnvironment`, the backup code, `appearance`, and stability values are
defaults. Each screenshot can override any of them independently. Environment
names are application-defined strings. `appearance` accepts `light`, `dark`,
`system`, or `both`; `both` writes `<name>-light.png` and
`<name>-dark.png`.

## Run Snapbot

```sh
npx snapbot capture \
  --config ./snapbot.json \
  --output ./snapbot-output
```

`--output` is required. The directory may be new or already exist, but it must
be empty so Snapbot can never overwrite or delete caller-owned artifacts. It
contains:

- the captured PNG files;
- `run.log`, including build and simulator diagnostics;
- `summary.json`, the stable machine-readable result.

A run captures exactly one app. Snapbot does not infer dates, Git commits, or
artifact-retention rules. The caller chooses a fresh output directory for every
run and decides whether an earlier result should be skipped, replaced, or
archived. Use `--project-root <path>` when relative config and app paths should
be resolved from somewhere other than the current directory.

When `timeoutMs` expires, Snapbot saves the final frame and continues. The
screenshot retains `timedOut: true` and `stable: false` in `summary.json`, and
the app's `warning` names the affected captures. Setup stability timeouts are
also warnings. A run with only these warnings succeeds and exits zero.
Deep-link navigation, build, process, and screenshot-writing failures still
fail the run and retain diagnostics for review.

## Post-run exec

Pass an executable when another system should consume the finalized output.
Snapbot invokes it directly, so the file must have executable permission and
its shebang chooses the runtime:

```sh
npx snapbot capture \
  --config ./snapbot.json \
  --output ./snapbot-output \
  --exec ./scripts/publish-snapbot-run
```

Snapbot invokes the executable with the absolute `summary.json` path as its
first argument and
also provides `SNAPBOT_SUMMARY_PATH`, `SNAPBOT_OUTPUT_DIRECTORY`, and
`SNAPBOT_PROJECT_ROOT`. It runs after both successful and failed captures. Its
failure makes the command exit nonzero without changing the
capture status in `summary.json`.

This boundary keeps cloud storage, CI, review dashboards, and
organization-specific authentication out of the capture engine.

## Credential notes

The backup code is optional and has no built-in semantics beyond being
delivered to your debug-only setup route. Keep it out of the config: set
`backupCodeEnv` to the name of an environment variable and pass a git-ignored
env file with `--dotenv`:

```sh
npx snapbot capture --config ./snapbot.json --output ./out \
  --dotenv ./apps/example-app/.env.snapbot
```

```sh
# apps/example-app/.env.snapbot (git-ignored)
SNAPBOT_BACKUP_CODE=...
```

Variables already set in the environment take precedence over the file. A
config may set `backupCode` or `backupCodeEnv`, not both; if `backupCodeEnv`
names a variable that is not set, the capture stops before it starts. Snapbot
redacts the code from displayed deep links and does not include it in
`summary.json`. Use a dedicated screenshot account without elevated
permissions, since the code is a full login.

## Troubleshooting

- **First-open confirmation**: after installing the app, Snapbot automatically
  approves its configured URL scheme for CoreSimulator deep links. This avoids
  the iOS "Open in '<app>'?" prompt on new simulators and newly captured apps,
  while preserving approvals for other apps. If approval cannot be written,
  the run stops with a specific error before waiting for the JavaScript bundle.
- **Expo developer overlays**: Snapbot starts the app with Expo's developer
  welcome screen, automatic developer menu, and floating developer button
  disabled for that process. No manual first-run setup is needed, and the app's
  saved developer preferences are unchanged.
- **Xcode 27 has no separate Simulator app**: open simulators from Xcode's
  Device Manager instead.
- **Captures freeze for minutes at a time**: `simctl io screenshot` blocks
  while the Mac sleeps. Keep it awake, for example with
  `caffeinate -dims npx snapbot capture ...`.
- **Every capture shows the same screen**: an overlay stayed on top, such as a
  red React error screen or a system passcode prompt. Find the first capture
  where it appears and check the Metro errors in `run.log`.
