/**
 * Publishes the bar's rendered height as `--ocx-sticky-top` so page-level sticky elements
 * (the Models provider rail) can sit just below it. The bar wraps onto a second row on
 * narrower windows, so a constant offset would let content slide underneath it.
 * A React 19 callback ref: the returned cleanup runs when the bar unmounts.
 */
export function publishStickyTop(node: HTMLElement): () => void {
  const root = document.documentElement;
  // eslint-disable-next-line local-i18n/no-hardcoded-ui-strings -- CSS unit suffix, not UI text
  const write = () => root.style.setProperty("--ocx-sticky-top", `${Math.ceil(node.getBoundingClientRect().height)}px`);
  write();
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(write);
  observer?.observe(node);
  return () => {
    observer?.disconnect();
    root.style.removeProperty("--ocx-sticky-top");
  };
}
