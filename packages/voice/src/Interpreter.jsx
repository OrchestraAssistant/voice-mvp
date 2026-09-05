import { InterpreterBubble } from "./InterpreterBubble.jsx";
import { ListeningGlow } from "./ListeningGlow.jsx";
import { rimState } from "./listening.js";
import { useInterpreter } from "./VoiceProvider.jsx";

/**
 * The whole interface, assembled the way we think it should look.
 *
 * This is the top of three tiers, and it exists because the tier below it
 * failed a real host. The bubble and the rim ship separately so they can be
 * used apart, which means a host has to import both, call `useInterpreter()`,
 * derive the rim's state itself and render two things in the right places.
 * Nothing breaks if it renders only the bubble -- it simply gets no ambient
 * feedback, silently. That happened on the first real integration, and the
 * app looked fine, so nothing pointed at what was missing.
 *
 * The tiers, in the order a host should reach for them:
 *
 *   <Interpreter/>          this. One component, both pieces, our opinion.
 *   bubble + rim separately for a host that wants one, or both placed its
 *                           own way.
 *   useInterpreter()        the raw session for a host building its own UI.
 *
 * Deliberately thin: everything here is composition, and a host that wants
 * something else can drop a tier without losing anything but the assembly.
 */
export function Interpreter({ mount, rim = true }) {
  const { transport, micAttached, mode, holding, userSpeaking, agentBusy, rimPalettes } = useInterpreter();
  const state = rimState({ transport, micAttached, mode, holding, userSpeaking, agentBusy });

  return (
    <>
      {/* `active` and `state` are separate: the rim fades out on null rather
          than snapping, so it needs to keep rendering the colours it is
          leaving from. */}
      {rim ? <ListeningGlow active={state !== null} state={state ?? "ready"} palettes={rimPalettes} /> : null}
      <InterpreterBubble mount={mount} />
    </>
  );
}
