/**
 * Per-key USD spend quota editor. Three rolling windows (24 h / 7 d / 30 d),
 * `0` means unlimited. The backend reports `quota` (the configured limits) and
 * `spend` (the estimated usage against them); this pane edits the limits,
 * shows progress against each one, and can zero the recorded spend.
 *
 * Drafts are intentionally pessimistic: a failed save keeps the user's input
 * and shows an inline error rather than snapping back to the server values.
 * Remounting (the caller keys this component by key id) is what resets the
 * draft, so a refresh of the same key never discards an in-progress edit.
 */
import { useState } from "react";
import { useT } from "../../i18n/shared";
import { formatCreatedDate, formatUsd, type ApiKeyQuotaEntry, type ApiKeyQuota } from "../../pages/api-keys-utils";

const WINDOWS = [
  { field: "dailyUsd", labelKey: "api.quota.daily", spendField: "dailyUsd" },
  { field: "weeklyUsd", labelKey: "api.quota.weekly", spendField: "weeklyUsd" },
  { field: "monthlyUsd", labelKey: "api.quota.monthly", spendField: "monthlyUsd" },
] as const;

function draftFrom(entry: ApiKeyQuotaEntry): Record<(typeof WINDOWS)[number]["field"], string> {
  return {
    dailyUsd: entry.quota.dailyUsd > 0 ? String(entry.quota.dailyUsd) : "",
    weeklyUsd: entry.quota.weeklyUsd > 0 ? String(entry.quota.weeklyUsd) : "",
    monthlyUsd: entry.quota.monthlyUsd > 0 ? String(entry.quota.monthlyUsd) : "",
  };
}

export default function ApiKeyQuotaEditor({
  entry,
  localeTag,
  onSave,
  onReset,
}: {
  entry: ApiKeyQuotaEntry;
  localeTag?: string;
  onSave: (id: string, quota: ApiKeyQuota | null) => Promise<boolean>;
  onReset: (id: string) => Promise<boolean>;
}) {
  const t = useT();
  const [draft, setDraft] = useState(() => draftFrom(entry));
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [resetFailed, setResetFailed] = useState(false);

  const parsed = WINDOWS.map(w => {
    const raw = draft[w.field].trim();
    if (raw === "") return { field: w.field, value: 0, valid: true };
    const n = Number(raw);
    return { field: w.field, value: n, valid: Number.isFinite(n) && n >= 0 };
  });
  const valid = parsed.every(p => p.valid);
  const dirty = parsed.some(p => !p.valid || p.value !== entry.quota[p.field]);

  const save = async () => {
    if (!valid || !dirty || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      const quota: ApiKeyQuota = {
        dailyUsd: parsed.find(p => p.field === "dailyUsd")!.value,
        weeklyUsd: parsed.find(p => p.field === "weeklyUsd")!.value,
        monthlyUsd: parsed.find(p => p.field === "monthlyUsd")!.value,
      };
      const allZero = quota.dailyUsd === 0 && quota.weeklyUsd === 0 && quota.monthlyUsd === 0;
      // All-zero clears the quota server-side (`null`), keeping the stored
      // entry free of an object that would mean "unlimited" anyway.
      if (await onSave(entry.id, allZero ? null : quota)) {
        setDraft({
          dailyUsd: quota.dailyUsd > 0 ? String(quota.dailyUsd) : "",
          weeklyUsd: quota.weeklyUsd > 0 ? String(quota.weeklyUsd) : "",
          monthlyUsd: quota.monthlyUsd > 0 ? String(quota.monthlyUsd) : "",
        });
      } else {
        setSaveFailed(true);
      }
    } finally {
      setSaving(false);
    }
  };

  const armReset = () => {
    setResetConfirm(true);
    setResetFailed(false);
    setResetArmed(false);
    // Same armed-confirm pattern as delete: the button that revealed the
    // confirm cannot also fire it in the same click.
    window.setTimeout(() => setResetArmed(true), 300);
  };

  const confirmReset = async () => {
    if (!resetArmed || resetPending) return;
    setResetPending(true);
    setResetFailed(false);
    try {
      if (await onReset(entry.id)) setResetConfirm(false);
      else setResetFailed(true);
    } finally {
      setResetPending(false);
    }
  };

  return (
    <section className="awi-quota-editor" aria-label={t("api.quota.title")}>
      <h4 className="panel-title">{t("api.quota.title")}</h4>
      <p className="muted small">{t("api.quota.estimateNote")}</p>
      <div className="awi-quota-rows">
        {WINDOWS.map(w => {
          const limit = entry.quota[w.field];
          const spent = entry.spend[w.spendField];
          const ratio = limit > 0 ? Math.min(1, spent / limit) : 0;
          return (
            <div className="awi-quota-row" key={w.field}>
              <div>
                <div className="awi-quota-row-head">
                  <span>{t(w.labelKey)}</span>
                  <span className="muted small">
                    {limit > 0
                      ? t("api.quota.spentOfLimit", { spent: formatUsd(spent, localeTag), limit: formatUsd(limit, localeTag) })
                      : t("api.quota.spentUnlimited", { spent: formatUsd(spent, localeTag) })}
                  </span>
                </div>
                <span
                  className="awi-progressbar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={limit > 0 ? limit : 1}
                  aria-valuenow={limit > 0 ? Math.min(spent, limit) : 0}
                  aria-label={t(w.labelKey)}
                >
                  <span className="awi-progressbar-fill" style={{ width: `${ratio * 100}%` }} />
                </span>
              </div>
              <label className="awi-quota-inputs">
                <input
                  type="number"
                  className="input awi-quota-input"
                  min={0}
                  step={0.01}
                  inputMode="decimal"
                  aria-label={t(w.labelKey)}
                  placeholder={t("api.quota.unlimitedPlaceholder")}
                  value={draft[w.field]}
                  disabled={saving}
                  onChange={event => setDraft(d => ({ ...d, [w.field]: event.target.value }))}
                />
              </label>
            </div>
          );
        })}
      </div>
      {entry.spend.unpricedRequests > 0 && (
        <p className="muted small">{t("api.quota.unpricedNote", { count: entry.spend.unpricedRequests })}</p>
      )}
      {entry.quotaResetAt && (
        <p className="muted small">{t("api.quota.lastReset", { date: formatCreatedDate(entry.quotaResetAt, localeTag) })}</p>
      )}
      {!valid && <p className="awi-quota-error" role="alert">{t("api.quota.invalidValue")}</p>}
      {saveFailed && <p className="awi-quota-error" role="alert">{t("api.quota.saveFailed")}</p>}
      {resetFailed && <p className="awi-quota-error" role="alert">{t("api.quota.resetFailed")}</p>}
      <div className="awi-quota-meta">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!valid || !dirty || saving}
          onClick={() => { void save(); }}
        >
          {saving ? t("api.quota.saving") : t("api.quota.save")}
        </button>
        {resetConfirm ? (
          <span className="api-actions">
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={!resetArmed || resetPending}
              onClick={() => { void confirmReset(); }}
            >
              {resetPending ? t("api.quota.resetting") : t("api.confirm")}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={resetPending}
              onClick={() => setResetConfirm(false)}
            >
              {t("common.cancel")}
            </button>
          </span>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={armReset}>
            {t("api.quota.reset")}
          </button>
        )}
      </div>
      {resetConfirm && <p className="muted small">{t("api.quota.resetConfirm")}</p>}
    </section>
  );
}
