import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

export type SnapbotAppearance = "light" | "dark" | "system";
export type SnapbotParameter = string | string[] | undefined;

export interface SnapbotConfiguration {
  appearance?: SnapbotAppearance;
  backupCode: string;
}

export interface SnapbotSetupProps {
  apiEnvironment: string;
  requestedApiEnvironment?: SnapbotParameter;
  requestedAppearance?: SnapbotParameter;
  backupCode?: SnapbotParameter;
  configure: (configuration: SnapbotConfiguration) => Promise<boolean | void>;
  configurationError?: string | null;
  isAuthenticating?: boolean;
}

const APPEARANCES = new Set<SnapbotAppearance>(["light", "dark", "system"]);

function first(value: SnapbotParameter): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function appearanceFrom(value: string): SnapbotAppearance | undefined {
  return APPEARANCES.has(value as SnapbotAppearance)
    ? (value as SnapbotAppearance)
    : undefined;
}

/**
 * Shared debug-only staging UI used by React Native apps driven by the Snapbot
 * CLI. Its ready and error states are deliberately static because the CLI uses
 * a stable pixel hash as the signal that app-owned setup has finished.
 */
export function SnapbotSetup({
  apiEnvironment,
  requestedApiEnvironment,
  requestedAppearance,
  backupCode,
  configure,
  configurationError,
  isAuthenticating = false,
}: SnapbotSetupProps) {
  const startedKey = useRef<string | null>(null);
  const runId = useRef(0);
  const configureRef = useRef(configure);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const environment = first(requestedApiEnvironment);
  const appearanceValue = first(requestedAppearance);
  const code = first(backupCode);

  useEffect(() => {
    configureRef.current = configure;
  }, [configure]);

  useEffect(() => {
    const key = JSON.stringify([apiEnvironment, environment, appearanceValue, code]);
    if (startedKey.current === key) return;
    startedKey.current = key;
    const currentRun = ++runId.current;
    setLocalError(null);
    setIsReady(false);

    if (environment && environment !== apiEnvironment) {
      setLocalError(
        `Snapbot requested ${environment}, but this build uses ${apiEnvironment}.`,
      );
      return;
    }

    const appearance = appearanceFrom(appearanceValue);
    if (appearanceValue && !appearance) {
      setLocalError(
        `Snapbot requested unsupported appearance ${appearanceValue}.`,
      );
      return;
    }

    void configureRef
      .current({ appearance, backupCode: code })
      .then((configured) => {
        if (currentRun === runId.current && configured !== false) {
          setIsReady(true);
        }
      })
      .catch((reason: unknown) => {
        if (currentRun !== runId.current) return;
        setLocalError(
          reason instanceof Error ? reason.message : "Screenshot setup failed.",
        );
      });
  }, [apiEnvironment, appearanceValue, code, environment]);

  const error = localError ?? configurationError;
  const action = code
    ? "Signing in for screenshots…"
    : "Preparing screenshot appearance…";

  return (
    <View style={styles.container}>
      {error || isReady ? null : (
        <ActivityIndicator size="large" color="#ffffff" />
      )}
      <Text style={styles.title}>
        {error ? "Snapbot setup failed" : isReady ? "Snapbot ready" : action}
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {isReady ? (
        <Text style={styles.detail}>Appearance and session are ready</Text>
      ) : isAuthenticating ? (
        <Text style={styles.detail}>
          Authenticating against {apiEnvironment}
        </Text>
      ) : appearanceValue ? (
        <Text style={styles.detail}>Using {appearanceValue} appearance</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 32,
    backgroundColor: "#000000",
  },
  title: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
  },
  detail: {
    color: "#a3a3a3",
    fontSize: 14,
  },
  error: {
    color: "#ff7777",
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
  },
});
