/**
 * Per-key model access editor. A key either calls every public model
 * ("all" — both lists unset) or a saved selection of providers and models.
 *
 * Scope semantics on the backend (see routeAllowedByScope): when BOTH
 * `allowedProviders` and `allowedModels` are set, a request must match both.
 * So a whole-provider pick for P plus individual models from Q cannot be sent
 * as `{providers: [P], models: [q/m]}` — Q's models would be denied because
 * they are not in provider P. To keep "entire provider P + these models of Q"
 * representable, this editor expands whole-provider selections into every
 * `provider/modelId` value that provider offers and sends them as
 * `allowedModels`. `allowedProviders` is only sent when the selection is
 * purely whole providers — plus any provider ids the entry already carries
 * that no longer exist in the options, which we cannot expand and must not
 * silently drop.
 *
 * The component remounts per key (the caller keys it by id), which resets the
 * selection state and the options fetch — the pane fetches its options when
 * it opens.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/shared";
import type { ApiKeyEntry } from "../../pages/api-keys-utils";

type ScopeOptions = {
  providers: string[];
  models: { value: string; publicId: string; provider: string }[];
};

type OptionsState =
  | { kind: "loading" }
  | { kind: "ready"; options: ScopeOptions }
  | { kind: "failed"; busy: boolean };

function isScopeOptions(value: unknown): value is ScopeOptions {
  if (!value || typeof value !== "object") return false;
  const v = value as { providers?: unknown; models?: unknown };
  return Array.isArray(v.providers)
    && v.providers.every(p => typeof p === "string")
    && Array.isArray(v.models)
    && v.models.every(m => m && typeof m === "object"
      && typeof (m as { value?: unknown }).value === "string"
      && typeof (m as { publicId?: unknown }).publicId === "string"
      && typeof (m as { provider?: unknown }).provider === "string");
}

export default function ApiKeyModelAccessEditor({
  apiBase,
  entry,
  onSave,
}: {
  apiBase: string;
  entry: ApiKeyEntry;
  onSave: (id: string, scope: { allowedModels: string[] | null; allowedProviders: string[] | null }) => Promise<boolean>;
}) {
  const t = useT();
  const hasScope = (entry.allowedProviders?.length ?? 0) > 0 || (entry.allowedModels?.length ?? 0) > 0;
  const [mode, setMode] = useState<"all" | "selected">(hasScope ? "selected" : "all");
  const [checkedProviders, setCheckedProviders] = useState<Set<string>>(
    () => new Set(entry.allowedProviders ?? []),
  );
  const [checkedModels, setCheckedModels] = useState<Set<string>>(
    () => new Set(entry.allowedModels ?? []),
  );
  const [baseline, setBaseline] = useState(() => ({
    providers: entry.allowedProviders ?? null,
    models: entry.allowedModels ?? null,
  }));
  const [query, setQuery] = useState("");
  const [optionsState, setOptionsState] = useState<OptionsState>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  // setState only happens in async callbacks — synchronous setState inside an
  // effect body would be a cascading render.
  const loadOptions = useCallback((signal?: AbortSignal) => {
    void fetch(`${apiBase}/api/keys/scope-options`, { signal })
      .then(async res => {
        if (res.status === 503) { setOptionsState({ kind: "failed", busy: true }); return; }
        if (!res.ok) { setOptionsState({ kind: "failed", busy: false }); return; }
        const body: unknown = await res.json();
        setOptionsState(isScopeOptions(body)
          ? { kind: "ready", options: body }
          : { kind: "failed", busy: false });
      })
      .catch(() => {
        if (!signal?.aborted) setOptionsState({ kind: "failed", busy: false });
      });
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    loadOptions(controller.signal);
    return () => controller.abort();
  }, [loadOptions]);

  const retryOptions = () => {
    setOptionsState({ kind: "loading" });
    loadOptions();
  };

  const options = optionsState.kind === "ready" ? optionsState.options : null;

  const providerGroups = useMemo(() => {
    if (!options) return [];
    const q = query.trim().toLowerCase();
    return options.providers.map(provider => ({
      provider,
      models: options.models.filter(m => m.provider === provider
        && (q === "" || m.publicId.toLowerCase().includes(q) || m.value.toLowerCase().includes(q))),
    })).filter(group => group.models.length > 0 || q === "");
  }, [options, query]);

  // Existing selections that no option offers any more are preserved, not
  // dropped: they stay visible and checked under an "Other / unavailable"
  // group until the user unchecks them.
  const unavailableModels = useMemo(() => {
    const known = new Set(options?.models.map(m => m.value) ?? []);
    return [...checkedModels].filter(value => !known.has(value));
  }, [options, checkedModels]);
  const unavailableProviders = useMemo(() => {
    const known = new Set(options?.providers ?? []);
    return [...checkedProviders].filter(provider => !known.has(provider));
  }, [options, checkedProviders]);

  const dirty = mode === "all"
    ? baseline.providers !== null || baseline.models !== null
    : (() => {
      const sameSet = (a: Set<string>, b: string[] | null) =>
        a.size === (b?.length ?? 0) && [...a].every(x => b?.includes(x));
      return !sameSet(checkedProviders, baseline.providers)
        || !sameSet(checkedModels, baseline.models);
    })();

  const toggleModel = (value: string) => {
    setCheckedModels(prev => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  };

  const toggleProvider = (provider: string) => {
    setCheckedProviders(prev => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider); else next.add(provider);
      return next;
    });
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      let payload: { allowedModels: string[] | null; allowedProviders: string[] | null };
      if (mode === "all") {
        payload = { allowedModels: null, allowedProviders: null };
      } else if (checkedModels.size === 0) {
        // Pure whole-provider selection: the providers list alone represents it.
        payload = { allowedModels: null, allowedProviders: [...checkedProviders] };
      } else {
        // Mixed selection: expand whole providers into their model values so
        // `allowedModels` alone expresses "all of P plus these models of Q".
        // A provider list here would AND with the models and deny Q's picks.
        const expanded = new Set(checkedModels);
        for (const provider of checkedProviders) {
          const providerModels = options?.models.filter(m => m.provider === provider) ?? [];
          for (const m of providerModels) expanded.add(m.value);
        }
        payload = {
          allowedModels: [...expanded],
          // Providers absent from the options cannot be expanded; keep them in
          // the provider list so the save does not silently widen/drop access.
          allowedProviders: unavailableProviders.length > 0 ? unavailableProviders : null,
        };
      }
      if (await onSave(entry.id, payload)) {
        setBaseline({ providers: payload.allowedProviders, models: payload.allowedModels });
        if (mode === "all") {
          setCheckedProviders(new Set());
          setCheckedModels(new Set());
        } else {
          setCheckedProviders(new Set(payload.allowedProviders ?? []));
          setCheckedModels(new Set(payload.allowedModels ?? []));
        }
      } else {
        setSaveFailed(true);
      }
    } finally {
      setSaving(false);
    }
  };

  const nothingSelected = mode === "selected" && checkedProviders.size === 0 && checkedModels.size === 0;
  // A provider id we cannot expand (not in options) combined with individual
  // models would intersect wrongly server-side; block the save rather than
  // guess.
  const unexpandableMix = mode === "selected" && checkedModels.size > 0 && unavailableProviders.length > 0;

  return (
    <section className="awi-access-editor" aria-label={t("api.access.title")}>
      <h4 className="panel-title">{t("api.access.title")}</h4>
      <div className="awi-access-modes" role="radiogroup" aria-label={t("api.access.title")}>
        <label>
          <input
            type="radio"
            name={`access-mode-${entry.id}`}
            checked={mode === "all"}
            onChange={() => setMode("all")}
          />
          {" "}{t("api.access.allModels")}
        </label>
        <label>
          <input
            type="radio"
            name={`access-mode-${entry.id}`}
            checked={mode === "selected"}
            onChange={() => setMode("selected")}
          />
          {" "}{t("api.access.onlySelected")}
        </label>
      </div>
      <p className="muted small">{t("api.access.bothMustMatch")}</p>
      <p className="muted small">{t("api.access.comboNote")}</p>

      {mode === "selected" && (
        optionsState.kind === "loading" ? (
          <p className="muted small">{t("common.loading")}</p>
        ) : optionsState.kind === "failed" ? (
          <div className="awi-access-error">
            <p className="muted small">
              {optionsState.busy ? t("api.access.catalogBusy") : t("api.access.loadFailed")}
            </p>
            <button type="button" className="btn btn-ghost btn-sm" onClick={retryOptions}>
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <>
            <input
              type="search"
              className="input awi-access-search"
              placeholder={t("api.access.search")}
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
            {providerGroups.map(group => (
              <div key={group.provider}>
                <div className="awi-access-provider-head">
                  <label className="awi-access-provider-check">
                    <input
                      type="checkbox"
                      checked={checkedProviders.has(group.provider)}
                      onChange={() => toggleProvider(group.provider)}
                    />
                    {t("api.access.entireProvider")}
                  </label>
                  <strong>{group.provider}</strong>
                </div>
                <div className="awi-access-entries">
                  {group.models.map(m => (
                    <label key={m.value} className="awi-access-entry">
                      <input
                        type="checkbox"
                        checked={checkedProviders.has(group.provider) || checkedModels.has(m.value)}
                        disabled={checkedProviders.has(group.provider)}
                        onChange={() => toggleModel(m.value)}
                      />
                      <span className="awi-access-entry-label">
                        {m.publicId}
                        {m.publicId !== m.value && <> (<code>{m.value}</code>)</>}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            {(unavailableModels.length > 0 || unavailableProviders.length > 0) && (
              <div>
                <div className="awi-access-provider-head"><strong>{t("api.access.otherGroup")}</strong></div>
                <div className="awi-access-entries">
                  {unavailableProviders.map(provider => (
                    <label key={`p:${provider}`} className="awi-access-entry">
                      <input
                        type="checkbox"
                        checked={checkedProviders.has(provider)}
                        onChange={() => toggleProvider(provider)}
                      />
                      <span className="awi-access-entry-label">
                        <code>{provider}</code> ({t("api.access.providerEntry")})
                      </span>
                    </label>
                  ))}
                  {unavailableModels.map(value => (
                    <label key={`m:${value}`} className="awi-access-entry">
                      <input
                        type="checkbox"
                        checked={checkedModels.has(value)}
                        onChange={() => toggleModel(value)}
                      />
                      <span className="awi-access-entry-label"><code>{value}</code></span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </>
        )
      )}

      {nothingSelected && mode === "selected" && (
        <p className="awi-access-error" role="alert">{t("api.access.nothingSelected")}</p>
      )}
      {unexpandableMix && (
        <p className="awi-access-error" role="alert">{t("api.access.mixedUnavailable")}</p>
      )}
      {saveFailed && <p className="awi-access-error" role="alert">{t("api.access.saveFailed")}</p>}
      <div className="awi-access-confirm">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!dirty || saving || nothingSelected || unexpandableMix}
          onClick={() => { void save(); }}
        >
          {saving ? t("api.access.saving") : t("api.access.save")}
        </button>
      </div>
    </section>
  );
}
