import { FlipVertical, RotateCcw, StepBack, StepForward } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/app-store'

export function BoardControls() {
  const { goBack, goForward, resetToStart, flipBoard, colorFilter, setColorFilter, timeClassFilter, setTimeClassFilter } = useAppStore()

  return (
    <div className="toolbar">
      <Button onClick={goBack} type="button"><StepBack size={16} /></Button>
      <Button onClick={goForward} type="button"><StepForward size={16} /></Button>
      <Button onClick={resetToStart} type="button"><RotateCcw size={16} /></Button>
      <Button onClick={flipBoard} type="button"><FlipVertical size={16} /></Button>
      <select className="select" onChange={(event) => setColorFilter(event.target.value as 'white' | 'black' | 'both')} value={colorFilter}>
        <option value="both">Both</option>
        <option value="white">White</option>
        <option value="black">Black</option>
      </select>
      <select className="select" onChange={(event) => setTimeClassFilter(event.target.value || null)} value={timeClassFilter ?? ''}>
        <option value="">All time classes</option>
        <option value="bullet">Bullet</option>
        <option value="blitz">Blitz</option>
        <option value="rapid">Rapid</option>
        <option value="daily">Daily</option>
      </select>
    </div>
  )
}
