import { useState, type CSSProperties } from "react"
import { ChevronDown } from "lucide-react"
import { parseLabelEntry, formatLabelEntry, formatDisplayValue } from "@craft-agent/shared/labels"
import { resolveEntityColor } from "@craft-agent/shared/colors"
import { useTheme } from "@/context/ThemeContext"
import { LabelValuePopover } from "./label-value-popover"
import { LabelIcon, LabelValueTypeIcon } from "./label-icon"
import type { LabelConfig } from "@craft-agent/shared/labels"

interface EntityListLabelBadgeProps {
  label: LabelConfig
  rawValue?: string
  sessionLabels: string[]
  onLabelsChange?: (updatedLabels: string[]) => void
}

export function EntityListLabelBadge({ label, rawValue, sessionLabels, onLabelsChange }: EntityListLabelBadgeProps) {
  const [open, setOpen] = useState(false)
  const { isDark } = useTheme()
  const color = label.color ? resolveEntityColor(label.color, isDark) : null
  const displayValue = rawValue ? formatDisplayValue(rawValue, label.valueType) : undefined

  return (
    <LabelValuePopover
      label={label}
      value={rawValue}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(newValue) => {
        const updated = sessionLabels.map(entry => {
          const parsed = parseLabelEntry(entry)
          if (parsed.id === label.id) return formatLabelEntry(label.id, newValue)
          return entry
        })
        onLabelsChange?.(updated)
      }}
      onRemove={() => {
        const updated = sessionLabels.filter(entry => {
          const parsed = parseLabelEntry(entry)
          return parsed.id !== label.id
        })
        onLabelsChange?.(updated)
      }}
    >
      <div
        role="button"
        tabIndex={0}
        className="h-[30px] pl-3 pr-2 text-[11px] leading-none font-[450] tracking-[0.012em] rounded-[8px] flex items-center shrink-0 outline-none select-none transition-colors cursor-pointer antialiased bg-[color-mix(in_srgb,var(--background)_97%,var(--badge-color))] hover:bg-[color-mix(in_srgb,var(--background)_92%,var(--badge-color))] text-[color-mix(in_srgb,var(--foreground)_80%,var(--badge-color))]"
        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
        style={{ '--badge-color': color ?? 'var(--foreground)' } as CSSProperties}
      >
        <LabelIcon label={label} size="lg" />
        <span className="whitespace-nowrap ml-2">{label.name}</span>
        {displayValue ? (
          <>
            <span className="opacity-30 mx-1">·</span>
            <span className="opacity-60 whitespace-nowrap max-w-[100px] truncate">{displayValue}</span>
          </>
        ) : (
          label.valueType && (
            <>
              <span className="opacity-30 mx-1">·</span>
              <LabelValueTypeIcon valueType={label.valueType} size={10} />
            </>
          )
        )}
        <ChevronDown className="h-3 w-3 opacity-40 ml-1 shrink-0" />
      </div>
    </LabelValuePopover>
  )
}
