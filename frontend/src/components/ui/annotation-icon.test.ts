import { describe, expect, it } from 'vite-plus/test'

import { annotationTitle, getAnnotationAppearance } from './annotation-icon'

describe('annotation icon appearance', () => {
  it('uses chess.com-style icons and colors for move quality labels', () => {
    expect(getAnnotationAppearance('Brilliant')).toMatchObject({
      symbol: '!!',
      tone: '#1baca6',
    })
    expect(getAnnotationAppearance('Best')).toMatchObject({
      icon: 'star',
      tone: '#95bb4b',
    })
    expect(getAnnotationAppearance('Excellent')).toMatchObject({
      icon: 'thumbs-up',
      tone: '#96bc4b',
    })
    expect(getAnnotationAppearance('Good')).toMatchObject({
      icon: 'check',
      tone: '#96af8b',
    })
    expect(getAnnotationAppearance('Book')).toMatchObject({
      icon: 'book',
      tone: '#a88865',
    })
    expect(getAnnotationAppearance('Inaccuracy')).toMatchObject({
      symbol: '?!',
      tone: '#f7c631',
    })
    expect(getAnnotationAppearance('Mistake')).toMatchObject({
      symbol: '?',
      tone: '#ffa459',
    })
    expect(getAnnotationAppearance('Blunder')).toMatchObject({
      symbol: '??',
      tone: '#fa412d',
    })
    expect(getAnnotationAppearance('Missed Win')).toMatchObject({
      icon: 'minus',
      tone: '#dbac16',
    })
  })

  it('keeps titles available for badges and tooltips', () => {
    expect(annotationTitle('Book')).toContain('opening move')
    expect(annotationTitle('Unknown')).toBe('Unknown')
  })
})
