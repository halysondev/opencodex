/**
 * The key list, as a table (devlog 260802/020, revised after the maintainer asked
 * for a top strip instead of a side rail).
 *
 * This replaces the workspace rail. A rail and a content pane were two vertical
 * bands competing for the same width; a table is also the better surface for what
 * these rows are, which is comparative — requests and last-used sort, a rail does
 * not. Selecting a row opens the existing detail pane.
 */
import { useEffect, useState } from "react";
import { useT } from "../../i18n/shared";
import { formatCreatedDate, formatUsd, hasApiKeyQuota, type ApiKeyEntry } from "../../pages/api-keys-utils";
import type { UsageReadMetadata } from "../../usage-summary-resource";
import { UsageIncompleteNotice } from "../usage-incomplete-notice";

export default function ApiKeysListPanel({
  keys,
  keysLoading,
  keysLoadFailed,
  attributionSince,
  usageMetadata,
  localeTag,
  busy,
  onSelect,
  onResetAllQuotas,
}: {
  keys: ApiKeyEntry[];
  keysLoading: boolean;
  keysLoadFailed: boolean;
  /** Absent means nothing is attributable yet — different from a counter reading zero. */
  attributionSince?: string;
  usageMetadata?: UsageReadMetadata;
  localeTag?: string;
  /** A mutation is in flight; its result is bound to one key, so navigation waits. */
  busy: boolean;
  onSelect: (id: string) => void;
  onResetAllQuotas: () => Promise<boolean>;
}) {
  const t = useT();
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [resetFailed, setResetFailed] = useState(false);

  // Same armed-confirm shape the detail pane's delete uses: the confirm button
  // cannot fire on the click that revealed it.
  useEffect(() => {
    if (!resetConfirm) return;
    const timer = window.setTimeout(() => setResetArmed(true), 300);
    return () => window.clearTimeout(timer);
  }, [resetConfirm]);

  const confirmResetAll = async () => {
    if (!resetArmed || resetPending) return;
    setResetPending(true);
    setResetFailed(false);
    try {
      if (await onResetAllQuotas()) {
        setResetConfirm(false);
        setResetArmed(false);
      } else {
        setResetFailed(true);
      }
    } finally {
      setResetPending(false);
    }
  };

  return (
    <div className="panel api-panel awi-keylist-panel" aria-busy={keysLoading}>
      <div className="api-panel-head">
        <h3 className="panel-title">
          {keysLoading ? t("api.activeKeysLoading") : t("api.activeKeys", { count: keys.length })}
        </h3>
        {keys.length > 0 && (
          resetConfirm ? (
            <span className="api-actions">
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={!resetArmed || resetPending}
                onClick={() => { void confirmResetAll(); }}
              >
                {resetPending ? t("api.quota.resetting") : t("api.confirm")}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={resetPending}
                onClick={() => { setResetConfirm(false); setResetArmed(false); }}
              >
                {t("common.cancel")}
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => { setResetConfirm(true); setResetFailed(false); }}
            >
              {t("api.quota.resetAll")}
            </button>
          )
        )}
      </div>

      {resetConfirm && (
        <p className="muted small">{t("api.quota.resetAllConfirm")}</p>
      )}
      {resetFailed && (
        <p className="awi-delete-error" role="alert">{t("api.quota.resetAllFailed")}</p>
      )}

      <UsageIncompleteNotice data={usageMetadata} />
      {keysLoading ? (
        <div className="api-active-keys-skeleton" role="status" aria-label={t("common.loading")} />
      ) : keys.length === 0 ? (
        // Two different sentences: a catalog we could not read is not an empty one.
        <p className="muted small">{keysLoadFailed ? t("api.keysLoadFailed") : t("api.noKeys")}</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl awi-keylist-table">
            <thead>
              <tr>
                <th>{t("api.colName")}</th>
                <th>{t("api.colKey")}</th>
                <th>{t("api.attribution.requests7d")}</th>
                <th>{t("api.attribution.lastUsed")}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map(k => (
                <tr key={k.id}>
                  <td>
                    {/* A real button, not a clickable row: a `<tr>` with onClick is
                        unreachable by keyboard. */}
                    <button
                      type="button"
                      className="awi-keylist-name"
                      disabled={busy}
                      onClick={() => onSelect(k.id)}
                    >
                      {k.name}
                    </button>
                    {hasApiKeyQuota(k) && <span className="awi-keylist-spend muted small">
                      {k.quota.dailyUsd > 0
                        ? t("api.quota.railSpend", {
                          spent: formatUsd(k.spend.dailyUsd, localeTag),
                          limit: formatUsd(k.quota.dailyUsd, localeTag),
                        })
                        : t("api.quota.railSpendUnlimited", {
                          spent: formatUsd(k.spend.dailyUsd, localeTag),
                        })}
                    </span>}
                  </td>
                  <td><code>{k.prefix}</code></td>
                  <td>
                    {!attributionSince
                      ? t("api.attribution.unavailable")
                      : k.usage.ambiguous
                        ? t("api.attribution.railAmbiguous")
                        : k.usage.requests7d.toLocaleString(localeTag)}
                  </td>
                  <td>
                    {!attributionSince || k.usage.ambiguous
                      ? "—"
                      : k.usage.lastUsedAt
                        ? formatCreatedDate(k.usage.lastUsedAt, localeTag)
                        : t(usageMetadata?.usageIncomplete ? "api.attribution.noRecordedUse" : "api.attribution.neverUsed")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
