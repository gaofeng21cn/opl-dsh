/** Live reasoning and progress in the ordinary conversation, using actual stream events. */
import { useState } from 'react'
import { DisclosureRow, IconThinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import css from './LiveTranscriptRow.module.css'

function Thinking({ text, title, running }: { text: string; title: string; running: boolean }) {
  const [open, setOpen] = useState(false)
  const preview =
    text
      .split(/\n+/)
      .filter((line) => line.trim())
      .at(-1) ?? ''
  return (
    <div data-opl-live-reasoning="">
      <DisclosureRow
        icon={<IconThinkOutlineRegular size={14} />}
        title={title}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen(!open)}
        running={running}
        collapsedContent={<span className={css.preview}>{preview}</span>}
      >
        <div className={css.thought}>{text}</div>
      </DisclosureRow>
    </div>
  )
}

/** Render only the missing live content; completed turns use the official renderer. */
export function LiveTranscriptRow({ node, t }: ChatNodeViewProps<'opl-live-transcript'>) {
  return (
    <div data-opl-live-transcript="" className={css.root}>
      {node.data.blocks.map((block, index) =>
        block.type === 'reasoning' ? (
          <Thinking
            key={index}
            text={block.text}
            title={t('message.think')}
            running={index === node.data.blocks.length - 1}
          />
        ) : (
          <div key={index} className={css.text}>
            {block.text}
          </div>
        ),
      )}
    </div>
  )
}
