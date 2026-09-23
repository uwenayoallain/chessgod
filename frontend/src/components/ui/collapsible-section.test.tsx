// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vite-plus/test'

import { CollapsibleSection } from './collapsible-section'

/**
 * The open marker is a contract with the stylesheet: `.section--open
 * .section__chevron` is what rotates the arrow from pointing right to pointing
 * down. The CSS used to key off `.section__header--open`, a class nothing ever
 * set, so the chevron stayed pointing right however open the section was.
 */
describe('CollapsibleSection open marker', () => {
  it('marks the section open so the chevron can rotate', () => {
    const { container } = render(
      <CollapsibleSection defaultOpen id="open-test" title="Engine">
        <p>body</p>
      </CollapsibleSection>,
    )

    const section = container.querySelector('section')
    expect(section?.className).toContain('section--open')
    expect(section?.querySelector('.section__chevron')).not.toBeNull()
    expect(container.querySelector('[aria-expanded="true"]')).not.toBeNull()
  })

  it('drops the marker when closed', () => {
    const { container } = render(
      <CollapsibleSection defaultOpen={false} id="closed-test" title="Engine">
        <p>body</p>
      </CollapsibleSection>,
    )

    const section = container.querySelector('section')
    expect(section?.className).not.toContain('section--open')
    expect(container.querySelector('[aria-expanded="false"]')).not.toBeNull()
  })
})
