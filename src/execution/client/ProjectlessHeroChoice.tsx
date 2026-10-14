import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

/** Explicitly start the blank Conversation outside every Workspace. */
export function ProjectlessHeroChoice({ create }: { create: () => void }) {
  return (
    <Button variant="toolbar" size="sm" aria-label="不选择工作区，创建项目外会话" onClick={create}>
      项目外
    </Button>
  )
}
