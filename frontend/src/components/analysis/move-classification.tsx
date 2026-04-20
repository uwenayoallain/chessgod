import { Badge } from '@/components/ui/badge'
import { classifyCpLoss } from '@/lib/analysis/replay-annotations'

export function classifyMove(cpLoss: number) {
  return classifyCpLoss(cpLoss)
}

export function MoveClassification({ cpLoss }: { cpLoss: number }) {
  return <Badge>{classifyMove(cpLoss)}</Badge>
}
