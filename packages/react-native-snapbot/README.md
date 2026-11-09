# react-native-snapbot

`react-native-snapbot` provides the debug-only Expo Router setup screen used by
the Snapbot screenshot CLI. It parses setup parameters from the `/snapbot`
deep link, lets your app prepare its own theme/session state, exposes a stable
visual ready or error state, and redirects production builds to `/`.

## Installation

Install this package alongside its peer dependencies:

```sh
npm install react-native-snapbot expo-router react react-native
```

## Expo Router integration

Expo Router discovers routes from your app's filesystem, so add one small
adapter at `app/snapbot.tsx`:

```tsx
import { SnapbotRoute, type SnapbotConfiguration } from "react-native-snapbot";
import { useCallback } from "react";

export default function SnapbotScreen() {
  const configure = useCallback(
    async ({ appearance, backupCode }: SnapbotConfiguration) => {
      if (appearance) await saveThemePreference(appearance);
      if (backupCode) await restoreScreenshotAccount(backupCode);
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

The route shell owns these query parameters:

- `apiEnvironment`: must match the environment compiled into the app;
- `appearance`: `light`, `dark`, or `system`;
- `backupCode`: an optional opaque value passed to your `configure` callback.

Your callback owns all app-specific behavior. Return `true` or `void` when the
app is ready for navigation, return `false` to intentionally keep the setup
screen pending, or throw to render a static error. Pass `configurationError`
and `isAuthenticating` when setup state comes from an asynchronous app hook.

The route checks `__DEV__` before rendering setup. It is not an authentication
boundary; never include the route in a production workflow or give a backup
code more privilege than your debug build requires.

## Opening modals, sheets, and steps

UI with no route of its own opts in with `useSnapbotState`. A screenshot's
`state` in `snapbot.json` reaches the app as `?snapbot=key` (or `key:value`,
comma-separated for several):

```tsx
import { useSnapbotState } from "react-native-snapbot";

useSnapbotState("settings.filter", {
  open: () => setFilterVisible(true),
  close: () => setFilterVisible(false),
});

useSnapbotState("onboarding.step", {
  open: (stepId) => goToStep(stepId),
});

useSnapbotState("feed.report", {
  ready: Boolean(firstPost),
  open: () => openReport(firstPost),
  close: () => closeReport(),
});
```

- `open` runs about 600 ms (`SNAPBOT_OPEN_DELAY_MS`) after its key arrives, so
  navigation started by the same deep link can finish; iOS ignores a modal
  presented while another screen is still animating away. It also runs on
  mount if the key is already active, so a sheet inside another sheet can open
  once its parent renders it.
- `close` runs when a later deep link drops the key. Snapbot opens its setup
  route between captures, which closes everything, so a modal never leaks into
  the next screenshot.
- `ready` (a boolean, or a function of the value) holds `open` until the data
  the UI shows has loaded.
- Prefer the screen's existing open handler over setting visibility directly,
  so captures match what a real tap shows, and only expose actions that cannot
  change real data.

The hook does nothing outside `__DEV__`.
