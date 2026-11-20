import test from 'node:test'
import assert from 'node:assert/strict'
import helper from '../installer/queue-onboarding.cjs'
const common = {
  installHooks: async () => ({ total: 7, registered: 7, installed: true, trusted: 7, disabled: 0 }),
  supportedVersion: () => true,
  daemon: async () => '0.169.0',
  candidates: () => [],
}

for (const [name, settings, found, expected] of [
  [
    'fresh',
    {},
    '/bin/codex',
    {
      wakeTransport: 'codex-queue',
      wakeExecutable: '/bin/codex',
      wakeExecution: 'native',
      wakeDistro: '',
    },
  ],
  ['missing tool', {}, undefined, {}],
  [
    'preserve WSL',
    {
      wakeExecution: 'wsl',
      wakeDistro: 'Ubuntu',
      wakeExecutable: '/custom/codex',
      wakeTransport: 'codex-queue',
    },
    undefined,
    {},
  ],
  [
    'access only',
    {
      cooperation: { externalCodex: false, autoReview: false, maxRevisions: 1 },
      wakeTransport: 'codex-queue',
      wakeExecutable: '/custom/codex',
    },
    undefined,
    { cooperation: { externalCodex: true, autoReview: false, maxRevisions: 1 } },
  ],
  ['partial', { wakeExecutable: '/custom/codex' }, undefined, { wakeTransport: 'codex-queue' }],
])
  test(name, async () => {
    let patch = {},
      installed = 0,
      started = 0
    const autoStart = name !== 'partial'
    await helper.completeDelegation({
      ...common,
      settings,
      autoStart,
      install: () => installed++,
      enableAutoStart: () => started++,
      select: () => {
        const path = settings.wakeExecutable || found
        return path && { path, resume: true }
      },
      save: (v) => (patch = v),
    })
    assert.deepEqual(patch, expected)
    assert.equal(installed, 1)
    assert.equal(started, Number(!autoStart))
  })

test('macOS finds the ChatGPT bundle without a shell PATH and saves it as the notification bridge', async () => {
  const paths = helper.macQueueCandidates('/Users/test')
  const old = '/Applications/ChatGPT.app/Contents/Resources/codex'
  const supported =
    '/Users/test/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
  const checked = []
  let patch
  await helper.completeDelegation({
    ...common,
    settings: {},
    autoStart: true,
    install: () => {},
    select: () =>
      helper.selectQueue(paths, {
        exists: (path) => path === old || path === supported,
        run: async (path, args) => {
          checked.push(path)
          assert.deepEqual(args, ['queue', '--help'])
          return path === old
            ? { stdout: 'Usage: codex [COMMAND]', stderr: '' }
            : {
                stdout: '',
                stderr: 'Usage: codex queue [OPTIONS]\n  --thread <THREAD>\n  --message <TEXT>',
              }
        },
      }),
    save: (value) => (patch = value),
  })
  assert.deepEqual(checked, [old, supported])
  assert.deepEqual(patch, {
    wakeTransport: 'codex-queue',
    wakeExecutable: supported,
    wakeExecution: 'native',
    wakeDistro: '',
  })
})

test('old configured queue is replaced and daemon receipt is checked after start', async () => {
  const calls = []
  const result = await helper.completeDelegation({
    ...common,
    settings: { wakeExecutable: '/old', wakeTransport: 'codex-queue' },
    autoStart: true,
    install: async () => {},
    candidates: () => ['/new'],
    select: (paths) =>
      helper.selectQueue(paths, {
        exists: () => true,
        run: async (path) => ({
          stdout:
            'Usage: codex queue --thread <THREAD> --message <TEXT> ' +
            (path === '/new' ? '--resume' : ''),
          stderr: '',
        }),
      }),
    save: (patch) => assert.equal(patch.wakeExecutable, '/new'),
    codexHome: '/test/home',
    daemon: (path, home) =>
      helper.ensureDaemon(path, home, async (cmd, args, opt) => {
        assert.equal(cmd, '/new')
        assert.equal(opt.env.CODEX_HOME, home)
        calls.push(args.at(-1))
        if (calls.length === 1) throw Error('not running')
        return { stdout: JSON.stringify({ status: 'running', appServerVersion: '0.169.1' }) }
      }),
  })
  assert.deepEqual(calls, ['version', 'start', 'version'])
  assert.match(result, /可自动接手/)
})
test('a missing daemon or pending hook trust cannot report automatic takeover ready', async () => {
  for (const [daemon, trusted] of [
    [null, 7],
    ['0.169.1', 0],
  ]) {
    const result = await helper.completeDelegation({
      ...common,
      settings: {},
      autoStart: true,
      install: async () => {},
      select: async () => ({ path: '/new', resume: true }),
      save: async () => {},
      daemon: async () => daemon,
      installHooks: async () => ({
        total: 7,
        registered: 7,
        installed: true,
        trusted,
        disabled: 0,
      }),
    })
    assert.doesNotMatch(result, /可自动接手/)
  }
})
