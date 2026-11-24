/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vite-plus/test'

// Read from disk: under the test runner a CSS import, `?raw` included, comes
// back as an empty string.
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  if (!match) throw new Error(`no rule for ${selector}`)
  return match[1]
}

/** Every property animated by a named @keyframes block. */
function keyframeProperties(name: string): string[] {
  const start = css.indexOf(`@keyframes ${name} {`)
  if (start === -1) throw new Error(`no keyframes named ${name}`)
  const body = css.slice(start, css.indexOf('\n}', start))
  return [...new Set([...body.matchAll(/^\s+([a-z-]+):/gm)].map((found) => found[1]))]
}

/** Every class a selector names. Declarations and comments are not read. */
function selectorClasses(): Set<string> {
  const found = new Set<string>()
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let prelude = ''
  for (const char of bare) {
    if (char === '{') {
      // An at-rule's own prelude (`@media (min-width: 62.5rem)`) holds numbers,
      // never classes.
      if (!prelude.trim().startsWith('@')) {
        for (const match of prelude.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) found.add(match[1])
      }
      prelude = ''
    } else if (char === '}' || char === ';') {
      prelude = ''
    } else {
      prelude += char
    }
  }
  return found
}

/** The app's own source, as one string: everything that can put a class on an element. */
function appSource(): string {
  const parts = [readFileSync(new URL('../index.html', import.meta.url), 'utf8')]
  const walk = (directory: URL) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) parts.push(readFileSync(path, 'utf8'))
    }
  }
  walk(new URL('../src/', import.meta.url))
  return parts.join('\n')
}

describe('index.css', () => {
  it('styles no class that nothing in the app can set', () => {
    // A component that goes takes its markup with it and leaves its rules
    // behind: 100 rules for 69 such classes had piled up, 12.6KB of the file.
    // A class counts as used when the source names it, or builds it from a
    // prefix (`severity--${level}`) or onto a suffix.
    const source = appSource()
    const named = new Set(source.match(/[A-Za-z_][\w-]*/g))
    const prefixes = [
      ...source.matchAll(/([A-Za-z_][\w-]*)\$\{/g),
      ...source.matchAll(/([A-Za-z_][\w-]*[-_])['"`]\s*\+/g),
    ].map((match) => match[1])
    const suffixes = [...source.matchAll(/\}([\w-]+)/g)].map((match) => match[1])
    const built = (name: string) =>
      prefixes.some((prefix) => prefix.length >= 3 && name.startsWith(prefix)) ||
      suffixes.some((suffix) => suffix.length >= 3 && name.endsWith(suffix))

    const classes = selectorClasses()
    // The scan really did read the sheet and the app.
    expect(classes.size).toBeGreaterThan(500)
    expect(named.size).toBeGreaterThan(1000)
    expect([...classes].filter((name) => !named.has(name) && !built(name))).toEqual([])
  })

  it('has no em dash, in a comment or anywhere else', () => {
    expect(css).not.toContain('\u2014')
  })

  it('never transitions every property at once', () => {
    // `all` makes the browser watch layout and paint properties on the busiest
    // controls in the app; each rule names what it actually changes.
    expect(css).not.toMatch(/transition(-property)?:\s*all\b/)
    // A transition with no property name is `all` under another spelling.
    expect(css).not.toMatch(/transition:\s*[\d.]+m?s/)
  })

  it('pulses loading skeletons on the compositor instead of repainting them', () => {
    const skeleton = rule('.skeleton')
    const animation = /animation:\s*([\w-]+)/.exec(skeleton)?.[1]

    expect(animation).toBe('skeleton-pulse')
    expect(keyframeProperties('skeleton-pulse')).toEqual(['opacity'])
    // The old shimmer slid a gradient, which paints on every frame.
    expect(skeleton).not.toMatch(/gradient|background-size/)
    expect(css).not.toMatch(/@keyframes shimmer\b/)
    expect(css).not.toMatch(/^\s+background-position:/m)
  })

  it('gives every component style a text token to use for danger and warning', () => {
    for (const token of ['--accent-text', '--danger-text', '--warning-text']) {
      // Once for the dark theme and once for the light one.
      expect(css.match(new RegExp(`^\\s+${token}:\\s*#[0-9a-f]{6};`, 'gm'))).toHaveLength(2)
    }
  })
})
