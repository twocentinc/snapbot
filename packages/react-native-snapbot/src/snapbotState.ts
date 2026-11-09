import { useEffect, useRef, useState } from "react";
import { Linking } from "react-native";

/** Query parameter the Snapbot CLI appends to a screenshot deep link. */
export const SNAPBOT_STATE_PARAMETER = "snapbot";

/**
 * How long a requested state waits before opening, so navigation started by
 * the same deep link can finish first. Exported for screens that also need to
 * delay their own modal presentation (e.g. a route-level `<Modal>`).
 */
export const SNAPBOT_OPEN_DELAY_MS = 600;

type ActiveStates = ReadonlyMap<string, string | undefined>;
type Listener = (states: ActiveStates) => void;

let activeStates: ActiveStates = new Map();
const listeners = new Set<Listener>();
let subscribedToLinking = false;

/**
 * Parses `snapbot=key,key:value` into a key → value map. Values are optional
 * so a modal can be requested by key alone while a stepper receives the step.
 */
export function parseSnapbotStates(url: string | null): ActiveStates {
  const states = new Map<string, string | undefined>();
  if (!url) return states;
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return states;

  // Parse by hand: React Native's built-in URLSearchParams is incomplete unless
  // the app happens to install a polyfill, and this package must not rely on it.
  const query = url.slice(queryStart + 1).split("#")[0] ?? "";
  const pair = query
    .split("&")
    .find((part) => part.split("=")[0] === SNAPBOT_STATE_PARAMETER);
  const raw = pair
    ? decodeURIComponent(pair.slice(pair.indexOf("=") + 1).replace(/\+/g, " "))
    : "";
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf(":");
    const key = (separator === -1 ? entry : entry.slice(0, separator)).trim();
    if (!key) continue;
    states.set(key, separator === -1 ? undefined : entry.slice(separator + 1));
  }
  return states;
}

function publish(url: string | null) {
  activeStates = parseSnapbotStates(url);
  for (const listener of listeners) listener(activeStates);
}

function ensureLinkingSubscription() {
  if (subscribedToLinking) return;
  subscribedToLinking = true;
  // Every deep link replaces the active set, including the `/snapbot` setup
  // link Snapbot opens between captures, which closes anything still open.
  Linking.addEventListener("url", ({ url }) => publish(url));
  void Linking.getInitialURL().then((url) => {
    if (url) publish(url);
  });
}

export interface SnapbotStateHandlers {
  /** Called when the requested state becomes active, with its optional value. */
  open: (value: string | undefined) => void;
  /** Called when a later deep link no longer requests this state. */
  close?: () => void;
  /**
   * When false, opening waits until it becomes true, e.g. until the data the
   * modal displays has loaded. Defaults to true.
   */
  ready?: boolean | ((value: string | undefined) => boolean);
}

/**
 * Debug-only hook that lets Snapbot open UI that has no route of its own, such
 * as a modal, bottom sheet, or step inside a flow. Snapbot requests it by
 * appending `?snapbot=<key>` (or `<key>:<value>`) to a screenshot deep link.
 *
 * `open` runs when the key becomes active or its value changes, including on
 * mount if the key is already active, so nested sheets can open after their
 * parent renders them. `close` runs when a later deep link drops the key. In
 * production builds the hook does nothing.
 */
export function useSnapbotState(
  key: string,
  handlers: SnapbotStateHandlers,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const ready = handlers.ready ?? true;
  // A fresh object per deep link, so the same URL opened twice (light, then
  // dark) still re-runs `open` after the setup link closed it in between.
  const [request, setRequest] = useState<{ value: string | undefined } | null>(
    null,
  );
  const openedRef = useRef<{ value: string | undefined } | null>(null);
  // Held in a ref rather than effect cleanup: a function `ready` changes on
  // every render, and cancelling there would keep a pending open from firing.
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (openTimerRef.current) clearTimeout(openTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!__DEV__) return;
    ensureLinkingSubscription();
    const apply: Listener = (states) => {
      setRequest(states.has(key) ? { value: states.get(key) } : null);
    };
    listeners.add(apply);
    apply(activeStates);
    return () => {
      listeners.delete(apply);
    };
  }, [key]);

  useEffect(() => {
    const isReady = typeof ready === "function" ? ready(request?.value) : ready;
    if (request && isReady && openedRef.current !== request) {
      openedRef.current = request;
      if (openTimerRef.current) clearTimeout(openTimerRef.current);
      // The same deep link usually also navigates (for example, closing
      // Snapbot's setup screen), and iOS silently refuses to present a modal
      // while another screen is still animating away. Wait for it to settle.
      openTimerRef.current = setTimeout(() => {
        openTimerRef.current = null;
        if (openedRef.current === request) {
          handlersRef.current.open(request.value);
        }
      }, SNAPBOT_OPEN_DELAY_MS);
    } else if (!request && openedRef.current) {
      openedRef.current = null;
      if (openTimerRef.current) {
        // Dropped before it ever opened, so there is nothing to close.
        clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
        return;
      }
      handlersRef.current.close?.();
    }
  }, [request, ready]);
}
