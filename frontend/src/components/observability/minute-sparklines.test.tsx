// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vite-plus/test'

import { MinuteSparklines } from './minute-sparklines'
import type { MinuteBucket } from './types'

describe('MinuteSparklines', () => {
  it('renders three sparkline svgs even with empty data', () => {
    const { container } = render(<MinuteSparklines series={[]} />)
    const svgs = container.querySelectorAll('svg')
    expect(svgs.length).toBe(3)
    svgs.forEach((svg) => {
      expect(svg.querySelector('path')).toBeTruthy()
    })
  })

  it('renders polylines that include the supplied datapoints', () => {
    const series: MinuteBucket[] = Array.from({ length: 10 }, (_, idx) => ({
      minute: new Date(Date.now() - (10 - idx) * 60_000).toISOString(),
      requests: idx,
      errors: idx % 3 === 0 ? 1 : 0,
      p95_ms: idx * 5,
    }))
    const { container } = render(<MinuteSparklines series={series} />)
    const paths = Array.from(container.querySelectorAll('svg path'))
    expect(paths.length).toBe(3)
    paths.forEach((path) => {
      expect(path.getAttribute('d')?.length ?? 0).toBeGreaterThan(0)
    })
  })
})
