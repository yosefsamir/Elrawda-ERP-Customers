import "./catalog-filter.css";
import { useMemo, useState } from "react";
import { Autocomplete } from "../ui/Autocomplete";
import { MultiSelect } from "../ui/MultiSelect";
import { TreePicker } from "./TreePicker";
import { ancestors, buildCatalogIndex, cairoDate, catalogLevels, changeBranches, defaultFilterValue, isWithin, selectedLeaves, selectedLocationIds, storeOptions, validateFilter, type CatalogFilterValue, type CatalogNode, type GroupByLevel, type LocationOption } from "./model";
export type CatalogFilterProps = {
  nodes: CatalogNode[]; locations: LocationOption[]; value: CatalogFilterValue;
  onChange: (next: CatalogFilterValue) => void; onApply: (value: CatalogFilterValue) => void;
  groupBy?: GroupByLevel | null; onGroupByChange?: (next: GroupByLevel | null) => void;
  groupByBranch?: boolean; onGroupByBranchChange?: (next: boolean) => void;
  today?: string; loading?: boolean; error?: string; onRetry?: () => void;
};
const levelLabels = ["النوع", "القسم", "التصنيف", "المقاس / الوصف", "كود الموديل"];
export function CatalogFilter({ nodes, locations, value, onChange, onApply, groupBy = null, onGroupByChange, groupByBranch = false, onGroupByBranchChange, today = cairoDate(), loading = false, error, onRetry }: CatalogFilterProps) {
  const index = useMemo(() => buildCatalogIndex(nodes), [nodes]);
  const [treeOpen, setTreeOpen] = useState(false), [validation, setValidation] = useState<string | null>(null);
  const activeNode = value.items.mode === "selected" && value.items.includeIds.length === 1 && value.items.excludeIds.length === 0 ? value.items.includeIds[0] : null;
  const path = activeNode ? ancestors(index, activeNode) : [];
  const count = selectedLeaves(index, value.items).length;
  const stores = storeOptions(locations, value.branches);
  const branchIds = selectedLocationIds(locations, value.branches);
  function update(next: CatalogFilterValue) { setValidation(null); onChange(next); }
  function chooseNode(id: string | null, level?: number) {
    if (!id) {
      const previous = level !== undefined && level > 0 ? path.find(n => n.level === catalogLevels[level - 1]) : null;
      update({
        ...value,
        items: previous ? { mode: "selected", includeIds: [previous.id], excludeIds: [] } : { mode: "all", includeIds: [], excludeIds: [] },
      });
      return;
    }
    update({ ...value, items: { mode: "selected", includeIds: [id], excludeIds: [] } });
  }
  function preset(key: "today" | "week" | "month") {
    const end = new Date(`${today}T12:00:00Z`); const begin = new Date(end);
    if (key === "week") begin.setUTCDate(begin.getUTCDate() - 6);
    if (key === "month") begin.setUTCDate(1);
    update({ ...value, from: begin.toISOString().slice(0, 10), through: today });
  }
  const presets = [
    { key: "today" as const, label: "اليوم", from: today },
    { key: "week" as const, label: "آخر ٧ أيام", from: new Date(new Date(`${today}T12:00:00Z`).getTime() - 6 * 86400000).toISOString().slice(0, 10) },
    { key: "month" as const, label: "الشهر الحالي", from: `${today.slice(0, 7)}-01` },
  ];
  const globalOptions = useMemo(() => nodes.map(n => ({ id: n.id, label: n.label, description: ancestors(index, n.id).slice(0, -1).map(p => p.label).join(" / "), badge: n.level === "product" ? "كود رقمي" : levelLabels[catalogLevels.indexOf(n.level)] })), [nodes, index]);
  return <form className="rf-filter" onSubmit={e => { e.preventDefault(); const message = validateFilter(value, index, locations); setValidation(message); if (!message) onApply(value); }}>
    <div className="rf-card-heading"><div><h2>حدد نطاق الاختيار</h2></div><button type="button" className="rf-text-button" onClick={() => { onGroupByChange?.(null); onGroupByBranchChange?.(false); update(defaultFilterValue(today)); }}>إعادة ضبط</button></div>
    {error && <div className="rf-data-error" role="alert">{error}{onRetry && <button type="button" onClick={onRetry}>إعادة المحاولة</button>}</div>}
    <fieldset disabled={loading || !!error} className="rf-fields">
      <section className="rf-section rf-period-section" aria-labelledby="rf-period-title">
        <div className="rf-section-heading"><div><h3 id="rf-period-title">الفترة الزمنية</h3></div></div>
        <div className="rf-period-content"><div className="rf-presets">{presets.map(p => <button key={p.key} type="button" className={value.from === p.from && value.through === today ? "is-selected" : ""} aria-pressed={value.from === p.from && value.through === today} onClick={() => preset(p.key)}>{p.label}</button>)}</div>
          <div className="rf-dates"><label>من تاريخ<input type="date" aria-label="من تاريخ" value={value.from} onChange={e => update({ ...value, from: e.target.value })} required /></label><span className="rf-date-arrow" aria-hidden="true">←</span><label>إلى تاريخ<input type="date" aria-label="إلى تاريخ" min={value.from || undefined} value={value.through} onChange={e => update({ ...value, through: e.target.value })} required /></label></div></div>
      </section>
      <section className="rf-section rf-items-section" aria-labelledby="rf-items-title">
        <div className="rf-section-heading"><div><h3 id="rf-items-title">الأصناف والتصنيفات</h3></div></div>
        <div className="rf-item-toolbar"><Autocomplete label="بحث سريع في الشجرة" searchIcon searchDescriptions placeholder="ابحث باسم، قسم، أو كود صنف…" options={globalOptions} value={null} onChange={chooseNode} /><button type="button" className="rf-button rf-tree-button" onClick={() => setTreeOpen(true)}>تصفح الشجرة</button></div>
        <div className="rf-cascade">{levelLabels.map((label, i) => {
          const level = catalogLevels[i] as GroupByLevel;
          const isGrouped = groupBy === level;
          const parent = path.filter(n => catalogLevels.indexOf(n.level) < i).at(-1);
          const options = nodes.filter(n => n.level === level && (!parent || isWithin(index, n.id, parent.id))).map(n => ({ id: n.id, label: n.label, description: !i || parent?.level === catalogLevels[i - 1] ? undefined : ancestors(index, n.id).slice(0, -1).map(p => p.label).join(" / ") }));
          return <div className="rf-cascade-field" key={label}><Autocomplete label={label} labelAction={onGroupByChange ? <button type="button" className={`rf-group-btn ${isGrouped ? "is-active" : ""}`} aria-pressed={isGrouped} title={`تجميع التقرير حسب ${label}`} onClick={() => onGroupByChange(isGrouped ? null : level)}>تجميع</button> : undefined} placeholder={`كل ${i === 0 ? "الأنواع" : i === 1 ? "الأقسام" : i === 2 ? "التصنيفات" : i === 3 ? "المقاسات والأوصاف" : "الموديلات"}`} options={options} value={path.find(n => n.level === level)?.id ?? null} onChange={id => chooseNode(id, i)} /></div>;
        })}</div>
      </section>
      <section className="rf-section rf-locations-section" aria-labelledby="rf-locations-title">
        <div className="rf-section-heading"><div><h3 id="rf-locations-title">الفروع والمخازن</h3></div></div>
        <div className="rf-location-fields"><MultiSelect label="الفروع" labelAction={onGroupByBranchChange ? <button type="button" className={`rf-group-btn ${groupByBranch ? "is-active" : ""}`} aria-pressed={groupByBranch} title="تجميع كل الفروع المحددة معًا" onClick={() => onGroupByBranchChange(!groupByBranch)}>تجميع</button> : undefined} allLabel="كل الفروع" options={locations.map(b => ({ id: b.id, label: b.label }))} value={value.branches} onChange={branches => update(changeBranches(value, branches, locations))} /><MultiSelect label="المخازن" allLabel="كل المخازن التابعة للفروع" options={stores} value={value.stores} disabled={!branchIds.length} onChange={next => update({ ...value, stores: next })} /></div>
        <div className="rf-location-note"><span>{branchIds.length} فروع · {selectedLocationIds(stores, value.stores).length} مخازن ضمن الاختيار</span></div>
      </section>
    </fieldset>
    {validation && <p className="rf-validation" role="alert">{validation}</p>}
    <div className="rf-filter-footer"><span>{count} صنف · {branchIds.length} فروع</span><button type="submit" className="rf-button rf-button-yellow" disabled={loading || !!error}>{loading ? "جارٍ تحميل الاختيارات…" : "تطبيق الفلاتر"}</button></div>
    {treeOpen && <TreePicker index={index} value={value.items} onClose={() => setTreeOpen(false)} onApply={items => { update({ ...value, items }); setTreeOpen(false); }} />}
  </form>;
}
