import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { normalizeSearch, selectedLocationIds, type ScopeSelection } from "../catalog-filter/model";
import type { SelectOption } from "./Autocomplete";
const OPTION_PAGE_SIZE = 100;
export function MultiSelect({ label, labelAction, allLabel, options, value, onChange, disabled, emptyMeansAll = false }: {
  label: string; labelAction?: ReactNode; allLabel: string; options: SelectOption[]; value: ScopeSelection; onChange: (next: ScopeSelection) => void; disabled?: boolean; emptyMeansAll?: boolean;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [limit, setLimit] = useState(OPTION_PAGE_SIZE);
  const root = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null), id = useId();
  const ids = emptyMeansAll
    ? (value.mode === "all" || value.ids.length === 0 ? [] : options.filter(o => value.ids.includes(o.id)).map(o => o.id))
    : selectedLocationIds(options, value);
  const chosen = new Set(ids);
  const normQuery = normalizeSearch(query);
  const prefixMatches = normQuery ? options.filter(o => normalizeSearch(o.label).startsWith(normQuery)) : [];
  const matches = normQuery
    ? [
        ...prefixMatches,
        ...options.filter(o => !normalizeSearch(o.label).startsWith(normQuery) && normalizeSearch(`${o.label} ${o.description ?? ""}`).includes(normQuery)),
      ]
    : options;
  const visible = matches.slice(0, limit);
  const closeMenu = (restoreFocus = false) => {
    if (emptyMeansAll && normQuery && chosen.size === 0 && prefixMatches.length > 0) {
      onChange({ mode: "selected", ids: prefixMatches.map(o => o.id) });
    }
    setOpen(false);
    setQuery("");
    if (restoreFocus) trigger.current?.focus();
  };
  const closeMenuRef = useRef(closeMenu);
  closeMenuRef.current = closeMenu;
  useEffect(() => { const listener = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) closeMenuRef.current(); }; document.addEventListener("pointerdown", listener); return () => document.removeEventListener("pointerdown", listener); }, []);
  useEffect(() => { if (open) search.current?.focus(); }, [open]);
  function toggle(key: string) {
    const base = new Set(chosen);
    if (base.has(key)) base.delete(key); else base.add(key);
    const isAll = emptyMeansAll ? base.size === 0 : base.size === 0 || base.size === options.length;
    onChange(isAll ? { mode: "all", ids: [] } : { mode: "selected", ids: [...base] });
  }
  function selectAllMatches() {
    if (!emptyMeansAll && !normQuery) {
      onChange({ mode: "all", ids: [] });
      return;
    }
    const base = new Set(chosen);
    for (const o of matches) base.add(o.id);
    const isAll = emptyMeansAll ? base.size === 0 : base.size === 0 || base.size === options.length;
    onChange(isAll ? { mode: "all", ids: [] } : { mode: "selected", ids: [...base] });
  }
  const selectedLabels = value.mode === "all" || value.ids.length === 0
    ? []
    : ids.map(itemId => options.find(o => o.id === itemId)?.label).filter((v): v is string => Boolean(v));
  const title = selectedLabels.length === 0
    ? allLabel
    : selectedLabels.length <= 5
      ? selectedLabels.join("، ")
      : `${selectedLabels.slice(0, 5).join("، ")} (+${selectedLabels.length - 5})`;
  return <div className={`rf-multiselect ${open ? "is-open" : ""}`} ref={root} onBlur={e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) closeMenu(); }} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); setQuery(""); trigger.current?.focus(); } }}>
    <div className="rf-field-header"><label id={`${id}-label`}>{label}</label>{labelAction}</div>
    <button ref={trigger} type="button" className="rf-select-control" aria-labelledby={`${id}-label ${id}-value`} aria-expanded={open} aria-controls={`${id}-panel`} disabled={disabled} onClick={() => { if (open) closeMenu(); else { setOpen(true); setQuery(""); setLimit(OPTION_PAGE_SIZE); } }}>
      <span id={`${id}-value`} title={title}>{title}</span><span aria-hidden="true">▾</span>
    </button>
    {open && <div className="rf-select-menu rf-multi-menu" id={`${id}-panel`}>
      <div className="rf-menu-search"><input ref={search} aria-label={`بحث في ${label}`} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); closeMenu(true); } }} placeholder="ابحث بالاسم أو اكتب البداية…" value={query} onChange={e => { setQuery(e.target.value); setLimit(OPTION_PAGE_SIZE); }} /></div>
      <div className="rf-multi-actions"><button type="button" onClick={selectAllMatches}>تحديد الكل</button><button type="button" onClick={() => onChange({ mode: "all", ids: [] })}>{emptyMeansAll ? "مسح التحديد" : "إعادة للكل"}</button><span>{ids.length} محدد</span></div>
      <div className="rf-multi-options">{visible.map(o => <label key={o.id} className="rf-check-option"><input type="checkbox" checked={chosen.has(o.id)} onChange={() => toggle(o.id)} /><span className="rf-checkbox-visual" aria-hidden="true">{chosen.has(o.id) ? "✓" : ""}</span><span><strong>{o.label}</strong>{o.description && <small>{o.description}</small>}</span></label>)}{matches.length > visible.length && <button type="button" className="rf-menu-done" onClick={() => setLimit(v => v + OPTION_PAGE_SIZE)}>عرض المزيد ({matches.length - visible.length} متبقي)</button>}{!visible.length && <p className="rf-no-options">لا توجد نتائج مطابقة.</p>}</div>
      <button type="button" className="rf-menu-done" onClick={() => closeMenu(true)}>{emptyMeansAll && normQuery && chosen.size === 0 && prefixMatches.length > 0 ? `تطبيق ما يبدأ بـ "${query.trim()}" (${prefixMatches.length})` : "تم الاختيار"}</button>
    </div>}
  </div>;
}
