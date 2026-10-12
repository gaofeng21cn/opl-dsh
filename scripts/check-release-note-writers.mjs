/** Read-only cloud acceptance: use one real published feature, never prepare a release. */
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { writeDailyReleaseNotes } from './daily-release-notes.mjs'
import { renderReleaseNotes } from './release-notes.mjs'

const diff = execFileSync(
  'git',
  [
    'diff',
    'opl-dsh-v0.2.20',
    'opl-dsh-v0.2.21',
    '--',
    'src/context-budget/contracts/budget.ts',
    'docs/context-budget.md',
  ],
  { encoding: 'utf8' },
)
const evidence = {
  version: '0.2.21',
  scope: '仅检查已发布上下文预算功能的写作链路，不是完整版本说明',
  diff,
  commitsMarkdown:
    '- 新增上下文预算观测 ([查看提交](https://github.com/gaofeng21cn/opl-dsh/commit/5f69fb874371aa5a74a133cdd4c1b5a549b0aa8a))',
}
const options = {
  apiKey: process.env.OPL_RELEASE_NOTES_CODEX_API_KEY,
  copilotToken: process.env.GITHUB_TOKEN,
  diagnostics: true,
}
const output = 'dist/release-note-writer-check'
await mkdir(output, { recursive: true })
const results = []
for (const [name, overrides] of [
  ['copilot-live', {}],
  [
    'copilot-failure-to-gateway',
    {
      copilot: async () => {
        throw Error('Injected quota failure')
      },
    },
  ],
  [
    'both-fail-to-mechanical',
    {
      copilot: async () => {
        throw Error('Injected quota failure')
      },
      request: async () => new Response('', { status: 429 }),
    },
  ],
]) {
  const result = await writeDailyReleaseNotes(evidence, { ...options, ...overrides })
  renderReleaseNotes(result.notes, {
    version: '0.2.21',
    officialVersion: '0.2.0-rc.2',
    sourceCommit: '5f69fb874371aa5a74a133cdd4c1b5a549b0aa8a',
  })
  await writeFile(`${output}/${name}.md`, result.notes)
  const { notes, ...receipt } = result
  results.push({ name, ...receipt })
}
await writeFile(`${output}/result.json`, JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify(results, null, 2))
if (results[1].model !== 'gpt-6-luna' || results[2].mode !== 'mechanical')
  throw Error('The required fallback chain did not pass')
