import test from "node:test";
import assert from "node:assert/strict";
import { mapReportCatalog } from "../packages/erp/report-catalog.js";
import { buildCatalogIndex, nodePath } from "../apps/reports/src/components/catalog-filter/model.js";

test("ERP definitions preserve numeric codes, deduplicate parents, and keep stores scoped by branch", () => {
  const item = { type: "1", typeLabel: "ملابس", section: "2", sectionLabel: "بنطلون", classification: "3", classificationLabel: "جبردين", size: "4", sizeLabel: "مستورد", model: "5", modelLabel: "Z3330", product: "186759" };
  const result = mapReportCatalog([item, { ...item, product: "186760" }], [
    { id: "39", label: "المنصورة", storeId: "28", storeLabel: "رئيسي" },
    { id: "40", label: "فرع آخر", storeId: "28", storeLabel: "رئيسي" },
    { id: "41", label: "بدون مخزن", storeId: null },
  ]);
  assert.equal(result.nodes.length, 7);
  const index = buildCatalogIndex(result.nodes);
  assert.equal(index.leaves.length, 2);
  assert.equal(nodePath(index, "product:186759"), "ملابس / بنطلون / جبردين / مستورد / Z3330 / 186759");
  assert.deepEqual(result.locations.map(l => [l.id, l.stores.length]), [["39", 1], ["40", 1], ["41", 0]]);
  assert.throws(() => mapReportCatalog([item, { ...item, size: "6" }], []), /Ambiguous/);
});
