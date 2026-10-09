/** Inspect the real official conversation after an isolated ACP fixture turn. */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertIsolatedRoot, safeBinding } from './qualification-support.mjs'
import { setTimeout as delay } from 'node:timers/promises'

export async function verifyHarnessTranscriptClient(pipe, screenshotFile) {
  const { targetInfos } = await pipe.command('Target.getTargets')
  let session
  for (const target of targetInfos.filter((target) => target.type === 'page')) {
    const attached = await pipe.command('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })
    if (
      await pipe.evaluate(
        attached.sessionId,
        'Boolean(document.body && globalThis.__ModuleLoader__)',
      )
    ) {
      session = attached.sessionId
      break
    }
    await pipe.command('Target.detachFromTarget', { sessionId: attached.sessionId })
  }
  if (!session) throw Error('Transcript Client not found')
  await pipe.command('Runtime.enable', {}, session)
  const firstEvent = pipe.events.length
  for (const type of ['keyDown', 'keyUp'])
    await pipe.command(
      'Input.dispatchKeyEvent',
      { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      session,
    )
  async function until(expression, description) {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await pipe.evaluate(session, expression)) return
      await delay(250)
    }
    const state = await pipe.evaluate(
      session,
      `({text:document.body.innerText.slice(-5000),disclosures:Array.from(document.querySelectorAll('[aria-expanded]')).map(x=>({text:x.textContent?.slice(0,180),label:x.getAttribute('aria-label'),expanded:x.getAttribute('aria-expanded')}))})`,
    )
    try {
      const value = await pipe.command('Page.captureScreenshot', { format: 'png' }, session)
      await writeFile(
        screenshotFile.replace('.png', '-failure.png'),
        Buffer.from(value.data, 'base64'),
      )
    } catch {
      /* Keep the failed DOM assertion even when capture is unavailable. */
    }
    throw Error(description + ': ' + JSON.stringify(state))
  }
  await until(
    `(() => {const node=Array.from(document.querySelectorAll('*')).find(x=>x.getClientRects().length && x.textContent?.trim()==='MiniMax transcript title' && !Array.from(x.children).some(c=>c.textContent?.trim()==='MiniMax transcript title'));if(!node)return false;node.click();return true})()`,
    'CLI title missing from official sidebar',
  )
  await until(
    `document.body.innerText.includes('TRANSCRIPT_DONE') && Boolean(document.querySelector('[data-opl-harness-tool]'))`,
    'External transcript Tool slot not rendered',
  )
  await until(
    `(() => {for(const node of document.querySelectorAll('[aria-expanded=false]')){const label=node.textContent?.trim() || node.getAttribute('aria-label') || '';if(node.getClientRects().length && (node.matches('[data-disclosure-row], [data-variant=think] button, [data-opl-harness-tool] [aria-expanded]') || /^(已完成，用时|已调用工具|思考)/.test(label)))node.click()}return document.body.innerText.includes('TRANSCRIPT_OK') && document.body.innerText.includes('Inspecting the repository.')})()`,
    'Reasoning or terminal output not visible',
  )
  const exceptions = pipe.events
    .slice(firstEvent)
    .filter((event) => event.sessionId === session && event.method === 'Runtime.exceptionThrown')
  if (exceptions.length) throw Error('Transcript Client runtime exception')
  let screenshot = null
  try {
    const value = await pipe.command('Page.captureScreenshot', { format: 'png' }, session)
    await writeFile(screenshotFile, Buffer.from(value.data, 'base64'))
    screenshot = screenshotFile
  } catch {
    /* DOM assertions remain authoritative if the host compositor cannot capture. */
  }
  return {
    sidebarTitle: true,
    reasoningVisible: true,
    toolSlot: true,
    terminalOutput: true,
    runtimeExceptions: 0,
    screenshot,
  }
}

/** Keep a fixture turn open across a completed tool and a full Client reload. */
export async function verifyHarnessLiveTranscriptClient(pipe, root, screenshotFile) {
  await assertIsolatedRoot(root)
  const binding = safeBinding(
    JSON.parse(await readFile(join(root, 'profiles/desktop/control.json'), 'utf8')),
  )
  async function rpc(method, args) {
    const response = await fetch(binding.endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'harness', method, args }),
      signal: AbortSignal.timeout(30000),
    })
    const result = await response.json()
    if (!result.ok) throw Error(result.error)
    return result.value
  }
  // Reuse the already-expanded qualification project so the sidebar selection
  // does not depend on a newly-created group's collapsed state.
  const cwd = join(root, 'test-project')
  await mkdir(cwd, { recursive: true })
  const identity = crypto.randomUUID()
  const releaseFile = 'finish-live-transcript-' + identity
  const started = await rpc('start', {
    combination: 'minimax-code/MiniMax-M3',
    cwd,
    taskId: 'qualification-live-transcript-' + identity,
    origin: { kind: 'codex', sessionId: 'isolated-live-acceptance' },
    sandbox: 'full-access',
  })
  await rpc('prompt', {
    sessionId: started.id,
    operationId: 'live',
    text: 'TRANSCRIPT_FIXTURE_LIVE RELEASE_FILE=' + releaseFile + ' TITLE_ID=' + identity,
  })
  const { targetInfos } = await pipe.command('Target.getTargets')
  let session
  for (const target of targetInfos.filter((target) => target.type === 'page')) {
    const attached = await pipe.command('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })
    if (
      await pipe.evaluate(
        attached.sessionId,
        'Boolean(document.body && globalThis.__ModuleLoader__)',
      )
    ) {
      session = attached.sessionId
      break
    }
    await pipe.command('Target.detachFromTarget', { sessionId: attached.sessionId })
  }
  if (!session) throw Error('Live transcript Client not found')
  await pipe.command('Page.bringToFront', {}, session)
  async function until(expression, description) {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await pipe.evaluate(session, expression)) return
      await delay(250)
    }
    const snapshot = await rpc('snapshot', { sessionId: started.id })
    throw Error(
      description +
        ': ' +
        JSON.stringify({
          state: snapshot.state,
          turns: snapshot.turns.map((turn) => ({
            state: turn.state,
            error: turn.error,
            tools: turn.tools.length,
          })),
          body: await pipe.evaluate(session, 'document.body.innerText.slice(-3000)'),
        }),
    )
  }
  const selectedTitle = JSON.stringify('MiniMax live transcript ' + identity)
  const select = `(() => {const title=${selectedTitle};const node=Array.from(document.querySelectorAll('*')).find(x=>x.getClientRects().length && x.textContent?.trim()===title && !Array.from(x.children).some(c=>c.textContent?.trim()===title));if(!node)return false;node.click();return true})()`
  const visible = `Boolean(Array.from(document.querySelectorAll('[data-opl-live-transcript]')).find(x=>x.getClientRects().length && x.textContent.includes('Continuing live thought.') && x.textContent.includes('Starting check.'))) && Boolean(document.querySelector('[data-opl-harness-tool]')) && !document.body.innerText.includes('TRANSCRIPT_DONE')`
  try {
    await until(select, 'Live title missing')
    await until(visible, 'Thoughts hidden while tool is complete and the turn is still running')
    await writeFile(
      screenshotFile + '.layout.json',
      JSON.stringify(
        await pipe.evaluate(
          session,
          `({visibility:document.visibilityState,frameClock:requestAnimationFrame.toString(),live:Array.from(document.querySelectorAll('[data-opl-live-transcript]')).map(x=>({rect:x.getBoundingClientRect().toJSON(),text:x.textContent,style:getComputedStyle(x).visibility})),viewport:{width:innerWidth,height:innerHeight}})`,
        ),
        null,
        2,
      ) + '\n',
    )
    // DOM commits can precede compositor frames. Capture the actual painted
    // conversation, and reject rows outside the visible conversation viewport.
    await pipe.evaluate(
      session,
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    )
    await until(
      `(() => {const x=document.querySelector('[data-opl-live-transcript]');if(!x)return false;x.scrollIntoView({block:'center'});const r=x.getBoundingClientRect();let top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom),left=Math.max(0,r.left),right=Math.min(innerWidth,r.right);for(let p=x;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;const a=p.getBoundingClientRect();if(/hidden|clip|auto|scroll/.test(s.overflowY)){top=Math.max(top,a.top);bottom=Math.min(bottom,a.bottom)}if(/hidden|clip|auto|scroll/.test(s.overflowX)){left=Math.max(left,a.left);right=Math.min(right,a.right)}}return right>left&&bottom>top})()`,
      'Live thought is outside the visible viewport',
    )
    await pipe.evaluate(
      session,
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    )
    if ((await rpc('snapshot', { sessionId: started.id })).state !== 'running')
      throw Error('Live probe ended early')
    const screenshot = await pipe.command('Page.captureScreenshot', { format: 'png' }, session)
    await writeFile(screenshotFile, Buffer.from(screenshot.data, 'base64'))
    await pipe.command('Page.reload', {}, session)
    await until(select, 'Live title missing after Client reload')
    await until(visible, 'Live reasoning missing after snapshot/reconnect')
    if ((await rpc('snapshot', { sessionId: started.id })).state !== 'running')
      throw Error('Reconnect probe ended early')
  } finally {
    // Release the owned fixture even when a DOM assertion fails.
    await writeFile(join(cwd, releaseFile), 'finish\n')
    await rpc('wait', { sessionId: started.id })
  }
  await until(
    `document.body.innerText.includes('TRANSCRIPT_DONE') && !Array.from(document.querySelectorAll('[data-opl-live-transcript]')).some(x=>x.getClientRects().length)`,
    'Live fallback remained after completion',
  )
  return {
    toolThenLiveThought: true,
    turnStillRunning: true,
    reconnect: true,
    hiddenAfterCompletion: true,
    screenshot: screenshotFile,
  }
}
