// <Controls> — the control bar and the ONLY component that talks to the engine.
// It subscribes via useEngineState and dispatches engine commands; children
// (Scrubber, Readout) are pure props+callbacks.
import { useEffect, useRef, useState } from "preact/hooks";

import type { Engine } from "../engine/types";
import {
  CloseIcon,
  CogIcon,
  CopyIcon,
  DownloadIcon,
  GripIcon,
  PauseIcon,
  PlayIcon,
  StepBackIcon,
  StepForwardIcon,
} from "./icons";
import { handleControlKey } from "./keymap";
import { Readout } from "./Readout";
import { Scrubber } from "./Scrubber";
import { applySettings, changeSetting, initialSettings, SETTINGS_CONFIG } from "./settings";
import type { Settings } from "./settings";
import type { MenuAction } from "./SettingsMenu";
import { SettingsMenu } from "./SettingsMenu";
import { useEngineState } from "./useEngineState";

/**
 * Getting the frame on screen out of the player. Both take the frame index so
 * the caller doesn't have to track playback itself; the results (a toast, an
 * error) are the caller's business, so nothing is returned here. Properties
 * rather than methods, because the menu rows pass them along as bare callbacks.
 */
export interface FrameActions {
  /** Put the frame at `index` on the clipboard. */
  copy: (index: number) => void;
  /** Download the frame at `index`. */
  save: (index: number) => void;
}

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
  /**
   * Move the bar by `dx`/`dy` viewport pixels. The keyboard counterpart to
   * `onDragStart`: a pointer is not the only way a user may need the bar off the
   * part of the image they are looking at. Same owner as the drag — the host
   * does the positioning — so it arrives the same way.
   */
  onNudge?: (dx: number, dy: number) => void;
  /** Called when the user clicks the close button; tears down the player. */
  onClose?: () => void;
  /**
   * Export the frame currently on screen. Surfaced as rows in the settings
   * menu rather than buttons in the bar, which keeps the bar compact. Omitted
   * — e.g. in component tests — means no export rows at all.
   */
  frameActions?: FrameActions;
}

// How far one arrow key moves the bar, and the finer step Shift asks for.
const NUDGE_PX = 8;
const FINE_NUDGE_PX = 1;

/** Unit direction for each arrow key the grip nudges with. */
const NUDGE_KEYS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

const useScrubResume = () => {
  const ref = useRef(false);
  return {
    save: (playing: boolean) => {
      ref.current = playing;
    },
    saved: () => ref.current,
  };
};

/** Top-level controls bar. */
export function Controls({
  engine,
  onDragStart,
  onResetPosition,
  onNudge,
  onClose,
  frameActions,
}: ControlsProps) {
  const { playing, index, frameCount, currentTime, duration } = useEngineState(engine);

  // With a single frame there's nothing to play or step through. At the ends we
  // let the engine clamp rather than disabling the buttons, so they don't
  // flicker disabled on every loop during playback.
  const steppable = frameCount > 1;

  // Remember whether playback was running when a scrub began, to resume on release.
  const scrubResume = useScrubResume();

  // Playback settings. Held locally (not persisted) and seeded from the source
  // (via the engine) so they reset to the source's own defaults every time the
  // controls are re-mounted — i.e. when the overlay disappears.
  const [settings, setSettings] = useState<Settings>(() => initialSettings(engine));
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
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menuOpen]);

  const closeMenu = (): void => {
    setMenuOpen(false);
    cogRef.current?.focus();
  };

  // Keyboard equivalent of dragging the grip: arrows nudge (Shift for a single
  // pixel), Enter/Space snaps back to the default spot the way a double-click
  // does. Handled on the grip itself and stopped there, so the arrows don't also
  // step frames and Space doesn't also toggle playback on the bar behind it.
  const onGripKeyDown = (event: KeyboardEvent): void => {
    const direction = NUDGE_KEYS[event.key];
    const step = event.shiftKey ? FINE_NUDGE_PX : NUDGE_PX;
    if (direction && onNudge) {
      onNudge(direction.x * step, direction.y * step);
    } else if ((event.key === "Enter" || event.key === " ") && onResetPosition) {
      onResetPosition();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  // Export rows for the menu. The action runs BEFORE the menu closes so the
  // clipboard write starts inside this click, while its user activation is
  // still live (see content/exportFrame).
  const runAction = (action: (index: number) => void) => (): void => {
    action(index);
    closeMenu();
  };
  const menuActions: MenuAction[] = frameActions
    ? [
        {
          id: "copy-frame",
          label: "Copy frame",
          icon: <CopyIcon />,
          run: runAction(frameActions.copy),
        },
        {
          id: "save-frame",
          label: "Save frame…",
          icon: <DownloadIcon />,
          run: runAction(frameActions.save),
        },
      ]
    : [];

  return (
    // Focus-scoped keyboard shortcuts: the bar is focusable so
    // Space/arrows only drive *this* GIF when its controls have focus — no
    // document-level capture, so two GIFs never react to one keypress and page
    // text inputs keep their keys.
    <div
      class="bar"
      // A focusable element with no accessible name announces as just "group";
      // there may be two of these on a page, so say which one this is.
      role="group"
      aria-label="Jiffy playback controls"
      tabIndex={0}
      onFocusOut={(event) => {
        // Tab out of the roving-tabindex menu (or a click that lands elsewhere)
        // leaves it open behind the focus. Close it, but don't pull focus back
        // to the cog — the user asked to be somewhere else.
        const wrapper = settingsRef.current;
        const next = event.relatedTarget;
        if (!menuOpen || !wrapper) return;
        if (next instanceof Node && wrapper.contains(next)) return;
        setMenuOpen(false);
      }}
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
        // Move handle. Focusable and arrow-nudgeable, not pointer-only: it
        // carries a button role and label, and a control that announces itself
        // and then can't be operated is worse than none. A <div> rather than a
        // <button> so Space and the arrows reach onGripKeyDown intact instead of
        // being spent on native activation.
        <div
          class="grip"
          role="button"
          tabIndex={0}
          aria-label="Move controls"
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Enter"
          title="Drag or arrow-key to move · double-click or Enter to reset"
          onPointerDown={(event) => onDragStart(event)}
          onDblClick={() => onResetPosition?.()}
          onKeyDown={onGripKeyDown}
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
          scrubResume.save(engine.state.playing);
          engine.pause();
        }}
        onScrubEnd={() => {
          if (scrubResume.saved()) engine.play();
        }}
      />

      <Readout index={index} frameCount={frameCount} time={currentTime} duration={duration} />

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
                setSettings((prev) => changeSetting(SETTINGS_CONFIG, prev, id, value))
              }
              actions={menuActions}
            />
          </div>
        )}
      </div>

      {onClose && (
        <button type="button" class="icon" aria-label="Close" onClick={() => onClose()}>
          <CloseIcon />
        </button>
      )}
    </div>
  );
}
