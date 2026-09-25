# wp3 — Models page: settings fold, sticky rail, wide layout

## File change map

| Path | Change |
|------|--------|
| `gui/src/pages/models-settings-panel.tsx` | NEW: `ModelsSettingsPanel` (details + summary + persisted open state) and `CustomModelsSummary` |
| `gui/src/pages/Models.tsx` | MODIFY: render panel above `.models-workspace-root`; replace custom-count IIFE with `<CustomModelsSummary>`; net line count must go down |
| `gui/src/styles-models-workspace.css` | MODIFY rail sticky + list height; ADD `.models-settings*` rules; widen catalog `.main-inner` |
| `gui/src/i18n/{en,de,fr,ko,zh,zh-TW,ru,ja,tr,vi}.ts` | ADD `models.settingsPanel.*` keys |
| `gui/tests/models-settings-panel.test.tsx` | ADD: summary lists state; open state persists |

## Component contract

```tsx
export interface SettingsSummaryItem { id: string; label: string; value: string }
export function ModelsSettingsPanel(props: {
  title: string;
  summary: SettingsSummaryItem[];
  children: ReactNode;
  storage?: StorageLike; // test seam
}): JSX.Element
```

- Native `<details className="models-settings">` with `<summary>`: chevron, title, then the
  summary items as compact `label value` pairs, ellipsized on one line.
- Open-state key `ocx.models.settingsOpen.v1` ("1"/"0"); default closed; `onToggle` writes.
- Body `.models-settings-body` renders `children` (the existing `controlsBlock`) unchanged, so
  every save/load handler is untouched.

Summary items are computed in `Models.tsx` in one expression: shadow (off or target model),
sub-agent mode, default window, picker order.

## Models.tsx diff sketch

```diff
+      <ModelsSettingsPanel title={t("models.settingsPanel.title")} summary={settingsSummary}>{controlsBlock}</ModelsSettingsPanel>
       <div className="models-workspace-root" ...>
 ...
         <section className="models-workspace-main" ...>
-          {controlsBlock}
           {collapseControls}
-      {(() => { const customCount = ...; return (<div ...>...</div>); })()}   // 12 lines
+      <CustomModelsSummary models={models} />
```

## CSS

```css
.main-inner:has(#models-panel-catalog:not([hidden])) { max-width: 1320px; }
.models-workspace-root { align-items: start; }
.models-workspace-rail {
  position: sticky; top: calc(<quota bar height> + var(--space-3));
  max-height: calc(100dvh - <quota bar height> - var(--space-6));
}
.models-workspace-rail-list { max-height: none; flex: 1 1 auto; }
@media (max-width: 768px) { .models-workspace-rail { position: static; max-height: none; } }
.models-settings { border: 1px solid var(--border); border-radius: var(--radius-md); }
@container models-workspace (min-width: 1000px) {
  .models-settings-body { two-column grid for the control rows }
}
```

The exact offset, and whether the quota bar exposes a height variable, are verified in B
against the rendered page; the rail must never slide under the quota bar.

## Acceptance (with activation)

- 1440x1000 viewport, scroll 1500px: rail `getBoundingClientRect().top` stays constant and
  below the quota bar while the model list scrolls.
- Settings closed by default: the first provider card starts within the first viewport;
  the summary reads like `Shadow off · Sub-agent v1 · Window 350k · Order Default`.
- Toggle open, reload: stays open. Controls still save (spot-check the sub-agent control on
  the dev server, then restore the original value).
- 1170px: two columns, no horizontal overflow. 720px: rail stacks and is not sticky.
- `Models.tsx` line count < 2787; file-size ratchet green; `gui/tests/i18n-locales.test.ts` green.
