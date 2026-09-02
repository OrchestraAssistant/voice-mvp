// No JSX in here on purpose: isListening() is a pure predicate, and keeping it
// in a plain module means it can be unit-tested directly by `node --test`
// without a JSX loader or a browser. It is also the widget's only promise
// about privacy, so it is worth being able to assert cheaply and often.

/**
 * Derives "is the mic actually capturing audio right now" from transport, mic
 * attachment, mode and hold state. Emphatically NOT the same thing as "the
 * connection is up": ptt only listens while held, ptnt listens except while
 * held, and a session can be established with no microphone on it at all.
 */
export function isListening({ transport, micAttached, mode, holding }) {
  // Two independent conditions, and keeping them independent is the point. A
  // connection can be up with no microphone on it -- warmed ahead of the user
  // asking to talk, say -- and nothing about that should suggest we are
  // listening. `transport === "ready"` alone used to imply it, which would
  // light this rim on a session the user never started.
  if (transport !== "ready" || !micAttached) return false;
  if (mode === "ptt") return holding;
  if (mode === "ptnt") return !holding;
  return true; // continuous
}
