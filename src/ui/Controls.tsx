// <Controls> — the control bar and the ONLY component that talks to the engine.
// It subscribes via useEngineState and dispatches engine commands; children
// (Scrubber, Readout) are pure props+callbacks.
import { useEffect, useRef, useState } from "preact/hooks";
import type { Engine } from "../engine/types";
import { useEngineState } from "./useEngineState";
import {
  CloseIcon,
  CogIcon,
  GripIcon,
  PauseIcon,
  PlayIcon,
  StepBackIcon,
  StepForwardIcon,
} from "./icons";
import { Scrubber } from "./Scrubber";
import { Readout } from "./Readout";
import { SettingsMenu } from "./SettingsMenu";
import {
  applySettings,
  changeSetting,
  initialSettings,
  SETTINGS_CONFIG,
} from "./settings";
import type { Settings } from "./settings";
import { handleControlKey } from "./keymap";

/** Props for the top-level controls component. */
export interface ControlsProps {
  engine: Engine;
  /**
   * Called when a pointer drag begins on the move handle. Positioning the bar
   * is the host's job (it owns the page-realm element the shadow tree lives in),
   * so the actual move math lives in the mount layer (mount.tsx). When omitted
   * — e.g. in component tests — the grip is not rendered.
   */
  onDragStart?: (event: PointerEvent) => void;
  /** Double-click the move handle to snap the bar back to its default position. */
  onResetPosition?: () => void;
  /** Called when the user clicks the close button; tears down the player. */
  onClose?: () => void;
}

/** Top-level controls bar. */
export function Controls({
  engine,
  onDragStart,
  onResetPosition,
  onClose,
}: ControlsProps) {
  const { playing, index, frameCount, currentTime, duration } =
    useEngineState(engine);

  // With a single frame there's nothing to play or step through. At the ends we
  // let the engine clamp rather than disabling the buttons, so they don't
  // flicker disabled on every loop during playback.
  const steppable = frameCount > 1;

  // Remember whether playback was running when a scrub began, to resume on release.
  const wasPlaying = useRef(false);

  // Playback settings. Held locally (not persisted) and seeded from the source
  // (via the engine) so they reset to the source's own defaults every time the
  // controls are re-mounted — i.e. when the overlay disappears.
  const [settings, setSettings] = useState<Settings>(() =>
    initialSettings(engine),
  );
  // Single seam where settings drive the engine; re-applies on engine swap so a
  // fresh player starts from defaults.
  useEffect(() => {
    applySettings(engine, settings);
  }, [engine, settings]);

  // Settings cog popover open/close. Refs let us anchor focus and detect
  // outside clicks across the shadow boundary.
  const [menuOpen, setMenuOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const cogRef = useRef<HTMLButtonElement>(null);

  // Close on a click outside the cog/popover. composedPath() pierces the shadow
  // boundary, so containment of our in-shadow nodes works from a document listener.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      const wrapper = settingsRef.current;
      if (wrapper && event.composedPath().includes(wrapper)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menuOpen]);

  // Move focus into the menu when it opens.
  useEffect(() => {
    if (!menuOpen) return;
    settingsRef.current?.querySelector<HTMLElement>(".menu-row")?.focus();
  }, [menuOpen]);

  const closeMenu = (): void => {
    setMenuOpen(false);
    cogRef.current?.focus();
  };

  return (
    // Focus-scoped keyboard shortcuts: the bar is focusable so
    // Space/arrows only drive *this* GIF when its controls have focus — no
    // document-level capture, so two GIFs never react to one keypress and page
    // text inputs keep their keys.
    <div
      class="bar"
      tabIndex={0}
      onKeyDown={(event) => {
        // While the settings menu is open it owns keyboard input: Escape closes
        // it (and returns focus to the cog); other keys are left for the menu
        // rather than driving playback.
        if (menuOpen) {
          if (event.key === "Escape") {
            closeMenu();
            event.preventDefault();
          }
          return;
        }
        if (handleControlKey(event.key, engine)) event.preventDefault();
      }}
    >
      {onDragStart && (
        // Drag handle. A non-<button> element so it
        // stays out of the tab order and the keyboard step shortcuts — it's a
        // pointer-only affordance for repositioning the bar away from content.
        <div
          class="grip"
          role="button"
          aria-label="Move controls"
          title="Drag to move · double-click to reset"
          onPointerDown={(event) => onDragStart(event)}
          onDblClick={() => onResetPosition?.()}
        >
          <GripIcon />
        </div>
      )}

      <button
        type="button"
        class="icon"
        aria-label="Previous frame"
        disabled={!steppable}
        onClick={() => engine.step(-1)}
      >
        <StepBackIcon />
      </button>

      <button
        type="button"
        class="icon"
        aria-label={playing ? "Pause" : "Play"}
        aria-pressed={playing}
        disabled={!steppable}
        onClick={() => engine.toggle()}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      <button
        type="button"
        class="icon"
        aria-label="Next frame"
        disabled={!steppable}
        onClick={() => engine.step(1)}
      >
        <StepForwardIcon />
      </button>

      <Scrubber
        time={currentTime}
        duration={duration}
        onSeek={(t) => engine.seekToTime(t)}
        onScrubStart={() => {
          // Read live state (avoids stale closure) and pause while dragging.
          wasPlaying.current = engine.state.playing;
          engine.pause();
        }}
        onScrubEnd={() => {
          if (wasPlaying.current) engine.play();
        }}
      />

      <Readout
        index={index}
        frameCount={frameCount}
        time={currentTime}
        duration={duration}
      />

      <div class="settings" ref={settingsRef}>
        <button
          type="button"
          class="icon"
          ref={cogRef}
          aria-label="Settings"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <CogIcon />
        </button>
        {menuOpen && (
          <div class="menu">
            <SettingsMenu
              config={SETTINGS_CONFIG}
              settings={settings}
              onChange={(id, value) =>
                setSettings((prev) =>
                  changeSetting(SETTINGS_CONFIG, prev, id, value),
                )
              }
            />
          </div>
        )}
      </div>

      {onClose && (
        <button
          type="button"
          class="icon"
          aria-label="Close"
          onClick={() => onClose()}
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
}
