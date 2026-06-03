// Playback settings: the data-driven model behind the settings cog menu.
//
// The menu is described by data, not hand-written JSX: each future feature
// (playback speed, loop mode, …) is added by appending one entry to
// SETTINGS_CONFIG plus its real behaviour in applySettings — the <SettingsMenu>
// component renders whatever entries it's given.
//
// Settings are intentionally NOT persisted. They live in <Controls> local state
// (useState(DEFAULTS)); the controls are re-created per image and unmounted when
// the player is torn down, so values reset to DEFAULTS every time the overlay
// disappears — exactly the desired behaviour, for free.
import type { Engine } from "../engine/types";

/** A single setting's value. Discrete choices (and toggles) cover the menu UI. */
export type SettingValue = string | number | boolean;

/** One selectable choice shown inside an entry's sub-panel. */
export interface SettingsOption {
  value: SettingValue;
  label: string;
}

/** One main-menu row that opens a sub-panel of {@link SettingsOption} choices. */
export interface SettingsEntry {
  /** Stable key; also the field name under which the value is stored. */
  id: string;
  /** Row label shown in the main panel, e.g. "Playback speed". */
  label: string;
  /** Default value applied on mount and restored on teardown. */
  default: SettingValue;
  /** Choices listed in this entry's sub-panel. */
  options: SettingsOption[];
}

/** Current values, keyed by entry id. */
export type Settings = Record<string, SettingValue>;

/**
 * The menu definition. Empty for now — the cog opens an (empty) menu until the
 * first feature lands. Append an entry here to surface a new setting.
 */
export const SETTINGS_CONFIG: SettingsEntry[] = [];

/** Initial values, derived from each entry's `default`. */
export const DEFAULTS: Settings = Object.fromEntries(
  SETTINGS_CONFIG.map((entry) => [entry.id, entry.default]),
);

/** Human-readable text for an entry's current value (the matching option label). */
export function valueLabel(
  entry: SettingsEntry,
  value: SettingValue | undefined,
): string {
  const option = entry.options.find((o) => o.value === value);
  if (option) return option.label;
  return value === undefined ? "" : String(value);
}

/**
 * Apply settings to the engine. This is the single seam where settings drive
 * playback. No features are wired yet — each future feature reads its value from
 * `settings` (e.g. `settings.speed`) and drives `engine` here.
 */
export function applySettings(engine: Engine, settings: Settings): void {
  void engine;
  void settings;
}
