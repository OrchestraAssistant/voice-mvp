import { useSyncExternalStore } from "react";

/**
 * TEMPORARY -- a live square/rounded switch for the listening rim, so the
 * two shapes can be compared without a reload while using the app normally.
 *
 * Deliberately a standalone store rather than React context or a prop
 * chain. VoiceProvider's context value is the widget's *public* API and a
 * debug switch has no business in it, and drilling one from App down
 * through InterpreterBubble into InterpreterPanel would put it in the
 * package's component signatures. This way the whole thing is one file plus
 * two call sites.
 *
 * To remove: delete this file, drop the "Rim corners" block at the bottom
 * of InterpreterPanel.jsx, and replace `corners={useRimCorners()}` in
 * App.jsx and stress-main.jsx with whichever literal wins.
 */
let corners = "square";
const listeners = new Set();

export function setRimCorners(next) {
  corners = next;
  for (const notify of listeners) notify();
}

export function useRimCorners() {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => corners,
  );
}
