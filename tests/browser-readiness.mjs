export async function workspaceReady(page, module, expectedKind, expectedId) {
  await page.waitForFunction(({ module, expectedKind, expectedId }) => {
    const w = document.querySelector(".workbench");
    if (w?.dataset.module !== module || w.dataset.ready !== "workspace") return false;
    const query = new URLSearchParams(w.dataset.catalogKey);
    if (query.get("kind") !== w.dataset.kind || (expectedKind && w.dataset.kind !== expectedKind)) return false;
    if ((query.get("query") || "") !== w.querySelector('[aria-label="搜索对象"]').value) return false;
    const owner = w.querySelector('[aria-label="分集筛选"]');
    if (owner && (query.get("owner") || "") !== owner.value) return false;
    const rows = w.querySelectorAll(".catalog-row"), d = w.querySelector("article[data-ready=detail]");
    if (!rows.length) return !d && !expectedId;
    return d?.dataset.objectKind === w.dataset.kind && (!expectedId || d.dataset.objectId === expectedId) && [...rows].some((r) => r.getAttribute("aria-current") === "location" && r.dataset.catalogId === d.dataset.objectId);
  }, { module, expectedKind, expectedId });
}
