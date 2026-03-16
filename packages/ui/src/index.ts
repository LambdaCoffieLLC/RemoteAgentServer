export const badgeTones = ['neutral', 'info', 'success', 'warning', 'danger'] as const

export type BadgeTone = (typeof badgeTones)[number]

export interface NavigationItem {
  id: string
  label: string
  href: string
}

export interface StatusBadge {
  label: string
  tone: BadgeTone
}

export function createNavigationItem(id: string, label: string, href: string): NavigationItem {
  return {
    id,
    label,
    href,
  }
}

export function createStatusBadge(label: string, tone: BadgeTone = 'neutral'): StatusBadge {
  return {
    label,
    tone,
  }
}
