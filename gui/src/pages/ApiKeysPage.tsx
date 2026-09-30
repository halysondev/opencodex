import ApiKeys from "./ApiKeys";
import { useT } from "../i18n/shared";

/**
 * API access is a sidebar page of its own, not an Integrations tab: a
 * credential surface (keys, spend quotas, model allowlists) has nothing to do
 * with client detection. The workspace itself stays exactly the component the
 * tab used to mount.
 */
export default function ApiKeysPage({ apiBase }: { apiBase: string }) {
  const t = useT();
  return (
    <section className="api-keys-page">
      <div className="page-head">
        <h2>{t("nav.apiKeys")}</h2>
      </div>
      <p className="page-sub">{t("apiKeysPage.subtitle")}</p>
      <ApiKeys apiBase={apiBase} active />
    </section>
  );
}
