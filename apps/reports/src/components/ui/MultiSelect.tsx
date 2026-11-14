import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { normalizeSearch, selectedLocationIds, type ScopeSelection } from "../catalog-filter/model";
import type { SelectOption } from "./Autocomplete";
export function MultiSelect({ label, labelAction, allLabel, options, value, onChange, disabled }: {
  label: string; labelAction?: ReactNode; allLabel: string; options: SelectOption[]; value: ScopeSelection; onChange: (next: ScopeSelection) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null), id = useId();
  const ids = selectedLocationIds(options, value), chosen = new Set(ids);
  const visible = options.filter(o => normalizeSearch(o.label).includes(normalizeSearch(query)));
  useEffect(() => { const listener = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener("pointerdown", listener); return () => document.removeEventListener("pointerdown", listener); }, []);
  useEffect(() => { if (open) search.current?.focus(); }, [open]);
  function toggle(key: string) {
    const base = new Set(chosen);
    if (base.has(key)) base.delete(key); else base.add(key);
    onChange(base.size === 0 || base.size === options.length ? { mode: "all", ids: [] } : { mode: "selected", ids: [...base] });
  }
  const title = value.mode === "all" || value.ids.length === 0 ? allLabel : `${options.find(o => o.id === ids[0])?.label}${ids.length > 1 ? ` +${ids.length - 1}` : ""}`;
  return <div className={`rf-multiselect ${open ? "is-open" : ""}`} ref={root} onBlur={e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
    <div className="rf-field-header"><label id={`${id}-label`}>{label}</label>{labelAction}</div>
    <button ref={trigger} type="button" className="rf-select-control" aria-labelledby={`${id}-label ${id}-value`} aria-expanded={open} aria-controls={`${id}-panel`} disabled={disabled} onClick={() => { setOpen(!open); setQuery(""); }}>
      <span id={`${id}-value`}>{title}</span><span aria-hidden="true">▾</span>
    </button>
    {open && <div className="rf-select-menu rf-multi-menu" id={`${id}-panel`}>
      <div className="rf-menu-search"><input ref={search} aria-label={`بحث في ${label}`} onKeyDown={e => { if (e.key === "Enter") e.preventDefault(); }} placeholder="ابحث بالاسم…" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <div className="rf-multi-actions"><button type="button" onClick={() => onChange({ mode: "all", ids: [] })}>تحديد الكل</button><button type="button" onClick={() => onChange({ mode: "all", ids: [] })}>إعادة للكل</button><span>{ids.length} محدد</span></div>
      <div className="rf-multi-options">{visible.map(o => <label key={o.id} className="rf-check-option"><input type="checkbox" checked={chosen.has(o.id)} onChange={() => toggle(o.id)} /><span className="rf-checkbox-visual" aria-hidden="true">{chosen.has(o.id) ? "✓" : ""}</span><span><strong>{o.label}</strong>{o.description && <small>{o.description}</small>}</span></label>)}{!visible.length && <p className="rf-no-options">لا توجد نتائج مطابقة.</p>}</div>
      <button type="button" className="rf-menu-done" onClick={() => { setOpen(false); trigger.current?.focus(); }}>تم الاختيار</button>
    </div>}
  </div>;
}
