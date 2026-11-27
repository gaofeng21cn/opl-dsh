import { useRef, useState } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SettingsSection.module.css'

export interface SettingsSelectOption {
  value: string
  label: string
}

export interface SettingsSelectProps {
  value: string
  options: readonly SettingsSelectOption[]
  ariaLabel: string
  disabled?: boolean
  name?: string
  onChange: (value: string) => void
}

/** Anchored official-style Menu selector replacing browser-native `<select>` controls. */
export function SettingsSelect({
  value,
  options,
  ariaLabel,
  disabled = false,
  name,
  onChange,
}: SettingsSelectProps) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const activeLabel = options.find((option) => option.value === value)?.label ?? value

  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      align="end"
      portal
      selectedId={value}
      items={options.map((option) => ({ id: option.value, label: option.label }))}
      onSelect={(next) => {
        setOpen(false)
        buttonRef.current?.focus({ preventScroll: true })
        if (!disabled && next !== value) onChange(next)
      }}
      anchor={
        <button
          ref={buttonRef}
          type="button"
          className={css.selector}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          data-opl-select={name}
          data-value={value}
          onClick={() => setOpen((current) => !current)}
        >
          <span>{activeLabel}</span>
          <IconChevronDownOutlineRegular className={css.selectorChevron} size={14} />
        </button>
      }
    />
  )
}
