import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { Mic, Settings } from "lucide-react";
import useMeasure from "react-use-measure";

// ?inline hands us the *compiled* stylesheet as a string (Tailwind already
// run over it) so it can be injected into the shadow root, where the host
// document's CSS cannot reach it and ours cannot leak out.
import widgetCss from "./styles.css?inline";

import { cn } from "@/lib/utils";
import { useInterpreter } from "./VoiceProvider.jsx";
import { ScreenOverlay } from "./ScreenOverlay.jsx";

/**
 * Click-outside, hand-written rather than pulling in usehooks-ts for a
 * single hook -- a distributed widget shouldn't drag a utility package
 * along for ten lines. The handler goes through a ref so its identity
 * churning between renders doesn't resubscribe the listener every time.
 *
 * Three cases, because a click "inside us" looks different depending on
 * where we're mounted:
 *
 *   - in the host's tree: contains(event.target) works normally.
 *   - inside an OPEN shadow root: target is retargeted to the host, but
 *     composedPath() still reveals the real path, so we check that.
 *   - inside a CLOSED shadow root (what ScreenOverlay uses): target is
 *     retargeted AND composedPath() truncates at the boundary, so neither
 *     of the above can see in -- verified, not assumed. The one reliable
 *     signal left is that the retargeted target IS our overlay host,
 *     which only ever happens for events originating inside it.
 */
function useOnClickOutside(ref, handler, shadowHost) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (event) => {
      const el = ref.current;
      if (!el) return;
      if (shadowHost && event.target === shadowHost) return; // closed root
      const path = typeof event.composedPath === "function" ? event.composedPath() : null;
      const inside = path ? path.includes(el) : el.contains(event.target);
      if (inside) return;
      handlerRef.current(event);
    };
    document.addEventListener("mousedown", listener);
    document.addEventListener("touchstart", listener);
    return () => {
      document.removeEventListener("mousedown", listener);
      document.removeEventListener("touchstart", listener);
    };
  }, [ref, shadowHost]);
}

const TABS = [
  { key: "voice", title: "Talk", icon: Mic },
  { key: "settings", title: "Settings", icon: Settings },
];

const labelTransition = {
  delay: 0.1,
  type: "spring",
  bounce: 0,
  duration: 0.6,
};

// Content slides in from the side the new tab sits on, so movement always
// matches the direction the selection travelled.
// TEMPORARY -- set false (or delete the block that uses it) once the resize
// animation is settled.
const DEBUG_HEIGHT = true;

// Collapsed pill fits one icon-only tab; open panel is the content width.
const COLLAPSED_WIDTH = 68;
const COLLAPSED_HEIGHT = 50;
const PANEL_WIDTH = 320;

const contentVariants = {
  initial: (direction) => ({ x: `${110 * direction}%`, opacity: 0 }),
  active: { x: "0%", opacity: 1 },
  exit: (direction) => ({ x: `${-110 * direction}%`, opacity: 0 }),
};

/**
 * The tab strip. Only the selected tab reveals its label; the rest stay
 * icon-only, and the whole strip is a single icon-width pill while
 * nothing is selected.
 */
function ExpandedTabs({ tabs, selected, setSelected, setDirection }) {
  const handleTabSelect = (index) => {
    if (selected === null) return setSelected(index);
    if (selected === index) return setSelected(null);
    setDirection(index > selected ? 1 : -1);
    setSelected(index);
  };

  return (
    <div className="flex h-9 w-full items-center justify-center gap-1">
      {tabs.map((tab, index) => (
        <motion.button
          key={tab.title}
          type="button"
          initial={false}
          animate={{
            gap: selected === index ? ".5rem" : 0,
            paddingLeft: selected === index ? "1rem" : ".5rem",
            paddingRight: selected === index ? "1rem" : ".5rem",
          }}
          onClick={() => handleTabSelect(index)}
          aria-label={tab.title}
          className={cn(
            "relative flex h-full items-center justify-center rounded-2xl px-4 text-sm font-medium transition-colors duration-300 after:absolute after:right-0 after:top-0 after:h-full after:w-3 after:translate-x-full after:content-['']",
            selected === index
              ? cn("bg-foreground/4")
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <tab.icon className="size-4" />
          <AnimatePresence initial={false}>
            {selected === index && (
              <motion.span
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: "auto", opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={labelTransition}
                className="overflow-hidden whitespace-nowrap font-medium tracking-tight"
              >
                {tab.title}
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
      ))}
    </div>
  );
}

/** Voice tab: connect/disconnect, push-to-talk, transcript, typed commands. */
function VoiceTabContent() {
  const { status, transcript, mode, holding, start, stop, sendText, holdStart, holdEnd } = useInterpreter();
  const [textInput, setTextInput] = useState("");
  const connected = status === "connected";
  const busy = connected || status === "connecting";

  const holdLabel = mode === "ptt" ? (holding ? "Listening…" : "Hold to talk") : holding ? "Muted" : "Hold to mute";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button type="button" className={cn("mic-button", connected && "mic-connected")} onClick={busy ? stop : start}>
          {connected ? "Stop" : status === "connecting" ? "Connecting…" : "Talk"}
        </button>
        <span className="voice-status">{status}</span>
      </div>

      {connected && mode !== "continuous" && (
        <>
          <button
            type="button"
            className={cn("hold-button", holding && "holding")}
            onMouseDown={holdStart}
            onMouseUp={holdEnd}
            onMouseLeave={holdEnd}
            onTouchStart={(e) => {
              e.preventDefault();
              holdStart();
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              holdEnd();
            }}
          >
            {holdLabel}
          </button>
          <span className="hold-hint">or hold Ctrl+Space</span>
        </>
      )}

      {transcript.length > 0 && (
        <div className="transcript">
          {transcript.slice(-5).map((turn, i) => (
            <p key={i} className={`turn turn-${turn.role}`}>
              <strong>{turn.role}:</strong> {turn.text}
            </p>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (textInput.trim()) sendText(textInput.trim());
          setTextInput("");
        }}
      >
        <input
          aria-label="Type a command"
          placeholder="Or type a command…"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}

const MODES = [
  { id: "continuous", label: "Continuous", hint: "Always listening; pauses end your turn." },
  { id: "ptt", label: "Push to talk", hint: "Muted until you hold." },
  { id: "ptnt", label: "Push to not talk", hint: "Listening until you hold." },
];

/** Settings tab: mic mode today, more later. */
function SettingsTabContent() {
  const { mode, setMode } = useInterpreter();

  return (
    <div className="flex flex-col gap-1">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => setMode(m.id)}
          className={cn(
            "hover:bg-muted flex cursor-pointer flex-col items-start gap-0.5 rounded-xl px-2 py-2 text-left text-sm",
            mode === m.id && "bg-foreground/4",
          )}
        >
          <span className="font-medium">{m.label}</span>
          <span className="text-muted-foreground text-xs">{m.hint}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The default drop-in UI: an icon-only pill that expands into a tabbed
 * panel. Closed, it's a single mic button -- the Settings tab only exists
 * once the panel has been opened. Selecting a tab reveals its label and
 * leaves the others icon-only; selecting it again collapses the whole
 * thing back to the pill.
 *
 * Opening the pill deliberately does NOT start a session -- the Talk
 * button inside does. Otherwise reaching Settings would mean going live
 * on the mic first.
 *
 * Renders through <ScreenOverlay>, i.e. into a closed shadow root mounted
 * on <body>, not into the host app's tree. That isn't decoration: a host's
 * bare `button {}` / `form {}` rules are the same specificity as our own
 * base rules and load after ours, so in the host's document they simply
 * win -- and raising our specificity to answer them would then stomp the
 * Tailwind utilities this component is built out of. Inside the shadow
 * root neither side can reach the other, so both problems stop existing
 * rather than being traded against each other.
 */
export function InterpreterBubble({ mount = "shadow" }) {
  const [selected, setSelected] = useState(null);
  const [direction, setDirection] = useState(1);
  const [contentRef, bounds] = useMeasure();
  const containerRef = useRef(null);
  const [overlayHost, setOverlayHost] = useState(null);

  useOnClickOutside(containerRef, () => setSelected(null), overlayHost);

  // Settings only exists once the panel is open; indices stay stable
  // (voice 0, settings 1) so `selected` survives the array growing.
  const tabs = selected === null ? TABS.slice(0, 1) : TABS;

  const content = useMemo(() => {
    if (selected === 0) return <VoiceTabContent />;
    if (selected === 1) return <SettingsTabContent />;
    return <div></div>;
  }, [selected]);

  const widget = (
    <div ref={containerRef} className="interpreter-widget">
      <MotionConfig transition={{ duration: 0.5, type: "spring", bounce: 0 }}>
        <motion.div
          initial={false}
          animate={{
            height: selected === null ? COLLAPSED_HEIGHT : bounds.height,
            width: selected === null ? COLLAPSED_WIDTH : PANEL_WIDTH,
          }}
          className="bg-background relative mx-auto overflow-hidden rounded-3xl shadow-[0_8px_24px_rgba(0,0,0,0.16)]"
        >
          {/* TEMPORARY -- live readout for the resize animation. Absolutely
              positioned and outside the measured div, so it cannot affect the
              number it reports. Delete along with DEBUG_HEIGHT. */}
          {DEBUG_HEIGHT && (
            <div
              style={{
                position: "absolute",
                top: 2,
                right: 6,
                zIndex: 10,
                font: "10px/1.4 ui-monospace, monospace",
                color: "#b00",
                pointerEvents: "none",
              }}
            >
              measured {Math.round(bounds.height)} · tab {String(selected)}
            </div>
          )}

          {/* Structure below is skiper96's, unchanged: measured wrapper with
              no styling of its own, the animated pane inside it, and the tab
              strip absolutely positioned *within* that same wrapper. */}
          <div ref={contentRef}>
            <AnimatePresence mode="popLayout" initial={false} custom={direction}>
              <motion.div
                key={selected}
                variants={contentVariants}
                initial="initial"
                animate="active"
                exit="exit"
                custom={direction}
                className="bg-background/80 p-2 pb-11"
              >
                {content}
              </motion.div>
            </AnimatePresence>

            <div className="bg-background absolute bottom-0 w-full p-2">
              <ExpandedTabs
                tabs={tabs}
                selected={selected}
                setSelected={setSelected}
                setDirection={setDirection}
              />
            </div>
          </div>
        </motion.div>
      </MotionConfig>
    </div>
  );

  // "inline" renders into the host's own tree, where its stylesheet reaches
  // us -- kept as a switch so the difference can be observed rather than
  // argued about. "shadow" is the real default.
  if (mount === "inline") return widget;

  // `active` gates only top-layer raising, not rendering: an idle pill
  // shouldn't displace a host's open modal, but an expanded panel should
  // sit above it.
  return (
    <ScreenOverlay css={widgetCss} active={selected !== null} onHost={setOverlayHost}>
      {widget}
    </ScreenOverlay>
  );
}
