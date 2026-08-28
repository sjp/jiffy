// Component test for <SettingsMenu>. Driven with mock configs (options + toggle)
// so the component's behaviour is verified independently of the live
// SETTINGS_CONFIG. Same harness as the other UI tests: jsdom + preact
// render/act, plain node:assert.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";

import { render } from "preact";
import { act } from "preact/test-utils";

import type { Settings, SettingsEntry, SettingValue } from "./settings.ts";
import { SettingsMenu } from "./SettingsMenu.tsx";

const config: SettingsEntry[] = [
  {
    id: "speed",
    label: "Speed",
    kind: "options",
    default: 1,
    options: [
      { value: 0.5, label: "0.5×" },
      { value: 1, label: "Normal" },
      { value: 2, label: "2×" },
    ],
  },
];

let settings: Settings = { speed: 1 };
const changes: Array<[string, SettingValue]> = [];
const onChange = (id: string, value: SettingValue): void => {
  changes.push([id, value]);
  settings = { ...settings, [id]: value };
};

const container = document.createElement("div");
document.body.appendChild(container);

const renderMenu = (): void => {
  act(() => {
    render(<SettingsMenu config={config} settings={settings} onChange={onChange} />, container);
  });
};

renderMenu();

const rows = () => Array.from(container.querySelectorAll("button.menu-row"));
const text = () => container.textContent ?? "";

// Main panel: one row showing label + current value, marked as a menuitem.
assert.equal(rows().length, 1, "one main-menu row");
assert.equal(
  container.querySelector('[role="menu"]')?.getAttribute("aria-label"),
  "Settings",
  "main panel is a labelled menu",
);
assert.match(text(), /Speed/, "row shows the entry label");
assert.match(text(), /Normal/, "row shows the current value");
assert.equal(rows()[0]!.getAttribute("role"), "menuitem", "main row is menuitem");

// Open the sub-panel.
act(() => rows()[0]!.click());
const radios = () => Array.from(container.querySelectorAll('[role="menuitemradio"]'));
assert.equal(radios().length, 3, "sub-panel lists the three options");
const checked = radios().filter((r) => r.getAttribute("aria-checked") === "true");
assert.equal(checked.length, 1, "exactly one option is checked");
assert.match(checked[0]!.textContent ?? "", /Normal/, "Normal is checked");

// Select a new option → onChange fires; the panel returns to the main list.
const twoX = radios().find((r) => (r.textContent ?? "").includes("2×"))!;
act(() => (twoX as HTMLElement).click());
assert.deepEqual(changes.at(-1), ["speed", 2], "onChange got the new value");

// Re-render with the parent-owned value, as <Controls> would.
renderMenu();
assert.equal(rows().length, 1, "returned to the main panel after choosing");
assert.match(text(), /2×/, "main row reflects the new value");

// Back header returns to main without making a change.
act(() => rows()[0]!.click());
const back = container.querySelector("button.menu-back") as HTMLElement;
assert.ok(back, "sub-panel has a back button");
const before = changes.length;
act(() => back.click());
assert.equal(rows().length, 1, "back returns to the main panel");
assert.equal(changes.length, before, "back makes no changes");

// ---- toggle entries flip in place (no sub-panel) -------------------------
const toggleConfig: SettingsEntry[] = [
  { id: "loop", label: "Loop", kind: "toggle", default: true },
];
let toggleSettings: Settings = { loop: true };
const toggleChanges: Array<[string, SettingValue]> = [];
const renderToggle = (): void => {
  act(() => {
    render(
      <SettingsMenu
        config={toggleConfig}
        settings={toggleSettings}
        onChange={(id, value) => {
          toggleChanges.push([id, value]);
          toggleSettings = { ...toggleSettings, [id]: value };
        }}
      />,
      container,
    );
  });
};

renderToggle();
const toggleRow = () => container.querySelector('[role="menuitemcheckbox"]') as HTMLElement;
assert.ok(toggleRow(), "toggle renders as a menuitemcheckbox (no sub-panel)");
assert.equal(toggleRow().getAttribute("aria-checked"), "true", "starts checked");

act(() => toggleRow().click());
assert.deepEqual(toggleChanges.at(-1), ["loop", false], "click flips to false");
renderToggle();
assert.equal(toggleRow().getAttribute("aria-checked"), "false", "now unchecked");

// ---- action rows ---------------------------------------------------------
// Actions are one-shot rows below the settings, separated by a rule so the two
// kinds of row don't read as one list.
const ran: string[] = [];
const renderWithActions = (entries: SettingsEntry[]): void => {
  act(() => {
    render(
      <SettingsMenu
        config={entries}
        settings={{ loop: true }}
        onChange={() => {}}
        actions={[
          { id: "copy", label: "Copy frame", run: () => ran.push("copy") },
          { id: "save", label: "Save frame…", run: () => ran.push("save") },
        ]}
      />,
      container,
    );
  });
};

renderWithActions(toggleConfig);
const actionRow = (label: string) =>
  rows().find((r) => (r.textContent ?? "").includes(label)) as HTMLElement;
assert.equal(rows().length, 3, "the toggle plus the two actions");
assert.ok(container.querySelector('[role="separator"]'), "a rule divides settings from actions");
assert.equal(actionRow("Copy frame").getAttribute("role"), "menuitem", "actions are menuitems");
assert.equal(
  actionRow("Copy frame").getAttribute("aria-checked"),
  null,
  "an action holds no value, so it is not checkable",
);

act(() => actionRow("Save frame…").click());
assert.deepEqual(ran, ["save"], "picking a row runs that action");

// Actions alone still make a menu — the "No settings" placeholder is for a
// genuinely empty one, and no rule is drawn with nothing above it.
renderWithActions([]);
assert.equal(rows().length, 2, "just the actions");
assert.equal(container.querySelector(".menu-empty"), null, "not treated as empty");
assert.equal(container.querySelector('[role="separator"]'), null, "no rule with nothing above it");

render(null, container);
console.log("SettingsMenu.test: OK");
