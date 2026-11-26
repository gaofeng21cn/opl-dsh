import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const repository = 'gaofeng21cn/opl-dsh'
const workflow = 'stable-release.yml'
const workflowPath = `.github/workflows/${workflow}`
const platforms = ['macos-15', 'windows-latest']
const hash = (value) => createHash('sha256').update(value).digest('hex')

export const officialFeedFingerprint = (feeds) => hash(JSON.stringify(feeds))

export function recoveryKeys(root, sourceCommit, feeds, workflowCommit) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const { package: packageJob, qualify } = JSON.parse(
    execFileSync(
      'ruby',
      ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(STDIN.read).fetch("jobs"))'],
      { input: git('show', `${workflowCommit}:${workflowPath}`), encoding: 'utf8' },
    ),
  )
  const qualificationFiles = git(
    'ls-tree',
    '-r',
    workflowCommit,
    'scripts',
    'package.json',
    'package-lock.json',
    'installer/release-manifest.mjs',
  )
    .split('\n')
    .filter((line) =>
      /\t(?:scripts\/(?:qualification-[^/]+|qualify-official-runtime\.mjs|verify-official-runtime\.mjs)|package(?:-lock)?\.json|installer\/release-manifest\.mjs)$/.test(
        line,
      ),
    )
  return {
    packageKey: hash(JSON.stringify([sourceCommit, officialFeedFingerprint(feeds), packageJob])),
    qualificationKey: hash(JSON.stringify([qualify, qualificationFiles])),
  }
}

/** Only the canonical workflow's completed main runs are allowed to supply checkpoints. */
export async function findReleaseCheckpoints(
  { packageKey, qualificationKey },
  { api = github, repositoryId = Number(process.env.GITHUB_REPOSITORY_ID) } = {},
) {
  const base = `repos/${repository}/actions`
  const { workflow_runs: recent } = await api(
    `${base}/workflows/${workflow}/runs?branch=main&status=completed&per_page=12`,
  )
  const trustedRuns = recent.filter(
    (run) =>
      run.path === workflowPath &&
      run.head_branch === 'main' &&
      run.status === 'completed' &&
      ['schedule', 'workflow_dispatch'].includes(run.event) &&
      run.repository?.id === repositoryId &&
      run.head_repository?.id === repositoryId &&
      Number.isSafeInteger(run.id),
  )
  const artifacts = (
    await Promise.all(
      trustedRuns.map(async (run) => {
        const { artifacts } = await api(`${base}/runs/${run.id}/artifacts?per_page=100`)
        return artifacts
          .filter(
            (artifact) =>
              !artifact.expired &&
              Number.isSafeInteger(artifact.id) &&
              /^sha256:[a-f0-9]{64}$/.test(artifact.digest),
          )
          .map(({ id, name }) => ({ id, name, run: run.id }))
      }),
    )
  ).flat()
  const candidate = artifacts
    .filter(({ name }) => name.startsWith(`release-candidate-${packageKey}-`))
    .sort((left, right) => right.id - left.id)[0]
  const evidence = Object.fromEntries(
    platforms.map((platform) => [
      platform,
      candidate &&
        artifacts.find(
          ({ name }) =>
            name === `release-qualification-${platform}-${candidate.id}-${qualificationKey}`,
        ),
    ]),
  )
  return { candidate, evidence, pending: platforms.filter((platform) => !evidence[platform]) }
}

async function github(path) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
    },
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw Error(`GitHub Actions checkpoint lookup returned HTTP ${response.status}`)
  return response.json()
}

export async function planReleaseRecovery(
  root,
  sourceCommit,
  feeds,
  workflowCommit,
  { reuse, api },
) {
  const keys = recoveryKeys(root, sourceCommit, feeds, workflowCommit)
  const fresh = { ...keys, evidence: {}, pending: platforms }
  if (!reuse) return fresh
  try {
    return { ...keys, ...(await findReleaseCheckpoints(keys, { api })) }
  } catch (error) {
    console.warn(`无法读取近期发布产物，本轮重新构建和验收：${error.message}`)
    return fresh
  }
}
