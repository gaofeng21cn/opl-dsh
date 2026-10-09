import { createServer } from 'node:http'
import { readFile, mkdir, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertIsolatedRoot, safeBinding } from './qualification-support.mjs'
// Run against an already booted, isolated official Desktop. Never target a user's profile.
const root = await assertIsolatedRoot(process.argv[2] ?? '')
const binding = safeBinding(
  JSON.parse(await readFile(join(root, 'profiles/desktop/control.json'), 'utf8')),
)
async function rpc(namespace, method, args = {}) {
  const response = await fetch(binding.endpoint, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' },
    body: JSON.stringify({ namespace, method, args }),
    signal: AbortSignal.timeout(30000),
  })
  const out = await response.json()
  if (!out.ok) throw Error(out.error)
  return out.value
}
const url = await rpc('oplSuite', 'setupUrl')
const response = await fetch(url, { redirect: 'manual' })
const cookie = response.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
    .join('; '),
  origin = new URL(url).origin
async function request(method, payload) {
  const response = await fetch(origin + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    signal: AbortSignal.timeout(30000),
  })
  const out = await response.json()
  if (!out.result?.ok) throw Error(out.result?.error?.message ?? '调用失败')
  return out.result.value
}
const wire = (method, args = {}) => request(method, { args })
const harness = (method, input = {}) =>
  wire('oplExecution/' + method, Object.keys(input).length ? { request: input } : {})
const gateway = (method, input) =>
  wire('oplGatewayModels/' + method, input ? { request: input } : {})
if (process.argv.includes('--readback-selections')) {
  const selections = JSON.parse(
    await readFile(join(root, 'profiles/desktop/combination-selection.json'), 'utf8'),
  )
  if (!Object.keys(selections).length) throw Error('没有可验收的组合选择记录')
  for (const [sessionId, combination] of Object.entries(selections)) {
    // A restarted Host has not loaded these persisted Sessions yet. Resume
    // their exact identity through the official owner before reading the
    // Session projection; otherwise modelSelection can only see the default.
    await rpc('session', 'create', { request: { sessionId } })
    assert.equal((await harness('model-selection', { sessionId })).combination, combination)
  }
  console.log(JSON.stringify({ selectionRestore: true, sessions: Object.keys(selections).length }))
  process.exit(0)
}
const project = join(root, 'test-project')
await mkdir(project, { recursive: true })
import assert from 'node:assert/strict'
// Exercise the OPL control adapter against the official permission and Workspace owners.
const permissionSession = await rpc('session', 'create', {
  request: { cwd: project, permissionPreset: 'danger-full-access' },
})
assert.equal(permissionSession.permissions.preset, 'danger-full-access')
assert.equal(permissionSession.permissions.sandbox, 'danger-full-access')
assert.equal(permissionSession.permissions.approval, 'never')
const permissionRead = await rpc('session', 'permissions', {
  request: { sessionId: permissionSession.sessionId },
})
assert.equal(permissionRead.preset, 'danger-full-access')
assert.equal(permissionRead.running, false)
const placement = await rpc('workspace', 'follow')
assert(
  placement.value.items.some(
    (item) => item.path === project && item.sessionIds.includes(permissionSession.sessionId),
  ),
  'control-created Session is missing from its exact Workspace',
)
const switched = await rpc('session', 'selectPermissions', {
  request: { sessionId: permissionSession.sessionId, preset: 'read-only' },
})
assert.equal(switched.permissions.sandbox, 'read-only')
assert.equal(
  (
    await rpc('session', 'permissions', {
      request: { sessionId: permissionSession.sessionId },
    })
  ).preset,
  'read-only',
)
const requests = []
let gitBashProbe = false
const server = createServer(async (req, res) => {
  try {
    let bytes = ''
    for await (const chunk of req) bytes += chunk
    const body = JSON.parse(bytes),
      isMessages = req.url.includes('/messages')
    const usedTool = body.messages.some(
      (m) =>
        m.role === 'tool' ||
        (Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')),
    )
    const toolName = gitBashProbe ? 'bash' : 'list_harness_combinations'
    const toolInput = gitBashProbe
      ? {
          command: 'git --version && printf OPL_GIT_BASH_OK > opl-git-bash-smoke.txt',
          description: 'Verify Git Bash in the isolated workspace',
          timeoutMs: 10000,
        }
      : {}
    const hasTool = body.tools?.some((t) => (t.name ?? t.function?.name) === toolName)
    requests.push({
      path: req.url,
      model: body.model,
      key: req.headers['x-api-key'] ?? req.headers.authorization,
      usedTool,
      hasTool,
    })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (isMessages) {
      const send = (x) => res.write(`event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`)
      send({
        type: 'message_start',
        message: {
          id: 'msg_fixture',
          model: body.model,
          role: 'assistant',
          type: 'message',
          content: [],
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      })
      if (!usedTool && hasTool) {
        send({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'fixture_tool', name: toolName, input: {} },
        })
        send({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
        })
      } else {
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'runtime verified' },
        })
      }
      send({ type: 'content_block_stop', index: 0 })
      send({
        type: 'message_delta',
        delta: { stop_reason: !usedTool && hasTool ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: 4 },
      })
      send({ type: 'message_stop' })
    } else {
      const send = (delta) =>
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'chat_fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason: null }],
            }) +
            '\n\n',
        )
      send({ role: 'assistant' })
      if (!usedTool && hasTool)
        send({
          tool_calls: [
            {
              index: 0,
              id: 'call_fixture',
              type: 'function',
              function: { name: toolName, arguments: JSON.stringify(toolInput) },
            },
          ],
        })
      else send({ content: 'runtime verified' })
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'chat_fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model,
            choices: [
              { index: 0, delta: {}, finish_reason: !usedTool && hasTool ? 'tool_calls' : 'stop' },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          }) +
          '\n\ndata: [DONE]\n\n',
      )
    }
    res.end()
  } catch (e) {
    res.writeHead(500)
    res.end('fixture failed')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port + '/v1'
try {
  await wire('credentials/set', { ref: 'OPL_GATEWAY_DEEPSEEK_API_KEY', value: 'fixture-deepseek' })
  await wire('credentials/set', { ref: 'OPL_GATEWAY_CODEX_API_KEY', value: 'fixture-codex' })
  await wire('settings/mutate', {
    ns: 'opl-suite',
    ops: [{ op: 'set', path: ['gateway', 'baseURL'], value: base }],
  })
  await wire('settings/mutate', {
    ns: 'llm-pi-ai',
    ops: [
      { op: 'set', path: ['providers', 'opl-gateway-openai', 'baseURL'], value: base },
      { op: 'set', path: ['providers', 'opl-gateway-openai', 'api'], value: 'openai-completions' },
    ],
  })
  async function editGateway(group, input) {
    let snapshot = await gateway('read'),
      descriptor = snapshot.groups.find((g) => g.id === group)
    if (!descriptor) throw Error(`验收分组不存在：${group}`)
    try {
      return await gateway('edit', { group, revision: descriptor.revision, ...input })
    } catch (error) {
      if (!String(error?.message ?? error).includes('changed since it was read')) throw error
      snapshot = await gateway('read')
      descriptor = snapshot.groups.find((g) => g.id === group)
      return gateway('edit', { group, revision: descriptor.revision, ...input })
    }
  }
  await editGateway('deepseek', { models: [{ id: 'deepseek-flash', name: 'DeepSeek 设置回读' }] })
  await editGateway('codex', {
    api: 'openai-completions',
    models: [
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
    ],
  })
  const native = await wire('session/modelCatalog')
  const models = native.groups.find((g) => g.id === 'opl-gateway').models
  assert.equal(models.find((m) => m.id === 'deepseek-flash').name, 'DeepSeek 设置回读')
  assert(models.some((m) => m.id === 'codex::gpt-5.4'))
  assert(models.some((m) => m.id === 'codex::deepseek-flash'))
  const catalog = await harness('catalog')
  const gpt = {
    id: 'accept-gpt-dsh',
    name: 'GPT protocol acceptance',
    modelRef: { provider: 'opl-gateway', model: 'codex::gpt-5.4' },
    harnessRef: 'dsh',
    permissionPolicy: 'read-only',
    isDefault: false,
    enabled: true,
  }
  catalog.combinations.push(gpt)
  await harness('save-catalog', { catalog })
  for (const combination of ['dsh/deepseek-flash', gpt.id]) {
    const s = await harness('start', {
      combination,
      cwd: project,
      taskId: 'accept-' + crypto.randomUUID(),
      origin: { kind: 'desktop', sessionId: 'isolated-acceptance' },
      sandbox: 'read-only',
    })
    if (combination === gpt.id) {
      await harness('select-combination', { sessionId: s.acpSessionId, combination })
      assert.equal(
        (await harness('model-selection', { sessionId: s.acpSessionId })).combination,
        combination,
      )
    }
    await harness('prompt', {
      sessionId: s.id,
      text: 'Read the available combination list once, then reply runtime verified.',
      operationId: crypto.randomUUID(),
    })
    const result = await rpc('harness', 'wait', { sessionId: s.id })
    assert.equal(
      result.state,
      'completed',
      JSON.stringify(result.turns.map((t) => ({ state: t.state, error: t.error }))),
    )
  }
  assert(requests.some((r) => r.path.endsWith('/messages') && r.key === 'fixture-deepseek'))
  assert(
    requests.some(
      (r) =>
        r.path.endsWith('/chat/completions') &&
        r.key === 'Bearer fixture-codex' &&
        r.model === 'gpt-5.4',
    ),
  )
  assert(requests.filter((r) => r.usedTool).length >= 2, 'official tool execution missing')
  if (process.platform === 'win32') {
    // MSYS2 external programs need full access with the official rc.2 backend.
    // Only this disposable Session receives that explicit preset.
    gitBashProbe = true
    const shellSession = await rpc('session', 'create', {
      request: { cwd: project, permissionPreset: 'danger-full-access' },
    })
    assert.equal(shellSession.permissions.preset, 'danger-full-access')
    await rpc('session', 'selectModel', {
      request: {
        sessionId: shellSession.sessionId,
        provider: 'opl-gateway',
        model: 'deepseek-flash',
      },
    })
    const receipt = await rpc('session', 'prompt', {
      request: {
        sessionId: shellSession.sessionId,
        requestId: crypto.randomUUID(),
        mode: 'queue',
        content: [{ type: 'text', text: 'Run the isolated Git Bash smoke once.' }],
      },
    })
    assert.equal(receipt.accepted, true)
    const result = await rpc('session', 'wait', { sessionId: shellSession.sessionId })
    assert.equal(result.outcome.kind, 'completed')
    assert.equal(await readFile(join(project, 'opl-git-bash-smoke.txt'), 'utf8'), 'OPL_GIT_BASH_OK')
  }
  await wire('credentials/set', { ref: 'OPL_GATEWAY_GROK_API_KEY', value: 'fixture-grok' })
  const wrapper = join(
    root,
    process.platform === 'win32' ? 'fixture-harness.cmd' : 'fixture-harness',
  )
  const agentFixture = resolve(import.meta.dirname, '../tests/fixtures/acp-agent.mjs')
  await writeFile(
    wrapper,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${agentFixture}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${agentFixture.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o700 },
  )
  const externalCatalog = await harness('catalog')
  externalCatalog.harnesses.find((item) => item.id === 'grok-build').command = wrapper
  const minimaxWrapper = join(
    root,
    process.platform === 'win32' ? 'fixture-minimax.cmd' : 'fixture-minimax',
  )
  const minimaxFixture = resolve(import.meta.dirname, '../tests/fixtures/minimax-acp-agent.mjs')
  await writeFile(
    minimaxWrapper,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${minimaxFixture}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath}' '${minimaxFixture}' "$@"\n`,
    { mode: 0o700 },
  )
  externalCatalog.harnesses.find((item) => item.id === 'minimax-code').command = minimaxWrapper
  await harness('save-catalog', { catalog: externalCatalog })
  let history = await harness('snapshot', { sessionId: 'harness-qualification-history' })
  assert.equal(history.nativeSessionId, 'session-harness-qualification-history')
  const fullAccess = await harness('start', {
    combination: 'minimax-code/MiniMax-M3',
    cwd: project,
    taskId: 'qualification-full-access-permissions',
    origin: { kind: 'codex', sessionId: 'qualification-permission-review' },
    sandbox: 'full-access',
  })
  const fullAccessPermissions = await rpc('session', 'permissions', {
    request: { sessionId: fullAccess.nativeSessionId },
  })
  assert.equal(fullAccessPermissions.preset, 'danger-full-access')
  assert.equal(fullAccessPermissions.sandbox, 'danger-full-access')
  assert.equal(fullAccessPermissions.approval, 'never')
  await harness('prompt', {
    sessionId: fullAccess.id,
    text: 'TRANSCRIPT_FIXTURE',
    operationId: 'transcript',
  })
  await rpc('harness', 'wait', { sessionId: fullAccess.id })
  const transcriptState = await harness('snapshot', { sessionId: fullAccess.id })
  assert.equal(transcriptState.title, 'MiniMax transcript title')
  const transcript = await rpc('session', 'snapshot', {
    request: {
      address: { kind: 'session', sessionId: fullAccess.nativeSessionId },
      maxMessages: 50,
    },
  })
  const transcriptJson = JSON.stringify(transcript.records)
  assert(transcriptJson.includes('Inspecting the repository.'))
  assert(transcriptJson.includes('"type":"reasoning"'))
  assert(transcriptJson.includes('TRANSCRIPT_DONE'))
  assert(transcriptJson.includes('opl_harness_tool'))
  assert(transcriptJson.includes('oplHarness'))
  await assert.rejects(access(join(project, 'calls.txt')), 'history import executed a prompt')
  const oldPage = await rpc('session', 'snapshot', {
    request: { address: { kind: 'session', sessionId: history.nativeSessionId }, maxMessages: 50 },
  })
  assert(JSON.stringify(oldPage.records).includes('HISTORY_USER'))
  assert(JSON.stringify(oldPage.records).includes('HISTORY_RESULT'))
  if (process.platform === 'win32') {
    for (const sandbox of ['read-only', 'workspace']) {
      await assert.rejects(
        harness('start', {
          combination: history.combination,
          cwd: project,
          taskId: 'qualification-restricted-' + sandbox,
          origin: history.origin,
          sandbox,
        }),
        /Windows.*沙箱后端/,
      )
    }
  }
  const continued = await harness('start', {
    combination: history.combination,
    cwd: project,
    existingSessionId: history.id,
    origin: history.origin,
    sandbox: history.sandbox,
  })
  assert.equal(continued.acpSessionId, history.acpSessionId)
  await harness('prompt', {
    sessionId: history.id,
    operationId: 'live-after-import',
    text: 'NEW_NATIVE_CONVERSATION',
  })
  history = await rpc('harness', 'wait', { sessionId: history.id })
  assert.equal(history.state, 'completed', JSON.stringify(history.turns.at(-1)))
  assert.equal(await readFile(join(project, 'calls.txt'), 'utf8'), 'NEW_NATIVE_CONVERSATION\n')
  const agentPage = await rpc('session', 'snapshot', {
    request: { address: { kind: 'session', sessionId: history.nativeSessionId }, maxMessages: 50 },
  })
  assert(JSON.stringify(agentPage.records).includes('result:NEW_NATIVE_CONVERSATION'))
  assert(JSON.stringify(agentPage.records).includes('tool/result'))
  const nativeTurns = agentPage.records
    .filter((item) => item.event?.type === 'turn/start')
    .map((item) => item.event.data.turn)
  assert.equal(new Set(nativeTurns).size, nativeTurns.length)
  const projects = await rpc('workspace', 'follow')
  assert(
    projects.value.items.some(
      (item) => item.path === project && item.sessionIds.includes(history.nativeSessionId),
    ),
  )
  const concurrentProject = join(root, 'scoped-project')
  await mkdir(concurrentProject, { recursive: true })
  const scoped = async (taskId) =>
    harness('start', {
      combination: history.combination,
      cwd: concurrentProject,
      taskId,
      origin: { kind: 'codex', sessionId: 'qualification-scoped-review' },
      sandbox: process.platform === 'win32' ? 'full-access' : 'workspace',
    })
  const a = await scoped('scope-a'),
    b = await scoped('scope-b'),
    conflict = await scoped('scope-conflict')
  await harness('prompt', {
    sessionId: a.id,
    text: 'wait',
    operationId: 'hold',
    writeScope: ['src/client'],
  })
  await harness('prompt', {
    sessionId: b.id,
    text: 'wait',
    operationId: 'hold',
    writeScope: ['src/host'],
  })
  // Bounded transport readiness: wait for the two fixture admissions, not model progress.
  for (let attempt = 0; attempt < 60; attempt++) {
    const calls = await readFile(join(concurrentProject, 'calls.txt'), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return ''
    })
    if (calls === 'wait\nwait\n') break
    if (attempt === 59) throw Error('two scoped Harness prompts did not run together')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal((await harness('snapshot', { sessionId: a.id })).state, 'running')
  assert.equal((await harness('snapshot', { sessionId: b.id })).state, 'running')
  await harness('prompt', {
    sessionId: conflict.id,
    text: 'overlap',
    operationId: 'one',
    writeScope: ['src/client/file.ts'],
  })
  assert.equal((await harness('snapshot', { sessionId: conflict.id })).state, 'queued')
  await harness('cancel', { sessionId: a.id })
  assert.equal((await rpc('harness', 'wait', { sessionId: conflict.id })).state, 'completed')
  assert.equal((await harness('snapshot', { sessionId: b.id })).state, 'running')
  await harness('cancel', { sessionId: b.id })
  assert.equal(
    await readFile(join(concurrentProject, 'calls.txt'), 'utf8'),
    'wait\nwait\noverlap\n',
  )
  console.log(
    JSON.stringify(
      {
        nativeSettingsReadback: true,
        controlPermissions: true,
        controlProjectAttribution: true,
        ...(gitBashProbe ? { gitBashExecution: true } : {}),
        scopedConcurrentWriters: {
          independentRunningTogether: true,
          overlapQueued: true,
          cancellationReleasesOwnScope: true,
        },
        controlPermissions: true,
        harnessTranscript: {
          sessionId: fullAccess.nativeSessionId,
          thinking: true,
          automaticTitle: true,
          toolPresentation: true,
        },
        controlProjectAttribution: true,
        groupedModels: models.map((m) => m.id),
        officialTools: true,
        externalOrdinaryConversation: {
          historyWithoutExecution: true,
          exactAcpResume: true,
          promptExecutedOnce: true,
          nativeTranscript: true,
          nativeToolResult: true,
          workspaceMembership: true,
        },
        requests: requests.map(({ key, ...rest }) => rest),
      },
      null,
      2,
    ),
  )
} finally {
  server.closeAllConnections()
  server.close()
}
