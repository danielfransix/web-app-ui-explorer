import { useEffect, useMemo, useRef, useState } from "react"
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown"
import type { Scenario } from "../shared/types"
import { Button, Checkbox, Disclosure, DisclosurePanel, DisclosureTrigger, Input } from "./ui"

const PAGE_SIZE = 8

export default function ExportScreenSelection({ scenarios, selected, onChange, readOnly }: {
  scenarios: Scenario[]; selected: Set<string>; onChange: (selected: Set<string>) => void; readOnly: boolean
}) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState(""), [page, setPage] = useState(0)
  const matches = useMemo(() => scenarios.filter(s => `${s.title} ${s.id}`.toLowerCase().includes(search.toLowerCase())), [scenarios, search])
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE)), currentPage = Math.min(page, pages - 1)
  const start = currentPage * PAGE_SIZE, visible = matches.slice(start, start + PAGE_SIZE)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { if (list.current) list.current.scrollTop = 0 }, [currentPage, search])
  const count = readOnly ? scenarios.length : scenarios.filter(s => selected.has(s.id)).length
  return <section className="modal-section">
    <h3 className="modal-section-title">Selected screens</h3>
    <Disclosure className="figma-export__screen-disclosure" open={open} onOpenChange={setOpen}>
      <DisclosureTrigger variant="outline" className="figma-export__review-trigger" rightIcon={<CaretDown size={16} />}>
        <span><strong>{count} {count === 1 ? "screen" : "screens"} selected</strong><small>{open ? "Hide selection" : "Review selection"}</small></span>
      </DisclosureTrigger>
      <DisclosurePanel className="figma-export__review-panel">
          <Input className="control" aria-label="Search screens to export" value={search} onChange={event => { setSearch(event.target.value); setPage(0) }} placeholder="Search title or screen ID" />
          {!readOnly && <div className="figma-export__actions">
            <Button variant="ghost" size="sm" onClick={() => onChange(new Set(scenarios.map(s => s.id)))}>Select all</Button>
            <Button variant="ghost" size="sm" onClick={() => onChange(new Set())}>Clear</Button>
          </div>}
            <div ref={list} className="figma-export__screens" role="group" aria-label="Screens to export">
              {visible.map(s => readOnly
                ? <div className="figma-export__screen" key={s.id}><span><strong>{s.title}</strong><small>{s.id}</small></span></div>
                : <label className="figma-export__screen" key={s.id}><Checkbox checked={selected.has(s.id)} onChange={checked => { const next = new Set(selected); checked ? next.add(s.id) : next.delete(s.id); onChange(next) }} /><span><strong>{s.title}</strong><small>{s.id}</small></span></label>)}
              {!matches.length && <p className="modal-meta figma-export__empty" role="status">No screens match your search.</p>}
            </div>
              <nav className="figma-export__pagination" aria-label="Screen review pages">
                <span className="modal-meta" role="status">{matches.length ? `${start + 1}${visible.length > 1 ? `–${start + visible.length}` : ""}` : "0"} of {matches.length} {matches.length === 1 ? "screen" : "screens"}</span>
                <Button variant="outline" size="sm" aria-label="Previous screen page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button>
                <Button variant="outline" size="sm" aria-label="Next screen page" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</Button>
              </nav>
              {readOnly && <p className="modal-meta figma-export__review-help">Change this selection on your Explorer cards.</p>}
      </DisclosurePanel>
    </Disclosure>
  </section>
}
