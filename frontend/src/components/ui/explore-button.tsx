import { Compass } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { explorePosition } from '@/lib/explore-position'

/**
 * The same way out of every trainer: keep the position, lose the question.
 * Opens the Engine page in Explore with the board as it stands.
 */
export function ExploreButton({ label = 'Explore this position' }: { label?: string }) {
  return (
    <Button onClick={() => explorePosition()} type="button" variant="ghost">
      <Compass size={14} /> {label}
    </Button>
  )
}
