import { useEffect, useMemo, useRef, useState } from "react";
import { nodePath, normalizeSearch, selectedLeaves, toggleCatalogNode, type CatalogIndex, type CatalogNode, type CatalogSelection } from "./model";
function TreeCheck({ checked, mixed, onChange, label }: { checked: boolean; mixed: boolean; onChange: () => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input ref={ref} type="checkbox" checked={checked} aria-checked={mixed ? "mixed" : checked} onChange={onChange} aria-label={label} />;
}
export function TreePicker({ index, value, onApply, onClose }: { index: CatalogIndex; value: CatalogSelection; onApply: (next: CatalogSelection) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(value), [query, setQuery] = useState(""), [expanded, setExpanded] = useState(new Set(index.children.get(null)?.map(n => n.id)));
  const chosen = useMemo(() => new Set(selectedLeaves(index, draft).map(n => n.id)), [index, draft]);
  const needle = normalizeSearch(query);
  useEffect(() => { const previousFocus = document.activeElement as HTMLElement | null; dialog.current?.showModal(); const previous = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = previous; previousFocus?.focus(); }; }, []);
  const matches = (node: CatalogNode): boolean => normalizeSearch(nodePath(index, node.id)).includes(needle) || (index.children.get(node.id) ?? []).some(matches);
  function renderNode(node: CatalogNode, depth: number) {
    if (needle && !matches(node)) return null;
    const children = index.children.get(node.id) ?? [], leaves = (index.descendants.get(node.id) ?? []);
    const selected = leaves.filter(n => chosen.has(n.id)).length, opened = !!needle || expanded.has(node.id);
    return <div key={node.id} className="rf-tree-node">
      <div className={`rf-tree-row ${selected ? "has-selection" : ""}`} style={{ "--tree-depth": Math.min(depth, 4) } as React.CSSProperties}>
        <button type="button" className="rf-tree-expand" disabled={!children.length} aria-label={`${opened ? "طي" : "فتح"} ${node.label}`} aria-expanded={children.length ? opened : undefined} onClick={() => setExpanded(old => { const next = new Set(old); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })}>{children.length ? opened ? "▾" : "◂" : <span className="rf-tree-dot" />}</button>
        <label><TreeCheck checked={selected === leaves.length && !!selected} mixed={selected > 0 && selected < leaves.length} label={`تحديد ${nodePath(index, node.id)}`} onChange={() => setDraft(old => toggleCatalogNode(index, old, node.id))} /><span>{!children.length && <span className="rf-tree-leaf" />}{node.label}</span></label>
        <span className="rf-tree-count">{selected ? `${selected} / ` : ""}{leaves.length}</span>
      </div>
      {opened && children.map(child => renderNode(child, depth + 1))}
    </div>;
  }
  return <dialog ref={dialog} className="rf-tree-dialog" aria-labelledby="rf-tree-title" onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === dialog.current) onClose(); }}>
    <div className="rf-dialog-shell">
      <header><div><h2 id="rf-tree-title">شجرة الأصناف</h2><p>حدد فرعًا كاملًا، أو افتحه واختر أصنافًا بعينها.</p></div><button type="button" className="rf-icon-button" onClick={onClose} aria-label="إغلاق شجرة الأصناف">×</button></header>
      <div className="rf-tree-search"><input autoFocus placeholder="ابحث داخل الشجرة…" aria-label="بحث داخل شجرة الأصناف" value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="rf-icon-button" type="button" aria-label="مسح بحث الشجرة" onClick={() => setQuery("")}>×</button>}</div>
      <div className="rf-tree-tools"><label><TreeCheck checked={chosen.size === index.leaves.length && !!chosen.size} mixed={chosen.size > 0 && chosen.size < index.leaves.length} label="تحديد كل الأصناف" onChange={() => setDraft(chosen.size === index.leaves.length ? { mode: "selected", includeIds: [], excludeIds: [] } : { mode: "all", includeIds: [], excludeIds: [] })} />كل الأصناف</label><span>{chosen.size} صنف محدد</span><button type="button" onClick={() => setDraft({ mode: "selected", includeIds: [], excludeIds: [] })}>مسح</button></div>
      <div className="rf-tree-scroll">{(index.children.get(null) ?? []).map(node => renderNode(node, 0))}{needle && !(index.children.get(null) ?? []).some(matches) && <div className="rf-no-options">لا توجد نتائج مطابقة داخل الشجرة.</div>}</div>
      <footer><span>اختيار الأب يشمل كل الأصناف التابعة له.</span><button type="button" className="rf-button rf-button-light" onClick={onClose}>إلغاء</button><button type="button" className="rf-button rf-button-dark" onClick={() => onApply(draft)}>اعتماد التحديد</button></footer>
    </div>
  </dialog>;
}
