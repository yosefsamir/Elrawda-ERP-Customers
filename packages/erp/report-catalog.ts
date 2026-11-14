import type { CatalogNode, LocationOption } from "../../apps/reports/src/components/catalog-filter/model.js";

// Definitions only; keep program scope on both the item and location trees.
export const reportCatalogSql = `
SELECT CONVERT(varchar(30),d.iddet) product, CONVERT(varchar(30),f.idfarz) model, f.ffarz modelLabel,
 CONVERT(varchar(30),s.idsize) size, s.fsize sizeLabel, CONVERT(varchar(30),c.idcolor) classification,c.fcolor classificationLabel,
 CONVERT(varchar(30),n.idname) section,n.fname sectionLabel,CONVERT(varchar(30),k.idkind) type,k.fkind typeLabel
FROM maindet d JOIN mainfarz f ON f.idfarz=d.idfarz JOIN mainsize s ON s.idsize=f.idsize
JOIN maincolor c ON c.idcolor=s.idcolor JOIN main n ON n.idname=c.idname JOIN kind k ON k.idkind=n.idkind
WHERE k.idprogramitems=@program ORDER BY d.iddet;
SELECT CONVERT(varchar(30),b.idbranch) id,bm.fbranch label,CONVERT(varchar(30),s.idstor) storeId,s.fstor storeLabel
FROM branch b JOIN branchmain bm ON bm.idbranch=b.idbranch
LEFT JOIN stor s ON s.idbranch=b.idbranch AND s.idprogramitems=b.idprogramitems
WHERE b.idprogramitems=@program ORDER BY b.idbranch,s.idstor;`;
export function mapReportCatalog(items: Record<string, unknown>[], branches: Record<string, unknown>[]) {
  const nodes = new Map<string, CatalogNode>(), locations = new Map<string, LocationOption>();
  const levels = ["type", "section", "classification", "size", "model", "product"] as const;
  for (const row of items) {
    let parentId: string | null = null;
    for (const level of levels) {
      const code = String(row[level]);
      if (!/^\d+$/.test(code)) throw new Error("Invalid ERP catalog identifier");
      const id = `${level}:${code}`;
      const label = String(row[`${level}Label`] ?? code).trim() || code;
      const existing = nodes.get(id);
      if (existing && existing.parentId !== parentId) throw new Error("Ambiguous ERP catalog parent");
      nodes.set(id, { id, parentId, level, label, code }); parentId = id;
    }
  }
  for (const row of branches) {
    const id = String(row.id);
    const location = locations.get(id) ?? { id, label: String(row.label ?? id).trim(), stores: [] };
    if (row.storeId !== null && row.storeId !== undefined && !location.stores.some(s => s.id === String(row.storeId))) {
      location.stores.push({ id: String(row.storeId), label: String(row.storeLabel ?? row.storeId).trim() });
    }
    locations.set(id, location);
  }
  return { nodes: [...nodes.values()], locations: [...locations.values()] };
}
