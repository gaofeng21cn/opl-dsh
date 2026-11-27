/** CDP pipe client restricted to the Electron process spawned by qualification. */
import { writeFile, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

/** Expand the fixture workspace through its visible disclosure without toggling it closed. */
export function workspaceExpansionExpression(title) {
  return `(() => {const title=${JSON.stringify(title)};const row=Array.from(document.querySelectorAll('[role=treeitem][aria-expanded]')).find(node=>node.getClientRects().length && Array.from(node.querySelectorAll('span')).some(label=>label.textContent?.trim()===title));if(!row)return false;if(row.getAttribute('aria-expanded')==='true')return true;row.click();return false})()`
}

export class DesktopPipe {
  nextId = 0
  pending = new Map()
  events = []
  constructor(child) {
    this.input = child.stdio[3]
    this.input.on('error', (error) => {
      for (const call of this.pending.values()) {
        clearTimeout(call.timer)
        call.reject(error)
      }
      this.pending.clear()
    })
    let buffered = ''
    child.stdio[4].setEncoding('utf8')
    child.stdio[4].on('data', (chunk) => {
      buffered += chunk
      let boundary
      while ((boundary = buffered.indexOf('\0')) >= 0) {
        const bytes = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 1)
        if (!bytes) continue
        const message = JSON.parse(bytes)
        if (!message.id) {
          if (message.method === 'Runtime.exceptionThrown') this.events.push(message)
          if (
            message.method === 'Network.responseReceived' &&
            message.params.response.url.endsWith('/api/settings/mutate')
          )
            this.events.push(message)
          continue
        }
        const pending = this.pending.get(message.id)
        if (!pending) continue
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        message.error
          ? pending.reject(new Error(message.error.message))
          : pending.resolve(message.result)
      }
    })
    child.once('exit', () => {
      for (const call of this.pending.values()) {
        clearTimeout(call.timer)
        call.reject(new Error('隔离桌面 CDP 已关闭'))
      }
      this.pending.clear()
    })
  }
  command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('CDP 超时：' + method))
      }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      this.input.write(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0',
      )
    })
  }
  async evaluate(session, expression) {
    const value = await this.command(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      session,
    )
    if (value.exceptionDetails)
      throw new Error(
        'Client 执行失败：' +
          (value.exceptionDetails.exception?.description ?? value.exceptionDetails.text),
      )
    return value.result.value
  }
}

/** A fresh third-party install may present its own deferred introduction and announcement. */
export async function dismissQualificationNotices(pipe, session) {
  await pipe.evaluate(
    session,
    `(() => {for(const dialog of document.querySelectorAll('.ofm_ann,.ofm_scrim[data-ofm-urgent],[role=dialog]')){if(!dialog.matches('.ofm_ann,.ofm_scrim[data-ofm-urgent]')&&!/重要公告|Important announcement/.test(dialog.textContent))continue;const button=Array.from(dialog.querySelectorAll('button')).find(node=>node.getClientRects().length&&!node.disabled&&['稍后再说','Later','知道了','Got it'].includes(node.textContent?.trim()));button?.click()}})()`,
  )
}

/** Read the installed OPL card and its local detail document through the official plugin UI. */
export async function verifyPluginPresentation(pipe, screenshotPrefix) {
  const { targetInfos } = await pipe.command('Target.getTargets')
  const target = targetInfos.find(
    (item) =>
      item.type === 'page' &&
      (/^https?:\/\/127\.0\.0\.1(?::|\/)/.test(item.url) || item.url.startsWith('dsh-app://app/')),
  )
  if (!target) throw new Error('未发现插件展示验收的官方 Client 页面')
  const { sessionId } = await pipe.command('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  async function waitFor(expression, failure) {
    for (let attempt = 0; attempt < 80; attempt++) {
      await dismissQualificationNotices(pipe, sessionId)
      const value = await pipe.evaluate(sessionId, expression)
      if (value) return value
      await delay(250)
    }
    throw new Error(failure)
  }
  try {
    await waitFor(
      `(() => {const button=Array.from(document.querySelectorAll('button')).find(node=>node.getClientRects().length && ['插件','Plugins'].includes((node.getAttribute('aria-label')||node.textContent||'').trim()));if(!button)return false;button.click();return true})()`,
      '官方插件入口未显示',
    )
    const card = 'document.querySelector(\'[data-plugin-package="@one-person-lab/dsh-opl"]\')'
    const presentation = await waitFor(
      `(() => {const card=${card};if(!card)return false;const title=card.querySelector('button[aria-describedby]');const description=title && document.getElementById(title.getAttribute('aria-describedby'));const icon=card.querySelector('img');if(!title || !description || !icon?.complete || !icon.naturalWidth)return false;card.scrollIntoView({block:'center'});return {title:title.textContent.trim(),description:description.textContent.trim(),iconDecoded:true,metadataError:Boolean(card.querySelector('[data-package-meta-error]'))}})()`,
      'OPL 插件名称、说明或图标未完整加载',
    )
    if (
      !['OPL DSH 基础增强', 'OPL DSH Essentials'].includes(presentation.title) ||
      presentation.metadataError
    )
      throw new Error('官方插件列表未正确读取 OPL 品牌信息')
    const screenshots = []
    const screenshotFailures = []
    async function capture(name, clip) {
      await waitFor(
        `!Array.from(document.querySelectorAll('.ofm_ann,.ofm_scrim[data-ofm-urgent],[role=dialog]')).some(node=>node.getClientRects().length&&(node.matches('.ofm_ann,.ofm_scrim[data-ofm-urgent]')||/重要公告|Important announcement/.test(node.textContent)))`,
        '首次插件公告未关闭',
      )
      for (const params of [{ format: 'png' }, { format: 'png', fromSurface: false }]) {
        try {
          const screenshot = await pipe.command(
            'Page.captureScreenshot',
            { ...params, ...(clip ? { clip } : {}) },
            sessionId,
          )
          const file = screenshotPrefix + '-' + name + '.png'
          await writeFile(file, Buffer.from(screenshot.data, 'base64'))
          screenshots.push(file)
          return
        } catch {}
      }
      screenshotFailures.push(name)
    }
    const listClip = await pipe.evaluate(
      sessionId,
      `(() => {const bounds=${card}.closest('section').getBoundingClientRect();return {x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height,scale:1}})()`,
    )
    await capture('list', listClip)
    await pipe.evaluate(sessionId, `${card}.querySelector('button[aria-describedby]').click()`)
    await waitFor(
      `Boolean(document.querySelector('[data-plugin-detail="@one-person-lab/dsh-opl"]')?.textContent.includes('One Person Lab'))`,
      'OPL 插件离线详情文档未显示',
    )
    await capture('detail')
    return { ...presentation, detailDocument: true, screenshots, screenshotFailures }
  } finally {
    await pipe.command('Target.detachFromTarget', { sessionId })
  }
}

export async function verifyDesktopClient(
  pipe,
  screenshotPrefix,
  progress = () => {},
  credentialReadback = async () => {},
  officialVersion = undefined,
  conversationCountFixture = undefined,
  readExecutionCatalog = undefined,
  billionContextEnabled = false,
) {
  const result = {
    clientMounted: false,
    settingsSlots: [],
    runtimeExceptions: null,
    screenshots: [],
    screenshotFailures: [],
    settingsReopens: 0,
  }
  progress(result)
  await Promise.all(
    [
      'execution-settings',
      'catalog',
      'collaboration',
      'gateway',
      'gateway-models-footer',
      'failure',
    ].map((name) => rm(screenshotPrefix + '-' + name + '.png', { force: true })),
  )
  let session
  // The actual desktop content is a WebContentsView, separate from the native shell.
  for (let attempt = 0; attempt < 90 && !session; attempt++) {
    const { targetInfos } = await pipe.command('Target.getTargets')
    for (const target of targetInfos.filter(
      (target) =>
        target.type === 'page' &&
        (/^https?:\/\/127\.0\.0\.1(?::|\/)/.test(target.url) ||
          target.url.startsWith('dsh-app://app/')),
    )) {
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
    if (!session) await delay(500)
  }
  if (!session) throw new Error('未发现官方桌面 Client 页面')
  await pipe.command('Runtime.enable', {}, session)
  await pipe.command('Network.enable', {}, session)
  await pipe.command('Page.enable', {}, session)
  const errors = () =>
    pipe.events.filter(
      (event) => event.sessionId === session && event.method === 'Runtime.exceptionThrown',
    )
  // The DOM assertions are the qualification signal; screenshots are retained
  // evidence. The hosted Windows runner can stall Page.captureScreenshot (no
  // compositor frame is produced), so capture is best-effort: every miss is
  // recorded in the result instead of discarding an otherwise valid outcome, and
  // a diagnostic capture never replaces the failure that triggered it.
  async function captureScreenshot(name) {
    for (const params of [{ format: 'png' }, { format: 'png', fromSurface: false }]) {
      try {
        const screenshot = await pipe.command('Page.captureScreenshot', params, session)
        const file = screenshotPrefix + '-' + name + '.png'
        await writeFile(file, Buffer.from(screenshot.data, 'base64'))
        return file
      } catch {}
    }
    return null
  }
  async function captureFailureScreenshot() {
    await captureScreenshot('failure')
  }
  async function waitFor(expression, description, recover, maxAttempts = 80) {
    result.currentCheck = description
    progress(result)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Original plugin onboarding can arrive after the shell/setup is ready.
      // Dismiss its real deferred button whenever it appears, rather than
      // assuming a single early check has acknowledged the asynchronous gate.
      await dismissQualificationNotices(pipe, session)
      if (await pipe.evaluate(session, expression)) return
      if (recover) await recover()
      await delay(250)
    }
    const buttons = await pipe.evaluate(
      session,
      "Array.from(document.querySelectorAll('button,[role=menuitem]')).filter(x=>x.getClientRects().length).map(x=>x.getAttribute('aria-label')||x.textContent?.trim()).filter(Boolean)",
    )
    // Read copy from the isolated fixture only; innerText never reads the
    // password input value and retains failures below the modal's viewport.
    result.failureDialogText = await pipe.evaluate(
      session,
      "Array.from(document.querySelectorAll('[role=dialog]')).map(node=>node.innerText).join('\\n').slice(-8000)",
    )
    result.settingsWriteFailures = []
    for (const event of pipe.events
      .filter((event) => event.sessionId === session && event.method === 'Network.responseReceived')
      .slice(-6)) {
      try {
        const body = await pipe.command(
          'Network.getResponseBody',
          { requestId: event.params.requestId },
          session,
        )
        const response = JSON.parse(body.body).result
        const error = !response?.ok ? response?.error : undefined
        if (error) result.settingsWriteFailures.push({ code: error.code, message: error.message })
      } catch {
        // A released response body is unavailable; retain the original DOM failure.
      }
    }
    await captureFailureScreenshot()
    throw new Error(description + '；当前入口：' + JSON.stringify(buttons))
  }
  const clickLabel = (labels, scope = 'document') =>
    `(() => { const labels=${JSON.stringify(labels)}; const root=${scope}; if(!root)return false; const node=Array.from(root.querySelectorAll('button,[role=menuitem]')).find(x=>x.getClientRects().length && !x.disabled && (labels.includes((x.getAttribute('aria-label')||x.textContent||'').trim()) || x.matches('[role=menuitem]') && labels.some(label => (x.textContent||'').trim().startsWith(label)))); if(!node)return false; node.click(); return true })()`
  const featureSwitch = (labels) =>
    `Array.from(document.querySelectorAll('[role=switch]')).find(node=>node.getClientRects().length && ${JSON.stringify(labels)}.includes(node.getAttribute('aria-label')))`
  async function chooseCountMode(labels) {
    const selector = 'document.querySelector("[data-opl-preference=conversation-counts] button")'
    const accepted = `!${selector}.disabled && ${JSON.stringify(labels)}.some(label=>${selector}.textContent.includes(label))`
    const refused =
      'Boolean(document.querySelector("[data-opl-preference=conversation-counts] [role=alert]"))'
    async function choose() {
      await waitFor(`Boolean(${selector} && !${selector}.disabled)`, '轮次与步数设置未就绪')
      await pipe.evaluate(session, `${selector}.click()`)
      await waitFor(clickLabel(labels), '计数选项未显示')
      await waitFor(`(${accepted}) || (${refused} && !${selector}.disabled)`, '计数写入没有结束')
    }
    await choose()
    if (await pipe.evaluate(session, refused)) {
      // Startup fixtures can change the same namespace. The shared form recovers
      // its revision; exercise one new user choice only for a proven CAS refusal.
      const event = pipe.events
        .filter(
          (event) => event.sessionId === session && event.method === 'Network.responseReceived',
        )
        .at(-1)
      const body =
        event &&
        (await pipe.command(
          'Network.getResponseBody',
          { requestId: event.params.requestId },
          session,
        ))
      const code = body && JSON.parse(body.body).result?.error?.code
      if (code !== 'settings/conflict') throw new Error('计数偏好保存失败：' + String(code))
      result.countPreferenceConflicts = (result.countPreferenceConflicts ?? 0) + 1
      await choose()
    }
    await waitFor(accepted, '计数偏好未保存')
  }
  await waitFor("document.body.innerText.includes('OPL')", 'OPL Client 未挂载')
  result.clientMounted = true
  if (officialVersion === '0.2.1-rc.3') {
    result.settingsQualification = 'skipped-official-rc3-settings-menu'
    return result
  }
  // rc.2's preview dialog traps focus above the setup and account menus.
  await pipe.evaluate(
    session,
    clickLabel(
      ['继续', 'Continue'],
      "Array.from(document.querySelectorAll('[role=dialog]')).find(x=>/预览版说明|Preview release|Preview notice/i.test(x.innerText))",
    ),
  )
  await waitFor(
    "!Array.from(document.querySelectorAll('[role=dialog]')).some(x=>x.getClientRects().length && /预览版说明|Preview release|Preview notice/i.test(x.innerText))",
    '官方预览版说明尚未关闭',
  )
  // Fresh profile onboarding uses its real button and real setup RPC.
  await pipe.evaluate(
    session,
    clickLabel(['稍后再说', 'Later'], "document.querySelector('.ofm_ann')"),
  )
  await pipe.evaluate(session, clickLabel(['稍后登录', 'Sign in later']))
  await waitFor(
    "!Array.from(document.querySelectorAll('[data-opl-panel=setup]')).some(x=>x.getClientRects().length)",
    '首次设置尚未关闭',
  )
  const settingsNav = "document.querySelector('[role=dialog] nav')"
  async function activateSettings() {
    const accountOpened = await pipe.evaluate(
      session,
      `(() => {if(document.querySelector('[role=menu]')) return true;const labels=['账户菜单','Account menu','账户与设置','Account and settings'];const node=Array.from(document.querySelectorAll('button,[role=menuitem]')).find(x=>x.getClientRects().length&&!x.disabled&&labels.includes((x.getAttribute('aria-label')||x.textContent||'').trim()));if(node){node.click();return true}const textLabels=['未登录','Not signed in'];const textNode=Array.from(document.querySelectorAll('*')).find(x=>x.getClientRects().length&&textLabels.includes((x.textContent||'').trim())&&x.children.length===0);textNode?.click();return Boolean(textNode)})()`,
    )
    if (!accountOpened) throw new Error('账户入口未挂载')
    if (!(await pipe.evaluate(session, `Boolean(${settingsNav})`))) {
      await waitFor(clickLabel(['设置', 'Settings']), '设置菜单不可见')
    }
  }
  async function openSettings() {
    if (await pipe.evaluate(session, `Boolean(${settingsNav})`)) return
    await activateSettings()
    const openedAt = Date.now()
    await waitFor(`Boolean(${settingsNav})`, '官方设置容器未打开', async () => {
      // The observed first-run closure can happen before the first navigation check.
      if (result.settingsReopens || Date.now() - openedAt < 1000) return
      result.settingsReopens++
      await activateSettings()
    })
  }
  await openSettings()
  const panels = [
    { label: ['通用设置', 'General'], marker: 'notifications' },
    { label: ['OPL Gateway'], marker: 'gateway' },
    { label: ['执行引擎与协作', 'Engines & Collaboration'], marker: 'execution-settings' },
    { label: ['模型', 'Models'], marker: 'gateway-models-footer' },
  ]
  const screenshots = result.screenshots
  const expectedNavigation = [
    [
      '通用设置',
      '模型',
      'OPL Gateway',
      '内置插件',
      'Agent 预设',
      'Our Free Model',
      '执行引擎与协作',
      ...(billionContextEnabled ? ['bili设置'] : []),
    ],
    [
      'General',
      'Models',
      'OPL Gateway',
      'Built-in plugins',
      'Agent presets',
      'Our Free Model',
      'Engines & Collaboration',
      ...(billionContextEnabled ? ['bili'] : []),
    ],
  ]
  await waitFor(
    `(() => {const labels=Array.from(${settingsNav}.querySelectorAll('button')).map(x=>x.textContent.trim());return ${JSON.stringify(expectedNavigation)}.some(expected=>JSON.stringify(labels)===JSON.stringify(expected))})()`,
    '设置导航名称或顺序与统一目录不一致',
  )
  result.settingsNavigation = await pipe.evaluate(
    session,
    `Array.from(${settingsNav}.querySelectorAll('button')).map(x=>x.textContent.trim())`,
  )
  result.visibleNavigationIcons = await pipe.evaluate(
    session,
    `Array.from(${settingsNav}.querySelectorAll('button svg')).filter(x=>x.getClientRects().length).length`,
  )
  result.clippedNavigationLabels = await pipe.evaluate(
    session,
    `Array.from(${settingsNav}.querySelectorAll('button span')).filter(x=>x.getClientRects().length && x.scrollWidth>x.clientWidth+1).map(x=>x.textContent.trim()).filter(Boolean)`,
  )
  if (result.clippedNavigationLabels.length)
    throw new Error('设置导航标签被截断：' + result.clippedNavigationLabels.join('、'))
  async function recoverClosedSettings() {
    if (result.settingsReopens || (await pipe.evaluate(session, `Boolean(${settingsNav})`))) return
    result.settingsReopens++
    await openSettings()
  }
  for (const panel of panels) {
    const selectPanel = () =>
      waitFor(
        clickLabel(panel.label, settingsNav),
        panel.label[0] + ' 插槽未注册',
        recoverClosedSettings,
      )
    await selectPanel()
    await waitFor(
      `(() => {const node=document.querySelector('[data-opl-panel="${panel.marker}"]'); return Boolean(node && node.getClientRects().length && node.innerText.trim() && node.getAttribute('aria-busy') !== 'true' && !node.querySelector('[aria-busy="true"]'))})()`,
      panel.label[0] + ' 未加载',
      async () => {
        // First-run onboarding can close the settings dialog after navigation.
        // Recover that observed disappearance once; a present but broken panel
        // still fails its original DOM and error assertions.
        if (result.settingsReopens || (await pipe.evaluate(session, `Boolean(${settingsNav})`)))
          return
        result.settingsReopens++
        await openSettings()
        await selectPanel()
      },
      // The native page waits for the Windows OS credential probe, whose
      // first helper invocation has a 60-second budget on a fresh runner.
      (panel.marker === 'gateway' || panel.marker === 'gateway-models-footer') &&
        process.platform === 'win32'
        ? 520
        : 80,
    )
    const alerts = await pipe.evaluate(
      session,
      `Array.from(document.querySelectorAll('[data-opl-panel="${panel.marker}"] [role=alert]')).filter(x=>x.getClientRects().length).map(x=>x.textContent?.trim()).filter(Boolean)`,
    )
    if (alerts.length) {
      await captureFailureScreenshot()
      throw new Error(panel.label[0] + ' 报错：' + alerts.join('; '))
    }
    if (panel.marker === 'notifications') {
      const marker = 'notifications'
      await waitFor(
        `(() => {const row=document.querySelector('[data-opl-panel="${marker}"]'); return Boolean(row && row.getClientRects().length && row.querySelector('[role=switch]'))})()`,
        marker + ' 通用设置条目未挂载',
      )
      const toggle = `document.querySelector('[data-opl-panel="${marker}"] [role=switch]')`
      const before = await pipe.evaluate(session, `${toggle}.getAttribute('aria-checked')`)
      await pipe.evaluate(session, `${toggle}.click()`)
      await waitFor(
        `${toggle}.getAttribute('aria-checked')!==${JSON.stringify(before)}`,
        marker + ' 开关未更新',
      )
      await pipe.evaluate(session, `${toggle}.click()`)
      await waitFor(
        `${toggle}.getAttribute('aria-checked')===${JSON.stringify(before)}`,
        marker + ' 开关未恢复',
      )
      result.generalPreferences = {
        notifications: true,
        nativeGeneralItems: true,
      }
      const updateToggle = 'document.querySelector("[data-opl-panel=updates] [role=switch]")'
      await waitFor(
        `Boolean(${updateToggle} && !${updateToggle}.disabled)`,
        '更新设置未从真实 Host 加载',
      )
      const updateBefore = await pipe.evaluate(
        session,
        `${updateToggle}.getAttribute('aria-checked')`,
      )
      await pipe.evaluate(session, `${updateToggle}.click()`)
      await waitFor(
        `${updateToggle}.getAttribute('aria-checked')!==${JSON.stringify(updateBefore)} && !${updateToggle}.disabled`,
        '自动检查更新开关未保存',
      )
      await selectPanel()
      await waitFor(
        `${updateToggle}.getAttribute('aria-checked')!==${JSON.stringify(updateBefore)} && !${updateToggle}.disabled`,
        '重进设置后自动检查更新偏好丢失',
      )
      await pipe.evaluate(session, `${updateToggle}.click()`)
      await waitFor(
        `${updateToggle}.getAttribute('aria-checked')===${JSON.stringify(updateBefore)} && !${updateToggle}.disabled`,
        '自动检查更新开关未恢复',
      )
      result.generalPreferences.updates = {
        hostLoaded: true,
        automaticSaved: true,
        automaticRestored: true,
      }
      const rememberPermission = featureSwitch(['记住权限预设', 'Remember permission preset'])
      await waitFor(
        `Boolean(${rememberPermission} && !${rememberPermission}.disabled)`,
        '记住权限预设设置未就绪',
      )
      if (
        (await pipe.evaluate(session, `${rememberPermission}.getAttribute('aria-checked')`)) !==
        'false'
      )
        throw new Error('记住权限预设必须默认关闭')
      for (const labels of [
        ['增强待办状态', 'Enhanced todo status'],
        ['增强会话统计', 'Enhanced conversation statistics'],
      ]) {
        if (await pipe.evaluate(session, `Boolean(${featureSwitch(labels)})`))
          throw new Error('已退役的设置开关仍在显示：' + labels[0])
      }
      const countSelector =
        'document.querySelector("[data-opl-preference=conversation-counts] button")'
      await waitFor(
        `Boolean(${countSelector} && !${countSelector}.disabled)`,
        '轮次与步数设置未就绪',
      )
      await waitFor(
        `${countSelector}.textContent.includes('历史累计') || ${countSelector}.textContent.includes('All history')`,
        '默认值应沿用官方历史累计计数',
      )
      await chooseCountMode(['当前对话', 'Current conversation'])
      await selectPanel()
      await waitFor(
        `${countSelector}.textContent.includes('当前对话') || ${countSelector}.textContent.includes('Current conversation')`,
        '重进设置后计数偏好丢失',
      )
      if (!conversationCountFixture) await chooseCountMode(['历史累计', 'All history'])
      result.generalPreferences.conversationCounts = {
        historyDefault: true,
        currentSaved: true,
      }
    }
    if (panel.marker === 'gateway') {
      await waitFor(
        `Boolean(document.querySelector('[data-opl-panel="gateway"] form input[type="email"]'))`,
        'OPL Gateway 登录表单未挂载',
      )
      result.gatewayPanel = true
    }
    if (panel.marker === 'execution-settings') {
      await pipe.evaluate(
        session,
        `for (const d of document.querySelectorAll('[data-opl-panel="execution"] > details')) d.open = true`,
      )
      await waitFor(
        `Boolean(document.querySelector('[data-opl-panel="catalog"]')) && !document.querySelector('[data-opl-panel="catalog"]').getAttribute('aria-busy')?.includes('true') && Boolean(document.querySelector('[data-opl-panel="collaboration"]')) && !document.querySelector('[data-opl-panel="collaboration"]').getAttribute('aria-busy')?.includes('true')`,
        '默认规则或协作折叠区未就绪',
      )
      const collaborationShot = await captureScreenshot('collaboration')
      if (collaborationShot) screenshots.push(collaborationShot)
      else result.screenshotFailures.push('collaboration')
      result.settingsSlots.push('collaboration', 'catalog')
      if (
        await pipe.evaluate(
          session,
          `Boolean(document.querySelector('[data-opl-panel="catalog"] [data-opl-proxy-row]'))`,
        )
      )
        throw new Error('执行组合仍重复提供 Harness 代理配置')
      result.combinationsOnly = true
      result.modelAvailability = await pipe.evaluate(
        session,
        `Array.from(document.querySelectorAll('[data-opl-panel="catalog"] [data-opl-model-availability]')).map(node=>({kind:node.dataset.oplModelAvailability,label:node.textContent.trim(),reason:node.title}))`,
      )
      const availabilityLabels = {
        'catalog-missing': '目录已移除',
        disabled: '未启用',
        unconfirmed: '状态未确认',
        unavailable: '不可用',
      }
      if (
        !result.modelAvailability.length ||
        result.modelAvailability.some(
          (item) => item.label !== availabilityLabels[item.kind] || !item.reason,
        )
      )
        throw new Error('模型可用状态未使用统一分类或缺少悬停原因')
      await waitFor(
        `Boolean(document.querySelector('[data-opl-recommendation-item]'))`,
        '组合选择列表未加载',
      )
      const selectedCombination = await pipe.evaluate(
        session,
        `(() => {const panel=document.querySelector('[data-opl-panel="recommended-combinations"]'); panel.open=true; const input=Array.from(panel.querySelectorAll('[data-opl-recommendation-item]')).find(x=>x.checked && JSON.parse(x.dataset.oplRecommendationItem)[0]==='saved'); return input ? {key:input.dataset.oplRecommendationItem,id:JSON.parse(input.dataset.oplRecommendationItem)[1]} : null})()`,
      )
      if (!selectedCombination) throw new Error('隔离目录缺少可核验启停的已保存组合')
      const choice = `Array.from(document.querySelectorAll('[data-opl-recommendation-item]')).find(x=>x.dataset.oplRecommendationItem===${JSON.stringify(selectedCombination.key)})`
      const row = `Array.from(document.querySelectorAll('[data-opl-combination]')).find(x=>x.dataset.oplCombination===${JSON.stringify(selectedCombination.id)})`
      const saveChoices = `Array.from(document.querySelector('[data-opl-panel="recommended-combinations"]').querySelectorAll('button')).find(x=>x.textContent.startsWith('保存选择'))`
      if (
        await pipe.evaluate(
          session,
          `Boolean(${row}?.querySelector('[role="switch"][aria-label^="启用 "]'))`,
        )
      )
        throw new Error('已启用列表仍提供重复启停开关')
      const originalGroup = await pipe.evaluate(session, `${row}.parentElement.dataset.oplPanel`)
      await pipe.evaluate(session, `${choice}.click(); ${saveChoices}.click()`)
      await waitFor(
        `!(${row}) && Boolean(${choice}) && !${choice}.checked && !${saveChoices}.disabled`,
        '停用组合未从管理列表隐藏，或选择入口丢失',
      )
      await pipe.evaluate(session, `${choice}.click(); ${saveChoices}.click()`)
      await waitFor(
        `Boolean(${row}) && ${choice}.checked && !${saveChoices}.disabled`,
        '重新勾选未恢复原组合',
      )
      if ((await pipe.evaluate(session, `${row}.parentElement.dataset.oplPanel`)) !== originalGroup)
        throw new Error('修改组合启停后错误地改变官方/自定义分组')
      result.combinationSelection = {
        singleEnableSurface: true,
        disabledRowHidden: true,
        savedIdRestored: true,
      }
      const baselineChoices = await pipe.evaluate(
        session,
        `Array.from(document.querySelectorAll('[data-opl-recommendation-item]')).filter(x=>x.checked).map(x=>x.dataset.oplRecommendationItem)`,
      )
      const unavailableId = await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-combination] button[aria-label^="移除 "]')?.closest('[data-opl-combination]').dataset.oplCombination`,
      )
      if (!unavailableId) throw new Error('隔离目录缺少可移除的不可用组合')
      const unavailableRow = `Array.from(document.querySelectorAll('[data-opl-combination]')).find(x=>x.dataset.oplCombination===${JSON.stringify(unavailableId)})`
      await pipe.evaluate(
        session,
        `${unavailableRow}.querySelector('button[aria-label^="移除 "]').click()`,
      )
      await waitFor(
        `!(${unavailableRow}) && !${saveChoices}.disabled`,
        '不可用组合未从已启用列表移除',
      )
      await pipe.evaluate(
        session,
        `Array.from(document.querySelector('[data-opl-panel="recommended-combinations"]').querySelectorAll('button')).find(x=>x.textContent==='取消全选').click()`,
      )
      await waitFor(`${saveChoices}.textContent==='保存选择（0）'`, '取消全选的草稿未更新')
      await pipe.evaluate(session, `${saveChoices}.click()`)
      await waitFor(
        `!document.querySelector('[data-opl-combination]') && !${saveChoices}.disabled`,
        '取消全选后仍有已启用组合，包括隐藏的不可用项',
      )
      await pipe.evaluate(session, clickLabel(['通用设置', 'General'], settingsNav))
      await pipe.evaluate(
        session,
        clickLabel(['执行引擎与协作', 'Engines & Collaboration'], settingsNav),
      )
      await pipe.evaluate(
        session,
        `for (const d of document.querySelectorAll('[data-opl-panel="execution"] > details')) if (d.querySelector('[data-opl-panel="catalog"]')) d.open = true`,
      )
      await waitFor(
        `Boolean(document.querySelector('[data-opl-panel="catalog"]')) && !document.querySelector('[data-opl-panel="catalog"]').getAttribute('aria-busy')?.includes('true')`,
        '重开执行引擎与协作页未完成',
      )
      if (await pipe.evaluate(session, `Boolean(document.querySelector('[data-opl-combination]'))`))
        throw new Error('重开设置后已停用组合重新出现')
      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-panel="recommended-combinations"]').open=true; for(const input of document.querySelectorAll('[data-opl-recommendation-item]')) if(${JSON.stringify(baselineChoices)}.includes(input.dataset.oplRecommendationItem)&&!input.checked)input.click()`,
      )
      await waitFor(
        `${saveChoices}.textContent==='保存选择（${baselineChoices.length}）'`,
        '隔离验收未恢复原勾选草稿',
      )
      await pipe.evaluate(session, `${saveChoices}.click()`)
      await waitFor(`Boolean(${row}) && !${saveChoices}.disabled`, '隔离验收未恢复原可用组合')
      result.combinationSelection.unavailableRemoved = true
      result.combinationSelection.clearAllIncludesUnavailable = true
      result.combinationSelection.disabledAfterReopen = true
      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-panel="recommended-combinations"]').open=false; document.querySelector('[data-opl-panel="combination-list"]').scrollIntoView({block:'center'})`,
      )
      const compactRows = await pipe.evaluate(
        session,
        `Array.from(document.querySelectorAll('[data-opl-combination] > summary')).map(x=>({id:x.parentElement.dataset.oplCombination,height:x.getBoundingClientRect().height,text:x.textContent,clipped:x.scrollWidth>x.clientWidth,defaultChoice:x.parentElement.querySelector('[role=switch][aria-label="作为此模型的默认执行组合"]')?.getAttribute('aria-checked')??null}))`,
      )
      if (
        !compactRows.length ||
        compactRows.some((x) => x.height > 42 || x.text.includes('可执行') || x.clipped)
      )
        throw new Error('组合摘要未保持紧凑单行或仍重复显示可执行：' + JSON.stringify(compactRows))
      result.compactCombinationRows = compactRows
      const catalog = await readExecutionCatalog()
      for (const row of compactRows) {
        const item = catalog.combinations.find((candidate) => candidate.id === row.id)
        if (!item) throw new Error('组合摘要没有对应的目录记录：' + row.id)
        const alternatives = catalog.combinations.filter(
          (candidate) =>
            candidate.enabled &&
            candidate.modelRef.provider === item.modelRef.provider &&
            candidate.modelRef.model === item.modelRef.model,
        )
        if (row.defaultChoice !== (alternatives.length > 1 ? String(item.isDefault) : null))
          throw new Error('组合默认开关与已启用的备选数量或目录默认值不一致：' + row.id)
      }
      const selectionScreenshot = await captureScreenshot('combination-selection')
      if (selectionScreenshot) screenshots.push(selectionScreenshot)
      else result.screenshotFailures.push('combination-selection')
      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-panel="recommended-combinations"]').open=false`,
      )

      const catalogScreenshot = await captureScreenshot('catalog')
      if (catalogScreenshot) screenshots.push(catalogScreenshot)
      else result.screenshotFailures.push('catalog')
      await waitFor(
        `Boolean(document.querySelector('[data-opl-harness-row="codex"]')) && Boolean(document.querySelector('[data-opl-harness-group="more"]'))`,
        '执行引擎目录未挂载',
      )
      result.harnessDirectory = await pipe.evaluate(
        session,
        `(() => {
          const ids=['dsh','codex','claude','grok-build','antigravity','opencode'];
          const visible=ids.filter(id=>document.querySelector('[data-opl-harness-row="'+id+'"]')?.getClientRects().length);
          const group=document.querySelector('[data-opl-harness-group="more"]');
          const specialized=Array.from(group.querySelectorAll('[data-opl-harness-row]'));
          return {
            visible,
            groupOpen:group.open,
            groupText:group.querySelector(':scope > summary')?.textContent?.trim(),
            groupHeight:group.getBoundingClientRect().height,
            unreachableSpecialized:specialized.filter(row=>!row.closest('details:not([open])')).length,
          };
        })()`,
      )
      if (result.harnessDirectory.visible.length !== 6)
        throw new Error('常用执行引擎未按目录顺序直接显示')
      if (
        result.harnessDirectory.groupOpen ||
        result.harnessDirectory.groupHeight > 64 ||
        result.harnessDirectory.unreachableSpecialized
      )
        throw new Error('小众执行引擎默认展开或进入首屏')
      await waitFor(
        `(() => {const row=document.querySelector('[data-opl-proxy-row="minimax-code"]'); const builtin=document.querySelector('[data-opl-proxy-row="dsh"]'); return Boolean(row && row.querySelectorAll('input[type=radio]').length===3 && builtin && Array.from(builtin.querySelectorAll('input[type=radio]')).every(x=>x.disabled))})()`,
        'Harness 独立代理设置未注册',
      )
      result.expandedPathSpacing = await pipe.evaluate(
        session,
        `(() => {const row=document.querySelector('[data-opl-harness-row="codex"]');row.open=true;const detail=Array.from(row.querySelectorAll('details')).find(x=>x.querySelector(':scope > summary')?.textContent==='可执行文件路径');detail.open=true;const summary=detail.querySelector(':scope > summary');const input=detail.querySelector('input');const gap=input.getBoundingClientRect().top-summary.getBoundingClientRect().bottom;detail.open=false;row.open=false;return gap})()`,
      )
      if (result.expandedPathSpacing < 11 || result.expandedPathSpacing > 13)
        throw new Error('展开的路径输入框未保留12px间距')
      result.collapsedHarnessSpacing = await pipe.evaluate(
        session,
        `Array.from(document.querySelectorAll('[data-opl-harness-row] details:not([open]) > summary')).map(x=>({text:x.textContent,marginBottom:getComputedStyle(x).marginBottom}))`,
      )
      if (
        !result.collapsedHarnessSpacing.length ||
        result.collapsedHarnessSpacing.some((x) => parseFloat(x.marginBottom) !== 0)
      )
        throw new Error('收起的执行引擎折叠项仍有底部空行')
      const emptyGroups = await pipe.evaluate(
        session,
        `Array.from(document.querySelectorAll('[data-opl-panel="official-combinations"],[data-opl-panel="custom-combination-list"]')).filter(x=>!x.querySelector('[data-opl-combination]')).length`,
      )
      if (emptyGroups) throw new Error('空组合分组仍占用行距')
      await pipe.evaluate(
        session,
        `(() => {const group=document.querySelector('[data-opl-harness-group="more"]');group.open=true;const engine=document.querySelector('[data-opl-harness-row="minimax-code"]');engine.open=true;const row=document.querySelector('[data-opl-proxy-row="minimax-code"]'); row.open=true; row.querySelector('input[value="custom"]').click()})()`,
      )
      await waitFor(
        `Boolean(document.querySelector('[data-opl-proxy-url="minimax-code"]'))`,
        '指定代理未显示地址输入框',
      )
      await pipe.evaluate(
        session,
        `(() => {const input=document.querySelector('[data-opl-proxy-url="minimax-code"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'http://127.0.0.1:7897'); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('[data-opl-proxy-save="minimax-code"]').click()})()`,
      )
      await waitFor(
        `(() => {const status=document.querySelector('[data-opl-proxy-outcome="minimax-code"]'); return Boolean(status && status.getAttribute('role')==='status' && status.textContent.includes('已保存'))})()`,
        '真实代理保存未成功',
      )
      result.harnessProxySaved = true
      result.settingsSlots.push('execution-settings')
      await pipe.evaluate(
        session,
        `(() => {for(const row of document.querySelectorAll('[data-opl-harness-row]')) row.open=false; document.querySelector('[data-opl-harness-group="more"]').open=false; document.querySelector('[data-opl-panel="execution-settings"]').scrollIntoView({block:'start'})})()`,
      )
      const executionScreenshot = await captureScreenshot('execution-settings')
      if (executionScreenshot) screenshots.push(executionScreenshot)
      else result.screenshotFailures.push('execution-settings')
    }
    if (panel.marker === 'gateway-models-footer') {
      await waitFor(
        `(() => {const card=document.querySelector('[data-opl-panel="minimax-account"]'); return Boolean(card && card.getClientRects().length && card.getAttribute('aria-busy') !== 'true')})()`,
        'MiniMax 账号卡片未就绪',
      )
      await waitFor(
        `Boolean(document.querySelector('[data-opl-minimax-edit][aria-expanded="false"]'))`,
        'MiniMax 供应商编辑入口未显示',
      )
      await pipe.evaluate(session, `document.querySelector('[data-opl-minimax-edit]').click()`)
      await waitFor(
        `Boolean(document.querySelector('[data-opl-region-select]'))`,
        'MiniMax地区选择未挂载',
      )
      await pipe.evaluate(
        session,
        `(() => {const select=document.querySelector('[data-opl-region-select]');select.value='global';select.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      )
      await waitFor(
        `['在中国大陆使用国际版需要代理。','A proxy is required to use the Global service from mainland China.'].some(text=>document.querySelector('[data-opl-panel="minimax-account"]').textContent.includes(text))`,
        '国际版代理说明未显示',
      )
      result.minimaxGlobalNetworkHint = true
      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-panel="minimax-account"]').scrollIntoView({block:'center'})`,
      )
      const minimaxScreenshot = await captureScreenshot('minimax-global-hint')
      if (minimaxScreenshot) screenshots.push(minimaxScreenshot)
      await pipe.evaluate(
        session,
        `(() => {const select=document.querySelector('[data-opl-region-select]');select.value='cn';select.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      )
      await waitFor(
        `!['在中国大陆使用国际版需要代理。','A proxy is required to use the Global service from mainland China.'].some(text=>document.querySelector('[data-opl-panel="minimax-account"]').textContent.includes(text))`,
        '大陆版仍显示国际版提示',
      )

      await pipe.evaluate(
        session,
        `(() => {const select=document.querySelector('[data-opl-region-select]');select.value='global';select.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      )
      await waitFor(
        `Boolean(document.querySelector('[data-opl-panel="minimax-account"][data-opl-region="global"][data-opl-login-state="signed-in"]'))`,
        '切回国际版后未恢复已登录账号',
      )
      await pipe.evaluate(session, `document.querySelector('[data-opl-minimax-edit]').click()`)
    }
    const file = await captureScreenshot(panel.marker)
    if (file) screenshots.push(file)
    else result.screenshotFailures.push(panel.marker)
    result.settingsSlots.push(panel.marker)
  }
  await waitFor(clickLabel(['Our Free Model'], settingsNav), '原版模型插件设置入口未注册')
  await waitFor(
    "Boolean(document.querySelector('.ofm_root')?.getClientRects().length)",
    '原版模型插件设置页未加载',
  )
  result.settingsSlots.push('our-free-model')
  const modelPluginScreenshot = await captureScreenshot('our-free-model')
  if (modelPluginScreenshot) screenshots.push(modelPluginScreenshot)
  else result.screenshotFailures.push('our-free-model')
  if (conversationCountFixture) {
    async function closeSettings() {
      for (const type of ['keyDown', 'keyUp'])
        await pipe.command(
          'Input.dispatchKeyEvent',
          { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
          session,
        )
      await waitFor(`!${settingsNav}`, '轮次验收时设置未关闭')
    }
    const showsCounts = ({ turns, steps }) =>
      `Array.from(document.querySelectorAll('button,[role=button]')).some(node=>node.getClientRects().length && (${JSON.stringify(`${turns} 轮 ${steps} 步`)}===node.textContent.trim() || ${JSON.stringify(`${turns} turns ${steps} steps`)}===node.textContent.trim() || node.textContent.includes(${JSON.stringify(`${turns} 轮 ${steps} 步`)}) || node.textContent.includes(${JSON.stringify(`${turns} turns ${steps} steps`)})))`
    await closeSettings()
    await waitFor(workspaceExpansionExpression('test-project'), '计数验收工作区未展开')
    await waitFor(
      `(() => {const title='Conversation count qualification';const node=Array.from(document.querySelectorAll('*')).find(x=>x.getClientRects().length && x.textContent?.trim()===title && !Array.from(x.children).some(c=>c.textContent?.trim()===title));if(!node)return false;node.click();return true})()`,
      '计数验收对话未进入侧边栏',
    )
    await waitFor(showsCounts(conversationCountFixture.current), '原统计栏没有显示当前对话计数')
    async function selectCountScope(label) {
      await openSettings()
      await waitFor(clickLabel(['通用设置', 'General'], settingsNav), '通用设置未打开')
      await chooseCountMode(label)
      await closeSettings()
    }
    await selectCountScope(['历史累计', 'All history'])
    await waitFor(showsCounts(conversationCountFixture.history), '原统计栏没有显示历史累计计数')
    await selectCountScope(['当前对话', 'Current conversation'])
    await waitFor(showsCounts(conversationCountFixture.current), '原统计栏没有恢复当前对话计数')
    await selectCountScope(['历史累计', 'All history'])
    await waitFor(showsCounts(conversationCountFixture.history), '未恢复官方历史累计计数')
    result.conversationCounts = {
      editedNativeConversation: true,
      currentPill: conversationCountFixture.current,
      historyPill: conversationCountFixture.history,
      restoredCurrent: true,
      restoredOfficialHistory: true,
    }
  }
  result.runtimeExceptions = errors().length
  if (errors().length)
    throw new Error(
      '官方 Client 抛出运行异常：' +
        errors()
          .map((event) => event.params.exceptionDetails.text)
          .join('; '),
    )
  return result
}
