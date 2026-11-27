/** One OPL settings order; section ids keep official navigation and deep links intact. */
export const SETTINGS_ORDER = {
  general: 0,
  'opl-gateway': 10,
  models: 20,
  'opl-execution': 40,
  'agent-presets': 50,
  'opl-codex': 60,
  plugins: 70,
  'our-free-model': 1000,
  bili: 1010,
} as const

export const SETTINGS_NAVIGATION_NS = 'settings.oplNavigation'
export const settingsNavigationZh = {
  general: '通用设置',
  'opl-gateway': 'OPL Gateway',
  models: '模型供应商',
  'our-free-model': 'Our Free Model',
  bili: 'Billion Context',
  'opl-execution': '执行引擎与协作',
  'agent-presets': 'Agent 预设',
  'opl-codex': '协作与自动化',
  plugins: '插件管理',
} satisfies Record<keyof typeof SETTINGS_ORDER, string>
export const settingsNavigationEn: Record<keyof typeof SETTINGS_ORDER, string> = {
  general: 'General',
  'opl-gateway': 'OPL Gateway',
  models: 'Model providers',
  'our-free-model': 'Our Free Model',
  bili: 'Billion Context',
  'opl-execution': 'Engines & Team',
  'agent-presets': 'Agent presets',
  'opl-codex': 'Collaboration',
  plugins: 'Plugins',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.oplNavigation': keyof typeof SETTINGS_ORDER
  }
}
