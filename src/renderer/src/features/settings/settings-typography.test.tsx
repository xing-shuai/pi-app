import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Settings } from '@renderer/components/icons'
import { SettingRow, SettingsSection } from './settings-page-shared'
import { SettingsNavGroup, SettingsNavItem, SettingsPageHeader } from './settings-shell'
import { btnCompact, btnDanger, btnOutline, btnPrimary, inputCls, numberInputCls, selectCls, textareaCls } from './settings-controls'

describe('settings typography primitives', () => {
  it('keeps page, section, label, helper and navigation hierarchy explicit', () => {
    const { container } = render(<>
      <SettingsPageHeader title="Preferences" description="Page helper" />
      <SettingsNavGroup label="Application">
        <SettingsNavItem active icon={Settings} label="General" onClick={vi.fn()} />
      </SettingsNavGroup>
      <SettingsSection title="Appearance" description="Section helper">
        <SettingRow label="Language" description="Row helper" badge={<span className="settings-badge">Preview</span>}>
          <select aria-label="Language" className={selectCls}><option>English</option></select>
        </SettingRow>
      </SettingsSection>
    </>)
    expect(screen.getByRole('heading', { level: 2 })).toHaveClass('settings-page-title', 'text-[24px]', 'leading-[1.5]')
    expect(screen.getByRole('heading', { level: 3 })).toHaveClass('settings-section-title', 'text-[18px]')
    expect(screen.getByText('Language', { selector: '.settings-row-label span' }).parentElement).toHaveClass('text-[16px]', 'leading-[1.5]')
    for (const text of ['Page helper', 'Section helper', 'Row helper']) {
      expect(screen.getByText(text)).toHaveClass('text-[14px]', 'leading-[1.6]')
    }
    expect(screen.getByText('Application')).toHaveClass('settings-nav-caption', 'text-[14px]')
    expect(screen.getByRole('button', { name: 'General' })).toHaveClass('text-[16px]')
    expect(container.querySelector('.settings-nav-icon')).toHaveClass('h-4', 'w-4')
    expect(screen.getByText('Preview')).toHaveClass('settings-badge')
    expect(screen.getByRole('group', { name: 'Language Preview' })).toContainElement(screen.getByRole('combobox'))
  })

  it('uses sans UI controls, readable bounded code and distinct compact actions', () => {
    for (const cls of [inputCls, selectCls, btnOutline, btnPrimary, btnDanger]) {
      expect(cls).toContain('font-sans')
      expect(cls).toContain('text-[16px]')
      expect(cls).toContain('leading-[1.5]')
    }
    expect(inputCls).not.toContain('font-mono')
    expect(numberInputCls).toContain('font-mono text-[16px]')
    expect(textareaCls).toContain('font-mono text-[14px] leading-[1.6]')
    expect(btnCompact).toContain('settings-button-compact')
    expect(btnCompact).toContain('text-[14px]')
    expect([inputCls, numberInputCls, selectCls, textareaCls, btnCompact, btnOutline, btnPrimary, btnDanger].join(' '))
      .not.toMatch(/text-(?:2xs|xs|sm)\b|text-\[(?:10|11|12|13)(?:\.5)?px\]/)
  })
})
