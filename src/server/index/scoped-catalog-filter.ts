/**
 * Narrow a serialized catalog body to the `models[]` rows a scoped API key may
 * see. Returns undefined when the body cannot be filtered — unparseable JSON or
 * a payload without a `models` array — so the route can refuse (503
 * `catalog_unfilterable`) instead of serving an unscoped key the full list.
 *
 * Today `serializePersistedCatalog` only produces bodies `readCatalog` already
 * validated, so the undefined branch is defensive: the invariant it protects is
 * that scope enforcement must never fail open.
 */
export function filterCatalogBodyForScope(
  body: string,
  allowedSlugs: ReadonlySet<string>,
): { body: string; bytes: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { models?: unknown }).models)) {
    return undefined;
  }
  const catalog = parsed as { models: unknown[] };
  catalog.models = catalog.models.filter((entry: unknown) => (
    entry !== null
    && typeof entry === "object"
    && typeof (entry as { slug?: unknown }).slug === "string"
    && allowedSlugs.has((entry as { slug: string }).slug)
  ));
  const filtered = JSON.stringify(catalog);
  return { body: filtered, bytes: new TextEncoder().encode(filtered).byteLength };
}
