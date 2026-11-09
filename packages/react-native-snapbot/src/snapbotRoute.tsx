import { Redirect, useLocalSearchParams } from "expo-router";

import { SnapbotSetup, type SnapbotSetupProps } from "./snapbotSetup";

export type SnapbotRouteProps = Omit<
  SnapbotSetupProps,
  "requestedApiEnvironment" | "requestedAppearance" | "backupCode"
>;

/**
 * Shared Expo route shell for the debug-only `/snapbot` deep link. Each app
 * still keeps a tiny `app/snapbot.tsx` file because Expo Router discovers
 * routes from the app filesystem, but parameter parsing and production access
 * protection belong to this shared component.
 */
export function SnapbotRoute(props: SnapbotRouteProps) {
  const params = useLocalSearchParams();

  if (!__DEV__) return <Redirect href="/" />;

  return (
    <SnapbotSetup
      {...props}
      requestedApiEnvironment={params.apiEnvironment}
      requestedAppearance={params.appearance}
      backupCode={params.backupCode}
    />
  );
}
