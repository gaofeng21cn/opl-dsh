/** CDP pipe client restricted to the Electron process spawned by qualification. */
import { writeFile, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

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
    if (value.exceptionDetails) throw new Error('Client 执行失败：' + value.exceptionDetails.text)
    return value.result.value
  }
}

export async function verifyDesktopClient(pipe, screenshotPrefix, progress = () => {}) {
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
    ['execution-settings', 'catalog', 'collaboration', 'gateway-models', 'failure'].map((name) =>
      rm(screenshotPrefix + '-' + name + '.png', { force: true }),
    ),
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
  async function waitFor(expression, description, recover) {
    for (let attempt = 0; attempt < 80; attempt++) {
      // Original plugin onboarding can arrive after the shell/setup is ready.
      // Dismiss its real deferred button whenever it appears, rather than
      // assuming a single early check has acknowledged the asynchronous gate.
      await pipe.evaluate(
        session,
        `(() => {const dialog=document.querySelector('.ofm_ann');const node=dialog && Array.from(dialog.querySelectorAll('button')).find(x=>x.getClientRects().length && ['稍后再说','Later'].includes(x.textContent?.trim()));node?.click()})()`,
      )
      if (await pipe.evaluate(session, expression)) return
      if (recover) await recover()
      await delay(250)
    }
    const buttons = await pipe.evaluate(
      session,
      "Array.from(document.querySelectorAll('button,[role=menuitem]')).filter(x=>x.getClientRects().length).map(x=>x.getAttribute('aria-label')||x.textContent?.trim()).filter(Boolean)",
    )
    await captureFailureScreenshot()
    throw new Error(description + '；当前入口：' + JSON.stringify(buttons))
  }
  const clickLabel = (labels, scope = 'document') =>
    `(() => { const labels=${JSON.stringify(labels)}; const root=${scope}; if(!root)return false; const node=Array.from(root.querySelectorAll('button,[role=menuitem]')).find(x=>x.getClientRects().length && !x.disabled && (labels.includes((x.getAttribute('aria-label')||x.textContent||'').trim()) || x.matches('[role=menuitem]') && labels.some(label => (x.textContent||'').trim().startsWith(label)))); if(!node)return false; node.click(); return true })()`
  await waitFor("document.body.innerText.includes('OPL')", 'OPL Client 未挂载')
  result.clientMounted = true
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
  async function openSettings() {
    if (await pipe.evaluate(session, `Boolean(${settingsNav})`)) return
    await waitFor(
      clickLabel([
        '账户菜单',
        'Account menu',
        '账户与设置',
        'Account and settings',
        '更多',
        'More',
        '设置',
        'Settings',
      ]),
      '账户或设置入口未挂载',
    )
    if (!(await pipe.evaluate(session, `Boolean(${settingsNav})`)))
      await waitFor(clickLabel(['设置', 'Settings']), '设置菜单不可见')
    await waitFor(`Boolean(${settingsNav})`, '官方设置容器未打开')
  }
  await openSettings()
  const panels = [
    { label: ['执行引擎', 'Harnesses'], marker: 'execution-settings' },
    { label: ['执行组合', 'Combinations'], marker: 'catalog' },
    { label: ['协作与自动化', 'Collaboration'], marker: 'collaboration' },
    { label: ['模型供应商', 'Model providers'], marker: 'gateway-models' },
  ]
  const screenshots = result.screenshots
  const expectedNavigation = [
    [
      '通用设置',
      '网关账户',
      '模型供应商',
      'OFM 模型服务',
      '执行引擎',
      '执行组合',
      'Agent 预设',
      '协作与自动化',
      '工具审批',
      '上下文预算',
      '系统通知',
      '插件管理',
    ],
    [
      'General',
      'Gateway account',
      'Model providers',
      'OFM services',
      'Harnesses',
      'Combinations',
      'Agent presets',
      'Collaboration',
      'Tool approval',
      'Context budget',
      'Notifications',
      'Plugins',
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
    )
    const alerts = await pipe.evaluate(
      session,
      `Array.from(document.querySelectorAll('[data-opl-panel="${panel.marker}"] [role=alert]')).filter(x=>x.getClientRects().length).map(x=>x.textContent?.trim()).filter(Boolean)`,
    )
    if (alerts.length) {
      await captureFailureScreenshot()
      throw new Error(panel.label[0] + ' 报错：' + alerts.join('; '))
    }
    if (panel.marker === 'catalog') {
      await waitFor(
        `(() => {const row=document.querySelector('[data-opl-proxy-row="minimax-code"]'); const builtin=document.querySelector('[data-opl-proxy-row="dsh"]'); return Boolean(row && row.querySelectorAll('input[type=radio]').length===3 && builtin && Array.from(builtin.querySelectorAll('input[type=radio]')).every(x=>x.disabled))})()`,
        'Harness 独立代理设置未注册',
      )
      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-proxy-row="minimax-code"] input[value="custom"]').click()`,
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
    }
    if (panel.marker === 'gateway-models') {
      await waitFor(
        `(() => {const node=document.querySelector('[data-opl-provider="huawei-maas"]');return Boolean(node && node.getClientRects().length && node.getAttribute('aria-busy')==='false' && node.innerText.includes('GLM-5.2'))})()`,
        '华为云模型来源未挂载到供应商页',
      )
      await pipe.evaluate(
        session,
        `(() => {const node=document.querySelector('[data-opl-provider="huawei-maas"]');node.querySelector('summary').click();node.scrollIntoView({block:'center'})})()`,
      )
      result.huaweiProvider = await pipe.evaluate(
        session,
        `(() => {const node=document.querySelector('[data-opl-provider="huawei-maas"]');const input=node.querySelector('input');return {count:document.querySelectorAll('[data-opl-provider="huawei-maas"]').length,expanded:node.querySelector('details').open,keyInputType:input.type,keyInputEmpty:input.value==='',keyInputDisabled:input.disabled,hasEndpoint:node.innerText.includes('https://api.modelarts-maas.com/openai/v1'),independentPage:document.querySelector('[data-opl-panel="huawei-maas"]')!==null}})()`,
      )
      const source = result.huaweiProvider
      if (
        source.count !== 1 ||
        !source.expanded ||
        source.keyInputType !== 'password' ||
        !source.keyInputEmpty ||
        !source.hasEndpoint ||
        source.independentPage ||
        (process.platform !== 'win32' && !source.keyInputDisabled)
      )
        throw new Error('华为云供应商卡片的配置或凭据状态错误')
      const providerScreenshot = await captureScreenshot('huawei-provider')
      if (providerScreenshot) screenshots.push(providerScreenshot)
      else result.screenshotFailures.push('huawei-provider')
    }
    const file = await captureScreenshot(panel.marker)
    if (file) screenshots.push(file)
    else result.screenshotFailures.push(panel.marker)
    result.settingsSlots.push(panel.marker)
  }
  await waitFor(
    clickLabel(['OFM 模型服务', 'OFM services'], settingsNav),
    '原版模型插件设置入口未注册',
  )
  await waitFor(
    "Boolean(document.querySelector('.ofm_root')?.getClientRects().length)",
    '原版模型插件设置页未加载',
  )
  result.settingsSlots.push('our-free-model')
  const modelPluginScreenshot = await captureScreenshot('our-free-model')
  if (modelPluginScreenshot) screenshots.push(modelPluginScreenshot)
  else result.screenshotFailures.push('our-free-model')
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
