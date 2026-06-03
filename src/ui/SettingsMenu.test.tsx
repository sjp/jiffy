// Component test for <SettingsMenu>. Driven with a mock config so behaviour is
// verifiable while SETTINGS_CONFIG is still empty. Same harness as the other UI
// tests: jsdom + preact render/act, plain node:assert.
import "../test/setup-dom.ts";
import assert from "node:assert/strict";
import { render } from "preact";
import { act } from "preact/test-utils";
import { SettingsMenu } from "./SettingsMenu.tsx";
import type { Settings, SettingsEntry, SettingValue } from "./settings.ts";

const config: SettingsEntry[] = [
  {
    id: "speed",
    label: "Speed",
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
    render(
      <SettingsMenu config={config} settings={settings} onChange={onChange} />,
      container,
    );
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
assert.equal(
  rows()[0]!.getAttribute("role"),
  "menuitem",
  "main row is menuitem",
);

// Open the sub-panel.
act(() => rows()[0]!.click());
const radios = () =>
  Array.from(container.querySelectorAll('[role="menuitemradio"]'));
assert.equal(radios().length, 3, "sub-panel lists the three options");
const checked = radios().filter(
  (r) => r.getAttribute("aria-checked") === "true",
);
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

render(null, container);
console.log("SettingsMenu.test: OK");
