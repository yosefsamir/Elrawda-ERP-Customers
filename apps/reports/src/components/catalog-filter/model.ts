/** Pure filter model; no React, ERP connection, or demo dependencies. */
export const catalogLevels = ["type", "section", "classification", "size", "model", "product"] as const;
export type CatalogLevel = typeof catalogLevels[number];
export type GroupByLevel = "type" | "section" | "classification" | "size" | "model";
export type CatalogNode = { id: string; parentId: string | null; level: CatalogLevel; label: string; code?: string };
export type LocationOption = { id: string; label: string; stores: { id: string; label: string }[] };
export type ScopeSelection = { mode: "all" | "selected"; ids: string[] };
export type CatalogSelection = { mode: "all" | "selected"; includeIds: string[]; excludeIds: string[] };
export type CatalogFilterValue = { from: string; through: string; items: CatalogSelection; branches: ScopeSelection; stores: ScopeSelection };
export type CatalogIndex = { byId: Map<string, CatalogNode>; children: Map<string | null, CatalogNode[]>; leaves: CatalogNode[]; paths: Map<string, CatalogNode[]>; descendants: Map<string, CatalogNode[]> };
export function buildCatalogIndex(nodes: CatalogNode[]): CatalogIndex {
  const byId = new Map<string, CatalogNode>();
  const children = new Map<string | null, CatalogNode[]>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error(`Duplicate catalog id: ${node.id}`);
    byId.set(node.id, node);
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  }
  const paths = new Map<string, CatalogNode[]>();
  for (const node of nodes) {
    const path: CatalogNode[] = [];
    if (node.parentId !== null && !byId.has(node.parentId)) throw new Error(`Missing catalog parent: ${node.parentId}`);
    const seen = new Set<string>(); let current: CatalogNode | undefined = node;
    while (current) {
      if (seen.has(current.id)) throw new Error("Catalog cycle");
      path.unshift(current); seen.add(current.id); current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    paths.set(node.id, path);
  }
  const leaves = nodes.filter(n => !children.has(n.id));
  const descendants = new Map<string, CatalogNode[]>();
  for (const leaf of leaves) for (const ancestor of paths.get(leaf.id) ?? []) descendants.set(ancestor.id, [...(descendants.get(ancestor.id) ?? []), leaf]);
  return { byId, children, leaves, paths, descendants };
}
export function ancestors(index: CatalogIndex, id: string): CatalogNode[] {
  return index.paths.get(id) ?? [];
}
export const isWithin = (index: CatalogIndex, child: string, parent: string) => ancestors(index, child).some(n => n.id === parent);
export const nodePath = (index: CatalogIndex, id: string) => ancestors(index, id).map(n => n.label).join(" / ");
export const normalizeSearch = (text: string) => text.normalize("NFKC").replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[أإآ]/g, "ا").toLocaleLowerCase("ar").trim();
export function selectedLeaves(index: CatalogIndex, selection: CatalogSelection): CatalogNode[] {
  const isImplicitAll = selection.mode === "all" || (selection.includeIds.length === 0 && selection.excludeIds.length === 0);
  return index.leaves.filter(n =>
    (isImplicitAll || selection.includeIds.some(id => isWithin(index, n.id, id))) &&
    !selection.excludeIds.some(id => isWithin(index, n.id, id)));
}
/** Compact a leaf selection back into complete subtrees. Empty resets to all. */
export function selectionFromLeaves(index: CatalogIndex, ids: Set<string>): CatalogSelection {
  if (ids.size === 0 || (index.leaves.length > 0 && index.leaves.every(n => ids.has(n.id)))) {
    return { mode: "all", includeIds: [], excludeIds: [] };
  }
  const includeIds: string[] = [];
  const visit = (node: CatalogNode) => {
    const leaves = (index.descendants.get(node.id) ?? []);
    if (leaves.length && leaves.every(n => ids.has(n.id))) includeIds.push(node.id);
    else for (const child of index.children.get(node.id) ?? []) visit(child);
  };
  for (const root of index.children.get(null) ?? []) visit(root);
  return { mode: "selected", includeIds, excludeIds: [] };
}
export function toggleCatalogNode(index: CatalogIndex, selection: CatalogSelection, id: string): CatalogSelection {
  const chosen = new Set(selectedLeaves(index, selection).map(n => n.id));
  const subtree = (index.descendants.get(id) ?? []);
  if (!subtree.length) return selection;
  const remove = subtree.every(n => chosen.has(n.id));
  for (const leaf of subtree) { if (remove) chosen.delete(leaf.id); else chosen.add(leaf.id); }
  return selectionFromLeaves(index, chosen);
}
export function addScope(index: CatalogIndex, selection: CatalogSelection, id: string, replaceId?: string): CatalogSelection {
  const include = selection.mode === "all" ? [] : selection.includeIds.filter(x => x !== replaceId);
  const combined: CatalogSelection = { mode: "selected", includeIds: [...include, id], excludeIds: selection.excludeIds.filter(x => !isWithin(index, x, id) && !isWithin(index, id, x)) };
  return { ...combined, includeIds: combined.includeIds.filter((nodeId, i, all) => all.indexOf(nodeId) === i && !all.some(other => other !== nodeId && isWithin(index, nodeId, other))) };
}
export function selectedIdsAtLevel(index: CatalogIndex, selection: CatalogSelection, levelIndex: number): string[] {
  if (selection.mode === "all" || selection.includeIds.length === 0 || selection.excludeIds.length > 0) return [];
  const level = catalogLevels[levelIndex];
  const ids: string[] = [];
  for (const id of selection.includeIds) {
    const match = ancestors(index, id).find(n => n.level === level);
    if (match && !ids.includes(match.id)) ids.push(match.id);
  }
  return ids;
}
export function setCascadeLevelIds(index: CatalogIndex, selection: CatalogSelection, levelIndex: number, nextIds: string[]): CatalogSelection {
  const unique = nextIds.filter((id, i, all) => all.indexOf(id) === i);
  if (unique.length === 0) {
    for (let p = levelIndex - 1; p >= 0; p--) {
      const parentIds = selectedIdsAtLevel(index, selection, p);
      if (parentIds.length > 0) return { mode: "selected", includeIds: parentIds, excludeIds: [] };
    }
    return { mode: "all", includeIds: [], excludeIds: [] };
  }
  const keptDeeper = selection.mode === "selected"
    ? selection.includeIds.filter(id => {
        const node = index.byId.get(id);
        return node && catalogLevels.indexOf(node.level) > levelIndex && unique.some(nid => isWithin(index, id, nid));
      })
    : [];
  const includeIds = [
    ...keptDeeper,
    ...unique.filter(nid => !keptDeeper.some(deeperId => isWithin(index, deeperId, nid))),
  ];
  return { mode: "selected", includeIds, excludeIds: [] };
}
export const selectedLocationIds = (options: { id: string }[], selection: ScopeSelection) =>
  selection.mode === "all" || selection.ids.length === 0
    ? options.map(x => x.id)
    : options.filter(x => selection.ids.includes(x.id)).map(x => x.id);
export function storeOptions(locations: LocationOption[], branches: ScopeSelection) {
  const ids = new Set(selectedLocationIds(locations, branches));
  return locations.filter(b => ids.has(b.id)).flatMap(b => b.stores.map(s => ({ id: `${b.id}:${s.id}`, label: s.label, description: b.label })));
}
export function changeBranches(value: CatalogFilterValue, branches: ScopeSelection, locations: LocationOption[]): CatalogFilterValue {
  const valid = new Set(storeOptions(locations, branches).map(s => s.id));
  return { ...value, branches, stores: value.stores.mode === "all" ? value.stores : { mode: "selected", ids: value.stores.ids.filter(id => valid.has(id)) } };
}
export function cairoDate(now = new Date()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
export function defaultFilterValue(today = cairoDate()): CatalogFilterValue {
  return { from: `${today.slice(0, 7)}-01`, through: today, items: { mode: "all", includeIds: [], excludeIds: [] }, branches: { mode: "all", ids: [] }, stores: { mode: "all", ids: [] } };
}
export function validateFilter(value: CatalogFilterValue, index: CatalogIndex, locations: LocationOption[]): string | null {
  const validDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (!validDate(value.from) || !validDate(value.through)) return "حدد تاريخ بداية ونهاية صحيحين.";
  if (value.from > value.through) return "تاريخ البداية لازم يكون قبل تاريخ النهاية أو نفس اليوم.";
  if ([...value.items.includeIds, ...value.items.excludeIds].some(id => !index.byId.has(id))) return "بعض اختيارات الأصناف لم تعد متاحة؛ راجع التحديد.";
  if (value.branches.mode === "selected" && value.branches.ids.some(id => !locations.some(b => b.id === id))) return "بعض الفروع المحددة لم تعد متاحة.";
  const stores = storeOptions(locations, value.branches);
  if (value.stores.mode === "selected" && value.stores.ids.some(id => !stores.some(s => s.id === id))) return "راجع المخازن المحددة للفروع المختارة.";
  return null;
}
