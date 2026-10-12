/** One OPL settings order; section ids keep official navigation and deep links intact. */
export const SETTINGS_ORDER = {
  general: 0,
  'opl-gateway': 10,
  models: 20,
  'our-free-model': 30,
  'opl-harness-settings': 40,
  'opl-execution': 50,
  'agent-presets': 60,
  'opl-codex': 70,
  'opl-auto-review': 80,
  plugins: 90,
} as const

export const SETTINGS_NAVIGATION_NS = 'settings.oplNavigation'
export const settingsNavigationZh = {
  general: '通用设置',
  'opl-gateway': '网关账户',
  models: '模型供应商',
  'our-free-model': 'OFM 模型服务',
  'opl-harness-settings': '执行引擎',
  'opl-execution': '执行组合',
  'agent-presets': 'Agent 预设',
  'opl-codex': '协作与自动化',
  'opl-auto-review': '工具审批',
  plugins: '插件管理',
} satisfies Record<keyof typeof SETTINGS_ORDER, string>
export const settingsNavigationEn: Record<keyof typeof SETTINGS_ORDER, string> = {
  general: 'General',
  'opl-gateway': 'Gateway',
  models: 'Model providers',
  'our-free-model': 'OFM services',
  'opl-harness-settings': 'Harnesses',
  'opl-execution': 'Combinations',
  'agent-presets': 'Agent presets',
  'opl-codex': 'Collaboration',
  'opl-auto-review': 'Tool approval',
  plugins: 'Plugins',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.oplNavigation': keyof typeof SETTINGS_ORDER
  }
}
