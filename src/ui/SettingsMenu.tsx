// <SettingsMenu> — the popover contents behind the settings cog.
//
// YouTube-style navigation: a main panel lists each setting (label + current
// value + chevron); clicking a row opens an in-place sub-panel of choices with a
// checkmark on the active one. Selecting returns to the main panel so several
// settings can be adjusted in a row.
//
// The menu also carries one-shot ACTIONS (copy/save the current frame) below
// the settings. They live here rather than as buttons in the bar so the bar
// stays compact; they hold no value, so they're a separate prop rather than a
// third `kind` of settings entry.
//
// Pure/presentational like <Scrubber>/<Readout>: it owns only ephemeral
// navigation state (which sub-panel is open, and which row has the focus); the
// selected VALUES live in <Controls> and arrive via props, so reset-on-teardown
// is handled there.
//
// It announces itself as a `menu`, so it has to behave like one: assistive tech
// tells the user to expect Up/Down/Home/End between the rows and Right/Left to
// enter and leave a sub-panel, and roving tabindex — one row in the tab order at
// a time — so Tab leaves the menu instead of walking it. See `onKeyDown`.
import type { VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { BackIcon, CheckIcon, ChevronRightIcon } from "./icons";
import type { Settings, SettingsEntry, SettingValue } from "./settings";
import { valueLabel } from "./settings";

/** A row that does something when picked, instead of holding a value. */
export interface MenuAction {
  /** Stable key. */
  id: string;
  /** Row label, e.g. "Copy frame". */
  label: string;
  /** Optional leading glyph, shown in the same slot as an option's checkmark. */
  icon?: VNode;
  /** Perform the action. */
  run: () => void;
}

export interface SettingsMenuProps {
  /** Menu definition (SETTINGS_CONFIG, or a mock in tests). */
  config: SettingsEntry[];
  /** Current values, keyed by entry id. */
  settings: Settings;
  /** Commit a new value for an entry. */
  onChange: (id: string, value: SettingValue) => void;
  /** Action rows appended below the settings. */
  actions?: MenuAction[];
}

/** The focusable rows of whichever panel is rendered, in DOM order. */
function rowsIn(panel: HTMLElement | null): HTMLButtonElement[] {
  return panel ? Array.from(panel.querySelectorAll<HTMLButtonElement>("button.menu-row")) : [];
}

export function SettingsMenu({ config, settings, onChange, actions = [] }: SettingsMenuProps) {
  // id of the open sub-panel; null = the main list. Ephemeral nav state only.
  const [openId, setOpenId] = useState<string | null>(null);
  const entry = openId ? (config.find((e) => e.id === openId) ?? null) : null;

  // Index of the row holding the menu's focus. Rows are numbered in DOM order:
  // in the main panel the settings then the actions, in a sub-panel the back
  // header then the options.
  const [active, setActive] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Whether row `i` is the one row in the tab order (roving tabindex). */
  const roving = (i: number): number => (i === active ? 0 : -1);

  // Leaving a sub-panel lands back on the row that opened it, not at the top.
  // Nav state like `openId`, and set in the same breath, so the effect below
  // sees both at once and runs a single time per panel change.
  const [returnRow, setReturnRow] = useState(0);
  const openPanel = (id: string, fromIndex: number): void => {
    setReturnRow(fromIndex);
    setOpenId(id);
  };

  // Whenever the panel changes — the menu opening, or a step in or out of a
  // sub-panel — put focus on the row that matters: the current choice in a
  // sub-panel (so the user starts on what is selected), and on the way back out
  // the row that opened it. This runs on mount too, which is the menu opening,
  // so <Controls> doesn't have to reach in and focus a row itself.
  useEffect(() => {
    const rows = rowsIn(panelRef.current);
    const checked = rows.findIndex((row) => row.getAttribute("aria-checked") === "true");
    // Clamped, so a remembered row can't point past the end of a shorter panel.
    const index = Math.min(openId ? Math.max(checked, 0) : returnRow, rows.length - 1);
    setActive(index);
    rows[index]?.focus();
  }, [openId, returnRow]);

  /** Move focus (and the tab stop) to row `index`, wrapping at either end. */
  const move = (index: number): void => {
    const rows = rowsIn(panelRef.current);
    if (rows.length === 0) return;
    const wrapped = ((index % rows.length) + rows.length) % rows.length;
    setActive(wrapped);
    rows[wrapped]?.focus();
  };

  // The keys `role="menu"` promises. Anything handled here is also stopped:
  // unhandled arrows would scroll the page behind the menu, and the bar's own
  // shortcuts sit one bubble up.
  const onKeyDown = (event: KeyboardEvent): void => {
    const rows = rowsIn(panelRef.current);
    const target = (event.target as Element | null)?.closest("button.menu-row");
    const current = target ? rows.indexOf(target as HTMLButtonElement) : -1;
    switch (event.key) {
      case "ArrowDown":
        move(current + 1);
        break;
      case "ArrowUp":
        move(current < 0 ? rows.length - 1 : current - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "ArrowRight": {
        // Only rows that own a sub-panel can be entered; the id rides on the row
        // so this doesn't have to re-derive which entry the focus is on.
        const id = target instanceof HTMLElement ? target.dataset.entry : undefined;
        if (entry || id === undefined) return;
        openPanel(id, current);
        break;
      }
      case "ArrowLeft":
        if (!entry) return;
        setOpenId(null);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  // Sub-panel: a back header + the entry's options with a check on the active one.
  if (entry) {
    return (
      <div
        class="menu-panel"
        role="menu"
        aria-label={entry.label}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <button
          type="button"
          class="menu-row menu-back"
          aria-label="Back"
          tabIndex={roving(0)}
          onClick={() => setOpenId(null)}
        >
          <span class="menu-check">
            <BackIcon />
          </span>
          <span class="menu-label">{entry.label}</span>
        </button>
        {(entry.options ?? []).map((option, i) => {
          const chosen = settings[entry.id] === option.value;
          return (
            <button
              key={String(option.value)}
              type="button"
              class="menu-row"
              role="menuitemradio"
              aria-checked={chosen}
              tabIndex={roving(i + 1)} // +1: the back header is row 0
              onClick={() => {
                onChange(entry.id, option.value);
                setOpenId(null); // back to the main panel after choosing
              }}
            >
              <span class="menu-check">{chosen && <CheckIcon />}</span>
              <span class="menu-label">{option.label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  // Main panel: the settings, then the actions under a divider.
  return (
    <div class="menu-panel" role="menu" aria-label="Settings" ref={panelRef} onKeyDown={onKeyDown}>
      {config.length === 0 && actions.length === 0 && <div class="menu-empty">No settings</div>}
      {config.map((e, i) =>
        e.kind === "toggle" ? (
          // Inline toggle: clicking flips the value in place, with a leading
          // checkmark when on. No sub-panel.
          <button
            key={e.id}
            type="button"
            class="menu-row"
            role="menuitemcheckbox"
            aria-checked={settings[e.id] === true}
            tabIndex={roving(i)}
            onClick={() => onChange(e.id, settings[e.id] !== true)}
          >
            <span class="menu-check">{settings[e.id] === true && <CheckIcon />}</span>
            <span class="menu-label">{e.label}</span>
          </button>
        ) : (
          <button
            key={e.id}
            type="button"
            class="menu-row"
            role="menuitem"
            aria-haspopup="menu"
            tabIndex={roving(i)}
            data-entry={e.id} // what ArrowRight opens
            onClick={() => openPanel(e.id, i)}
          >
            <span class="menu-label">{e.label}</span>
            <span class="menu-value">
              {valueLabel(e, settings[e.id])}
              <ChevronRightIcon />
            </span>
          </button>
        ),
      )}
      {config.length > 0 && actions.length > 0 && <div class="menu-sep" role="separator" />}
      {actions.map((action, i) => (
        <button
          key={action.id}
          type="button"
          class="menu-row"
          role="menuitem"
          tabIndex={roving(config.length + i)}
          onClick={() => action.run()}
        >
          <span class="menu-check">{action.icon}</span>
          <span class="menu-label">{action.label}</span>
        </button>
      ))}
    </div>
  );
}
