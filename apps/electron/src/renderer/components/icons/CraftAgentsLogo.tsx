import lightLogo from "@/assets/noodle-logo-horizontal.svg"
import darkLogo from "@/assets/noodle-logo-horizontal-dark.svg"
import { useTheme } from "@/context/ThemeContext"

interface CraftAgentsLogoProps {
  className?: string
}

/**
 * Noodle horizontal logo using the packaged brand asset.
 */
export function CraftAgentsLogo({ className }: CraftAgentsLogoProps) {
  const { isDark } = useTheme()

  return (
    <img
      src={isDark ? darkLogo : lightLogo}
      alt="Noodle"
      className={className}
    />
  )
}
