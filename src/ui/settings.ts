// Playback settings: the data-driven model behind the settings cog menu.
//
// The menu is described by data, not hand-written JSX: each feature is one entry
// in SETTINGS_CONFIG plus its behaviour in applySettings — <SettingsMenu> renders
// whatever entries it's given.
//
// Settings are intentionally NOT persisted. They live in <Controls> local state
// (seeded by initialSettings); the controls are re-created per image and unmounted
// when the player is torn down, so values reset to their defaults every time the
// overlay disappears. Defaults can be source-derived (see `deriveDefault`).
import type { Engine } from "../engine/types";

/** A single setting's value. Discrete choices (and toggles) cover the menu UI. */
export type SettingValue = string | number | boolean;

/** One selectable choice shown inside an entry's sub-panel. */
export interface SettingsOption {
  value: SettingValue;
  label: string;
}

/**
 * One menu entry.
 * - `toggle`: an inline on/off row (boolean value); no sub-panel.
 * - `options`: a row that opens a sub-panel of {@link SettingsOption} choices.
 */
export interface SettingsEntry {
  /** Stable key; also the field name under which the value is stored. */
  id: string;
  /** Row label, e.g. "Loop" or "Playback speed". */
  label: string;
  kind: "toggle" | "options";
  /** Default value when no per-source default applies. */
  default: SettingValue;
  /** Choices for `kind: "options"` (ignored for toggles). */
  options?: SettingsOption[];
  /**
   * Optional per-source default, computed from the engine at mount time (e.g.
   * loop derived from the image's own loop setting). Falls back to `default`.
   */
  deriveDefault?: (engine: Engine) => SettingValue;
}

/** Current values, keyed by entry id. */
export type Settings = Record<string, SettingValue>;

/** The menu definition. Append an entry here to surface a new setting. */
export const SETTINGS_CONFIG: SettingsEntry[] = [
  {
    id: "loop",
    label: "Loop",
    kind: "toggle",
    default: true,
    // The engine is seeded from the source's loop setting (content pipeline), so
    // the toggle starts matching how the image normally plays.
    deriveDefault: (engine) => engine.state.loop,
  },
];

/** Build the initial settings for a freshly-mounted player. */
export function initialSettings(engine: Engine): Settings {
  return Object.fromEntries(
    SETTINGS_CONFIG.map((entry) => [
      entry.id,
      entry.deriveDefault ? entry.deriveDefault(engine) : entry.default,
    ]),
  );
}

/** Human-readable text for an entry's current value (the matching option label). */
export function valueLabel(
  entry: SettingsEntry,
  value: SettingValue | undefined,
): string {
  const option = entry.options?.find((o) => o.value === value);
  if (option) return option.label;
  return value === undefined ? "" : String(value);
}

/**
 * Apply settings to the engine — the single seam where settings drive playback.
 * Each feature reads its value and drives the engine here.
 */
export function applySettings(engine: Engine, settings: Settings): void {
  engine.setLoop(settings.loop === true);
}
