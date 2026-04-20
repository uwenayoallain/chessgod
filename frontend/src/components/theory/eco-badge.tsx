import { Badge } from '@/components/ui/badge'

export function EcoBadge({ eco, name }: { eco?: string | null; name?: string | null }) {
  if (!eco && !name) {
    return <Badge>Unclassified</Badge>
  }

  return <Badge>{[eco, name].filter(Boolean).join(' · ')}</Badge>
}
