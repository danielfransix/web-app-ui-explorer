import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight"
import { FolderSimple } from "@phosphor-icons/react/dist/csr/FolderSimple"
import { FileCode } from "@phosphor-icons/react/dist/csr/FileCode"
import { Check } from "@phosphor-icons/react/dist/csr/Check"
import { Minus } from "@phosphor-icons/react/dist/csr/Minus"
import { SelectionSlash } from "@phosphor-icons/react/dist/csr/SelectionSlash"
import { SidebarSimple } from "@phosphor-icons/react/dist/csr/SidebarSimple"
import { Button, Checkbox, Disclosure, DisclosurePanel, DisclosureTrigger, Tooltip } from "./ui"
import {
  folderCrumb,
  folderLabel,
  pathSelected,
  type FolderNode,
  type FolderRule,
} from "./folderModel"

// The count sits beside the button, not inside it: it must not become part of the control's name, but is still announced as its description.
const countId = (path: string) => `folder-count-${path.replace(/[^A-Za-z0-9]/g, "-")}`

// A module's only child is its src folder, an implementation detail: show the sections directly.
const visibleChildren = (node: FolderNode) =>
  node.children.flatMap((child) =>
    node.children.length === 1 && child.label === "src" ? child.children : [child],
  )

export default function FolderNavigator({
  tree,
  rules,
  expanded,
  onExpandedChange,
  onToggle,
  onClear,
  collapsed,
  onCollapsedChange,
  count,
}: {
  tree: FolderNode
  rules: FolderRule[]
  // Expansion is owned by the workbench so it survives opening a preview and coming back.
  expanded: string[]
  onExpandedChange: (expanded: string[]) => void
  onToggle: (node: FolderNode) => void
  onClear: () => void
  // Collapsing leaves a narrow rail with a button to bring the explorer back; selection is kept.
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  count: (path: string) => number
}) {
  function row(node: FolderNode) {
    const selected = node.leafPaths.filter((path) =>
      pathSelected(path, rules),
    ).length
    const all = selected > 0 && selected === node.leafPaths.length
    const open = expanded.includes(node.path)
    const children = visibleChildren(node)
    const crumb = folderCrumb(node.path)
    return (
      <li key={node.path}>
        <Disclosure
          open={open}
          onOpenChange={(next) =>
            onExpandedChange(
              next
                ? [...expanded, node.path]
                : expanded.filter((path) => path !== node.path),
            )
          }
        >
          <div className="design-folder-row" data-selected={all}>
            <Checkbox
              checked={all}
              indeterminate={selected > 0 && !all}
              onChange={() => onToggle(node)}
              className="design-folder-checkbox"
              aria-label={`Select ${crumb}`}
            >
              {selected > 0 &&
                (all ? (
                  <Check size={12} weight="bold" />
                ) : (
                  <Minus size={12} weight="bold" />
                ))}
            </Checkbox>
            <DisclosureTrigger
              className="design-folder-label"
              disabled={!children.length}
              aria-label={`${open ? "Collapse" : "Expand"} ${crumb}`}
              aria-describedby={count(node.path) > 0 ? countId(node.path) : undefined}
            >
              {children.length ? (
                <CaretRight size={12} className={open ? "rotate-90" : ""} />
              ) : (
                <span className="w-3" />
              )}
              {node.label.endsWith(".tsx") ? (
                <FileCode size={16} />
              ) : (
                <FolderSimple size={16} />
              )}
              {/* The source path stays available as a tooltip for anyone who needs the file. */}
              <span title={node.path}>{folderLabel(node.label)}</span>
            </DisclosureTrigger>
            {count(node.path) > 0 && (
              <small id={countId(node.path)} aria-hidden="true">
                {count(node.path)}
              </small>
            )}
          </div>
          {!!children.length && (
            <DisclosurePanel>
              <ul className="design-folder-children">{children.map(row)}</ul>
            </DisclosurePanel>
          )}
        </Disclosure>
      </li>
    )
  }
  if (collapsed)
    return (
      <nav
        className="design-folder-sidebar"
        data-collapsed="true"
        aria-label="Source folders"
      >
        <Tooltip label="Show source explorer" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Show source explorer"
            aria-expanded={false}
            onClick={() => onCollapsedChange(false)}
          >
            <SidebarSimple size={20} />
          </Button>
        </Tooltip>
      </nav>
    )
  return (
    <nav className="design-folder-sidebar" aria-label="Source folders">
      <div className="design-folder-sidebar__heading">
        <strong>Source explorer</strong>
        <div className="flex items-center gap-1">
          {rules.some((rule) => rule.selected) && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<SelectionSlash size={16} />}
              onClick={onClear}
            >
              Deselect all
            </Button>
          )}
          <Tooltip label="Hide source explorer" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Hide source explorer"
              aria-expanded
              onClick={() => onCollapsedChange(true)}
            >
              <SidebarSimple size={20} />
            </Button>
          </Tooltip>
        </div>
      </div>
      <ul className="design-folder-tree">{tree.children.map(row)}</ul>
    </nav>
  )
}
