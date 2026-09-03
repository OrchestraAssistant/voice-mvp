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

/**
 * Which of the rim's three states to show, or null for "do not show it".
 *
 * Three, not four: thinking and speaking back are both the agent holding the
 * floor, and neither is a moment when anything the user does changes what
 * happens next. What the rim has to carry is whose turn it is.
 *
 *   null        no session, or a session with no microphone on it. A warm
 *               connection must not light the rim -- see the transport /
 *               micAttached split, which exists for exactly this.
 *   "working"   the agent has the floor. Checked FIRST: if it is talking and
 *               the user talks over it, the interruption belongs to the next
 *               turn, and flickering between the two would say nothing.
 *   "listening" audio is actually arriving and being forwarded.
 *   "ready"     connected and able to hear, but nothing is being sent.
 */
export function rimState({ transport, micAttached, mode, holding, userSpeaking, agentBusy }) {
  if (transport !== "ready" || !micAttached) return null;
  if (agentBusy) return "working";
  // Server VAD reports speech directly. Push-to-talk switches that detector
  // off, so there the button IS the signal -- without this, "listening" would
  // never appear in the one mode where the user is most certain they are
  // being heard.
  if (mode === "ptt" ? holding : userSpeaking) return "listening";
  return "ready";
}
