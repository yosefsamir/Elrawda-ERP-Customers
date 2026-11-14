import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { normalizeSearch } from "../catalog-filter/model";
export type SelectOption = { id: string; label: string; description?: string; badge?: string };
export function Autocomplete({ label, labelAction, placeholder = "اكتب للبحث أو اختر من القائمة", options, value, onChange, disabled, searchIcon = false, searchDescriptions = false }: {
  label: string; labelAction?: ReactNode; placeholder?: string; options: SelectOption[]; value: string | null;
  onChange: (id: string | null) => void; disabled?: boolean; searchIcon?: boolean; searchDescriptions?: boolean;
}) {
  const id = useId(), root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [active, setActive] = useState(0);
  const selected = options.find(o => o.id === value);
  const matches = options.filter(o => normalizeSearch(`${o.label} ${searchDescriptions ? o.description ?? "" : ""}`).includes(normalizeSearch(query)));
  const visible = matches.slice(0, 40);
  useEffect(() => { const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside); }, []);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { if (open) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active, open, id]);
  const choose = (next: string) => { onChange(next); input.current?.focus(); setOpen(false); setQuery(""); };
  return <div className={`rf-autocomplete ${open ? "is-open" : ""}`} ref={root}>
    <div className="rf-field-header"><label htmlFor={id}>{label}</label>{labelAction}</div>
    <div className="rf-select-control">
      <input ref={input} id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={open && visible[active] ? `${id}-option-${active}` : undefined}
        autoComplete="off" placeholder={placeholder} disabled={disabled} value={open ? query : selected?.label ?? ""}
        onFocus={() => { setQuery(""); setActive(0); setOpen(true); }} onClick={() => setOpen(true)}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={e => {
          if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
          if (e.key === "Tab") setOpen(false);
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); setActive(a => open ? Math.max(0, Math.min(visible.length - 1, a + (e.key === "ArrowDown" ? 1 : -1))) : 0); }
          if (e.key === "Enter") { e.preventDefault(); if (open && visible[active]) choose(visible[active].id); else setOpen(true); }
        }} />
      {value && <button type="button" className="rf-icon-button rf-clear" aria-label={`مسح ${label}`} onClick={() => { onChange(null); setQuery(""); setOpen(false); }}>×</button>}
      <button type="button" className="rf-dropdown-toggle" disabled={disabled} aria-label={`فتح قائمة ${label}`} onClick={() => { if (open) setOpen(false); else input.current?.focus(); }}>▾</button>
    </div>
    {open && !disabled && <div className="rf-select-menu">
      <div className="rf-menu-caption">{query ? `${matches.length} نتيجة مطابقة` : "اختر من القائمة أو اكتب للبحث"}</div>
      <div id={`${id}-list`} role="listbox" aria-label={label}>
        {visible.map((option, i) => <button type="button" role="option" aria-selected={option.id === value} key={option.id} id={`${id}-option-${i}`} className={`rf-option ${i === active ? "is-active" : ""}`} onMouseDown={e => e.preventDefault()} onPointerMove={() => setActive(i)} onClick={() => choose(option.id)}>
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          {option.badge && <em>{option.badge}</em>}{option.id === value && <span aria-hidden="true">✓</span>}
        </button>)}
        {!visible.length && <div className="rf-no-options">لا توجد اختيارات مطابقة. جرّب كلمة أخرى.</div>}
      </div>
      {matches.length > visible.length && <div className="rf-menu-caption">اكتب جزءًا من الاسم لتضييق النتائج.</div>}
    </div>}
  </div>;
}
