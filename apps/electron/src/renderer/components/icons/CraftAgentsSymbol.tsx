interface CraftAgentsSymbolProps {
  className?: string
}

/**
 * Noodle "Spiral Snap" symbol.
 * Uses currentColor so the active theme controls the brand accent.
 */
export function CraftAgentsSymbol({ className }: CraftAgentsSymbolProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(-1.5, 0.5)">
        <path
          d="M12 12 C12 10, 14 9, 15 10 C17 12, 15 15, 12 15 C8 15, 6 12, 6 9 C6 5, 10 3, 14 3 C19 3, 21 7, 21 12 C21 16, 19 19, 15 20"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
        />
      </g>
    </svg>
  )
}
