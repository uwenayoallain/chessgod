import { Bookmark } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { RepertoireNode } from '@/hooks/use-repertoire'
import { useRepertoireMark } from '@/hooks/use-repertoire'

export function MarkButton({
  color,
  node,
  username,
}: {
  color: 'white' | 'black'
  node: RepertoireNode
  username: string
}) {
  const mutation = useRepertoireMark()
  if (!node.move?.uci) return null

  const label = node.marked
    ? `Remove ${node.move.san} from your repertoire`
    : `Add ${node.move.san} to your repertoire`

  return (
    <Button
      aria-label={label}
      aria-pressed={node.marked}
      disabled={mutation.isPending}
      onClick={() => {
        mutation.mutate({
          username,
          fen: node.fen,
          color,
          intended_move_uci: node.move!.uci!,
          intended_move_san: node.move!.san,
          remove: node.marked,
        })
      }}
      title={label}
      type="button"
      variant={node.marked ? 'primary' : 'ghost'}
    >
      <Bookmark size={14} />
    </Button>
  )
}
