import craftLogo from "@/assets/craft_logo_c.svg"

interface CraftAppIconProps {
  className?: string
  size?: number
}

/**
 * CraftAppIcon - Displays the current branded app icon asset.
 */
export function CraftAppIcon({ className, size = 64 }: CraftAppIconProps) {
  return (
    <img
      src={craftLogo}
      alt="Noodle"
      width={size}
      height={size}
      className={className}
    />
  )
}
