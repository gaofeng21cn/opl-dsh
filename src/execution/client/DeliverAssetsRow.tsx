/** One compact file item per real `<deliver-assets type="file">` delivery. */
import { useState } from 'react'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import css from './DeliverAssetsRow.module.css'

/**
 * Render the converted deliveries of one assistant reply.
 *
 * The path is shown exactly as recorded and is never probed: a delivery whose
 * file is gone keeps its name and path instead of pretending to exist. Opening
 * goes through the official `openFile` owner callback, so the sidebar, history
 * and reveal-line behaviour stay the official ones; this row never reads or
 * writes the file itself.
 */
export function DeliverAssetsRow({ node, openFile }: ChatNodeViewProps<'opl-deliver-assets'>) {
  // The official opener reports nothing back and returns void, so success is
  // never claimed here. Only a thrown failure is surfaced, against the file it
  // belongs to, rather than being swallowed into a silent no-op.
  const [failures, setFailures] = useState<Record<string, string>>({})

  function open(path: string) {
    try {
      openFile(path)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setFailures((previous) => ({ ...previous, [path]: detail }))
      return
    }
    // A later click that no longer throws retires the stale failure. That is
    // recovery of the previous error, not a success claim: the official opener
    // stays silent either way, so no "opened" state is ever rendered.
    setFailures((previous) => {
      if (!(path in previous)) return previous
      const next = { ...previous }
      delete next[path]
      return next
    })
  }

  return (
    <ul className={css.root} data-opl-deliver-assets="">
      {node.data.files.map((file) => (
        <li key={file.path} className={css.item}>
          <div className={css.head}>
            <span className={css.name}>{file.name}</span>
            <button type="button" className={css.open} onClick={() => open(file.path)}>
              打开
            </button>
          </div>
          <span className={css.path}>{file.path}</span>
          {failures[file.path] ? (
            <span className={css.error} role="alert" data-opl-deliver-assets-error="">
              打开失败：{failures[file.path]}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
