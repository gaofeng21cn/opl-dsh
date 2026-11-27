import { useRef } from 'react'
import css from './SettingsSection.module.css'

export function ExecutableBrowser({
  disabled,
  onPick,
  label = '浏览可执行文件',
}: {
  disabled: boolean
  onPick: (path: string) => void
  label?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const paths = (
    globalThis as typeof globalThis & { __DSH_HOST_PATHS__?: { pathFor(file: File): string } }
  ).__DSH_HOST_PATHS__
  if (!paths?.pathFor) return null
  return (
    <>
      <input
        ref={input}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          const path = file && paths.pathFor(file)
          if (path) onPick(path)
        }}
      />
      <button
        type="button"
        className={css.browseButton}
        disabled={disabled}
        aria-label={label}
        title={label}
        onClick={() => input.current?.click()}
      >
        ...
      </button>
    </>
  )
}
