import { describe, expect, it } from 'vitest'

import { annotationTitle, getAnnotationAppearance } from './annotation-icon'

describe('annotation icon appearance', () => {
  it('uses chess.com-style icons and colors for move quality labels', () => {
    expect(getAnnotationAppearance('Brilliant')).toMatchObject({
      symbol: '!!',
      tone: '#20bfb4',
    })
    expect(getAnnotationAppearance('Best')).toMatchObject({
      icon: 'star',
      tone: '#91c84f',
    })
    expect(getAnnotationAppearance('Excellent')).toMatchObject({
      icon: 'thumbs-up',
      tone: '#8fc45a',
    })
    expect(getAnnotationAppearance('Good')).toMatchObject({
      icon: 'check',
      tone: '#98b98d',
    })
    expect(getAnnotationAppearance('Book')).toMatchObject({
      icon: 'book',
      tone: '#c99b67',
    })
    expect(getAnnotationAppearance('Inaccuracy')).toMatchObject({
      symbol: '?!',
      tone: '#f1c232',
    })
    expect(getAnnotationAppearance('Mistake')).toMatchObject({
      symbol: '?',
      tone: '#f39a32',
    })
    expect(getAnnotationAppearance('Blunder')).toMatchObject({
      symbol: '??',
      tone: '#ef4b42',
    })
    expect(getAnnotationAppearance('Missed Win')).toMatchObject({
      icon: 'minus',
      tone: '#f0c808',
    })
  })

  it('keeps titles available for badges and tooltips', () => {
    expect(annotationTitle('Book')).toContain('opening move')
    expect(annotationTitle('Unknown')).toBe('Unknown')
  })
})
