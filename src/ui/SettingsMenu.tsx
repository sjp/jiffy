// <SettingsMenu> — the popover contents behind the settings cog.
//
// YouTube-style navigation: a main panel lists each setting (label + current
// value + chevron); clicking a row opens an in-place sub-panel of choices with a
// checkmark on the active one. Selecting returns to the main panel so several
// settings can be adjusted in a row.
//
// Pure/presentational like <Scrubber>/<Readout>: it owns only ephemeral
// navigation state (which sub-panel is open); the selected VALUES live in
// <Controls> and arrive via props, so reset-on-teardown is handled there.
import { useState } from "preact/hooks";
import type { Settings, SettingsEntry, SettingValue } from "./settings";
import { valueLabel } from "./settings";
import { BackIcon, CheckIcon, ChevronRightIcon } from "./icons";

export interface SettingsMenuProps {
  /** Menu definition (SETTINGS_CONFIG, or a mock in tests). */
  config: SettingsEntry[];
  /** Current values, keyed by entry id. */
  settings: Settings;
  /** Commit a new value for an entry. */
  onChange: (id: string, value: SettingValue) => void;
}

export function SettingsMenu({
  config,
  settings,
  onChange,
}: SettingsMenuProps) {
  // id of the open sub-panel; null = the main list. Ephemeral nav state only.
  const [openId, setOpenId] = useState<string | null>(null);
  const entry = openId ? (config.find((e) => e.id === openId) ?? null) : null;

  // Sub-panel: a back header + the entry's options with a check on the active one.
  if (entry) {
    return (
      <div class="menu-panel" role="menu" aria-label={entry.label}>
        <button
          type="button"
          class="menu-row menu-back"
          aria-label="Back"
          onClick={() => setOpenId(null)}
        >
          <span class="menu-check">
            <BackIcon />
          </span>
          <span class="menu-label">{entry.label}</span>
        </button>
        {(entry.options ?? []).map((option) => {
          const active = settings[entry.id] === option.value;
          return (
            <button
              key={String(option.value)}
              type="button"
              class="menu-row"
              role="menuitemradio"
              aria-checked={active}
              onClick={() => {
                onChange(entry.id, option.value);
                setOpenId(null); // back to the main panel after choosing
              }}
            >
              <span class="menu-check">{active && <CheckIcon />}</span>
              <span class="menu-label">{option.label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  // Main panel.
  if (config.length === 0) {
    return (
      <div class="menu-panel" role="menu" aria-label="Settings">
        <div class="menu-empty">No settings</div>
      </div>
    );
  }

  return (
    <div class="menu-panel" role="menu" aria-label="Settings">
      {config.map((e) =>
        e.kind === "toggle" ? (
          // Inline toggle: clicking flips the value in place, with a leading
          // checkmark when on. No sub-panel.
          <button
            key={e.id}
            type="button"
            class="menu-row"
            role="menuitemcheckbox"
            aria-checked={settings[e.id] === true}
            onClick={() => onChange(e.id, settings[e.id] !== true)}
          >
            <span class="menu-check">
              {settings[e.id] === true && <CheckIcon />}
            </span>
            <span class="menu-label">{e.label}</span>
          </button>
        ) : (
          <button
            key={e.id}
            type="button"
            class="menu-row"
            role="menuitem"
            aria-haspopup="menu"
            onClick={() => setOpenId(e.id)}
          >
            <span class="menu-label">{e.label}</span>
            <span class="menu-value">
              {valueLabel(e, settings[e.id])}
              <ChevronRightIcon />
            </span>
          </button>
        ),
      )}
    </div>
  );
}
