/**
 * LabelBadge - Compact chip showing a label's color, name, and optional typed value.
 *
 * Used above FreeFormInput to display applied session labels. Clicking opens
 * LabelValuePopover for editing the value or removing the label.
 *
 * Layout: [colored circle] [name] [value in mono]
 * - Boolean labels (no valueType): just circle + name
 * - Valued labels: circle + name + formatted value in mono text
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { ChevronDown } from 'lucide-react'
import { LabelIcon, LabelValueTypeIcon } from './label-icon'
import { formatDisplayValue } from '@craft-agent/shared/labels'
import { resolveEntityColor } from '@craft-agent/shared/colors'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { useTheme } from '@/context/ThemeContext'

export interface LabelBadgeProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Label configuration (for color, name, valueType) */
  label: LabelConfig
  /** Current raw value string (undefined for boolean labels) */
  value?: string
  /** Whether the popover is currently open (controls active state styling) */
  isActive?: boolean
}

export const LabelBadge = React.forwardRef<HTMLButtonElement, LabelBadgeProps>(
  function LabelBadge({ label, value, isActive = false, className, ...buttonProps }, ref) {
    const { isDark } = useTheme()
    const displayValue = value ? formatDisplayValue(value, label.valueType) : undefined
    const resolvedColor = label.color
      ? resolveEntityColor(label.color, isDark)
      : 'var(--foreground)'

    return (
      <button
        ref={ref}
        type="button"
        {...buttonProps}
        className={cn(
          'h-[30px] pl-3 pr-2 rounded-[8px] inline-flex items-center shrink-0',
          'text-[11px] leading-none font-[450] tracking-[0.012em]',
          'outline-none select-none transition-colors cursor-pointer antialiased',
          'bg-[color-mix(in_srgb,var(--background)_97%,var(--badge-color))]',
          'hover:bg-[color-mix(in_srgb,var(--background)_92%,var(--badge-color))]',
          'text-[color-mix(in_srgb,var(--foreground)_80%,var(--badge-color))]',
          isActive && 'bg-[color-mix(in_srgb,var(--background)_92%,var(--badge-color))]',
          className
        )}
        style={{ '--badge-color': resolvedColor } as React.CSSProperties}
      >
        <LabelIcon label={label} size="lg" />

        <span className="whitespace-nowrap ml-2">{label.name}</span>

        {displayValue ? (
          <>
            <span className="opacity-30 mx-1">·</span>
            <span className="opacity-60 whitespace-nowrap max-w-[100px] truncate">
              {displayValue}
            </span>
          </>
        ) : (
          label.valueType && (
            <>
              <span className="opacity-30 mx-1">·</span>
              <LabelValueTypeIcon valueType={label.valueType} />
            </>
          )
        )}
        <ChevronDown className="h-3 w-3 opacity-40 ml-1 shrink-0" />
      </button>
    )
  }
)
