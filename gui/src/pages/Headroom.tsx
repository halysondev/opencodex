import { useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { readJsonOrThrow } from "../fetch-json";
import { formatTokens } from "../format-tokens";
import { IconActivity, IconRefresh } from "../icons";
import { useI18n } from "../i18n/shared";
import { Notice, Switch } from "../ui";

interface HeadroomCompression {
  requests_compressed?: number;
  avg_compression_pct?: number;
  best_compression_pct?: number;
  total_tokens_removed?: number;
  total_tokens_before?: number;
  total_tokens_saved_all_layers?: number;
}
interface HeadroomCostBreakdown {
  cache_savings_usd?: number;
  compression_savings_usd?: number;
}
interface HeadroomCost {
  total_saved_usd?: number;
  savings_pct?: number;
  without_headroom_usd?: number;
  provider_cache_discount_usd?: number;
  breakdown?: HeadroomCostBreakdown;
}
interface HeadroomCodexWs { tokens_saved?: number; units_total?: number; units_modified?: number }
interface HeadroomUncompressed { prefix_frozen?: number }
interface HeadroomAgentUsageTotals {
  requests?: number;
  before_tokens?: number;
  after_tokens?: number;
  tokens_saved?: number;
  savings_percent?: number;
}
interface HeadroomAgentUsage { totals?: HeadroomAgentUsageTotals }
interface HeadroomSummary {
  mode?: string;
  api_requests?: number;
  primary_model?: string;
  compression?: HeadroomCompression;
  uncompressed_requests?: HeadroomUncompressed;
  cost?: HeadroomCost;
  codex_ws?: HeadroomCodexWs;
}
interface HeadroomStats { summary?: HeadroomSummary; agent_usage?: HeadroomAgentUsage }
interface HeadroomSavingsBucket {
  tokens_saved?: number;
  tokens_before?: number;
  cost_usd?: number;
  cost_effective_usd?: number;
  calls?: number;
  savings_percent?: number;
}
interface HeadroomSavingsEntry extends HeadroomSavingsBucket { model?: string; client?: string }
interface HeadroomSavings {
  lifetime?: HeadroomSavingsBucket;
  windows?: { today?: HeadroomSavingsBucket; last_7_days?: HeadroomSavingsBucket; last_30_days?: HeadroomSavingsBucket };
  by_model?: HeadroomSavingsEntry[];
  by_client?: HeadroomSavingsEntry[];
  top_model?: string;
}
interface HeadroomState {
  enabled: boolean;
  baseUrl: string;
  reachable: boolean;
  stats?: HeadroomStats;
  savings?: HeadroomSavings;
}

export default function Headroom({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const resource = useKeyedClientResource(
    `headroom-status:${apiBase}`,
    [apiBase],
    async signal => {
      const response = await fetch(`${apiBase}/api/headroom`, { signal, cache: "no-store" });
      return await readJsonOrThrow<HeadroomState>(response, t("headroom.loadFailed"));
    },
    { pollMs: 5_000, deadlineMs: 10_000 },
  );
  const state = resource.data;
  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

  const save = async (patch: { enabled?: boolean; baseUrl?: string }) => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${apiBase}/api/headroom`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      await readJsonOrThrow<HeadroomState>(response, t("headroom.saveFailed"));
      setNotice({ tone: "ok", text: t("headroom.saved") });
      resource.refresh();
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error ? error.message : t("headroom.saveFailed") });
    } finally {
      setBusy(false);
    }
  };

  if (resource.error && !state) {
    return <><Notice tone="err">{t("headroom.loadFailed")}</Notice><button type="button" className="btn btn-ghost" onClick={() => void resource.refresh()}>{t("common.retry")}</button></>;
  }

  const summary = state?.stats?.summary;
  const compression = summary?.compression;
  const cost = summary?.cost;
  const savings = state?.savings;
  const baseUrlValue = baseUrlDraft ?? state?.baseUrl ?? "";

  return (
    <section className="headroom-page">
      <div className="page-head">
        <div>
          <h2>{t("headroom.title")}</h2>
          <p className="page-sub">{t("headroom.subtitle")}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void resource.refresh()} disabled={resource.refreshing}>
          <IconRefresh /> {t("headroom.refresh")}
        </button>
      </div>

      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

      <article className="panel panel-accent">
        <div className="remote-panel-head">
          <div className="remote-icon"><IconActivity /></div>
          <div>
            <h3>{t("headroom.status.title")}</h3>
            <p>{state?.reachable ? t("headroom.status.reachable") : t("headroom.status.unreachable")}</p>
          </div>
        </div>
        <div className="headroom-controls">
          <Switch
            on={state?.enabled === true}
            onClick={() => void save({ enabled: !(state?.enabled === true) })}
            disabled={busy || !state}
            label={t("headroom.enabled")}
          />
          <span>{t("headroom.enabled")}</span>
        </div>
        <label>
          <span className="field-label">{t("headroom.baseUrl")}</span>
          <input
            className="input"
            type="text"
            value={baseUrlValue}
            onChange={event => setBaseUrlDraft(event.target.value)}
            placeholder="http://127.0.0.1:8787"
            disabled={busy}
          />
        </label>
        <div className="remote-console-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => { void save({ baseUrl: baseUrlValue }).then(() => setBaseUrlDraft(null)); }}
            disabled={busy || !baseUrlValue.trim() || baseUrlValue === state?.baseUrl}
          >{t("headroom.save")}</button>
        </div>
        {state?.enabled && !state.reachable ? <Notice tone="warn">{t("headroom.unreachableWarn")}</Notice> : null}
      </article>

      <section className="panel">
        <div className="remote-section-title"><h3>{t("headroom.metrics.title")}</h3>{summary?.mode ? <span>{summary.mode}</span> : null}</div>
        {!state?.reachable ? <p className="remote-empty">{t("headroom.metrics.unavailable")}</p> : (
          <>
            <div className="headroom-metrics">
              <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.requests")}</span><strong>{summary?.api_requests ?? 0}</strong></div>
              <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.compressed")}</span><strong>{compression?.requests_compressed ?? 0}</strong></div>
              <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.tokensSaved")}</span><strong>{formatTokens(compression?.total_tokens_saved_all_layers ?? compression?.total_tokens_removed ?? 0, locale)}</strong></div>
              <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.avgCompression")}</span><strong>{(compression?.avg_compression_pct ?? 0).toFixed(1)}%</strong></div>
              <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.costSaved")}</span><strong>${(cost?.total_saved_usd ?? 0).toFixed(2)}</strong></div>
              <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.savingsPct")}</span><strong>{(cost?.savings_pct ?? 0).toFixed(1)}%</strong></div>
              {summary?.primary_model ? <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.primaryModel")}</span><strong>{summary.primary_model}</strong></div> : null}
              {summary?.uncompressed_requests?.prefix_frozen != null ? <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.prefixFrozen")}</span><strong>{summary.uncompressed_requests.prefix_frozen}</strong></div> : null}
              {summary?.codex_ws?.tokens_saved ? <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.wsSaved")}</span><strong>{formatTokens(summary.codex_ws.tokens_saved, locale)}</strong></div> : null}
              {cost?.provider_cache_discount_usd ? <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.cacheDiscount")}</span><strong>${cost.provider_cache_discount_usd.toFixed(2)}</strong></div> : null}
              {cost?.breakdown?.compression_savings_usd != null ? <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.compressionSaved")}</span><strong>${cost.breakdown.compression_savings_usd.toFixed(2)}</strong></div> : null}
              {cost?.breakdown?.cache_savings_usd != null ? <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.cacheSaved")}</span><strong>${cost.breakdown.cache_savings_usd.toFixed(2)}</strong></div> : null}
            </div>
            {state?.stats?.agent_usage?.totals ? (
              <p className="headroom-usage-note">{t("headroom.metrics.usageTotals", {
                requests: state.stats.agent_usage.totals.requests ?? 0,
                saved: formatTokens(state.stats.agent_usage.totals.tokens_saved ?? 0, locale),
                pct: (state.stats.agent_usage.totals.savings_percent ?? 0).toFixed(1),
              })}</p>
            ) : null}
          </>
        )}
      </section>

      <section className="panel">
        <div className="remote-section-title"><h3>{t("headroom.savings.title")}</h3>{savings?.top_model ? <span>{savings.top_model}</span> : null}</div>
        {!savings?.lifetime ? <p className="remote-empty">{t("headroom.savings.unavailable")}</p> : (
          <>
            <div className="headroom-metrics">
              {(["today", "last_7_days", "last_30_days"] as const).map(key => {
                const bucket = savings.windows?.[key];
                if (!bucket) return null;
                return (
                  <div className="headroom-metric" key={key}>
                    <span className="field-label">{t(`headroom.savings.${key === "today" ? "today" : key === "last_7_days" ? "last7" : "last30"}`)}</span>
                    <strong>{(bucket.savings_percent ?? 0).toFixed(1)}%</strong>
                    <span className="headroom-metric-sub">{t("headroom.savings.savedTokens", { saved: formatTokens(bucket.tokens_saved ?? 0, locale), before: formatTokens(bucket.tokens_before ?? 0, locale) })}</span>
                    <span className="headroom-metric-sub">${(bucket.cost_usd ?? 0).toFixed(2)} · {t("headroom.savings.calls", { count: bucket.calls ?? 0 })}</span>
                  </div>
                );
              })}
              <div className="headroom-metric">
                <span className="field-label">{t("headroom.savings.lifetime")}</span>
                <strong>{(savings.lifetime.savings_percent ?? 0).toFixed(1)}%</strong>
                <span className="headroom-metric-sub">{t("headroom.savings.savedTokens", { saved: formatTokens(savings.lifetime.tokens_saved ?? 0, locale), before: formatTokens(savings.lifetime.tokens_before ?? 0, locale) })}</span>
                <span className="headroom-metric-sub">${(savings.lifetime.cost_usd ?? 0).toFixed(2)} · {t("headroom.savings.calls", { count: savings.lifetime.calls ?? 0 })}</span>
              </div>
            </div>
            {savings.by_model?.length ? (
              <div className="headroom-savings-block">
                <h4>{t("headroom.savings.byModel")}</h4>
                <div className="headroom-savings-table">
                  {savings.by_model.map(row => (
                    <div className="headroom-savings-row" key={row.model}>
                      <span>{row.model}</span>
                      <span>${(row.cost_usd ?? 0).toFixed(4)} · {formatTokens(row.tokens_saved ?? 0, locale)} · {(row.savings_percent ?? 0).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {savings.by_client?.length ? (
              <div className="headroom-savings-block">
                <h4>{t("headroom.savings.byClient")}</h4>
                <div className="headroom-savings-table">
                  {savings.by_client.map(row => (
                    <div className="headroom-savings-row" key={row.client}>
                      <span>{row.client}</span>
                      <span>{t("headroom.savings.calls", { count: row.calls ?? 0 })} · {formatTokens(row.tokens_saved ?? 0, locale)} · {(row.savings_percent ?? 0).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>
    </section>
  );
}
