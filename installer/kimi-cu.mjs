export const KIMI_CU_PLUGIN_URL =
  'https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip'
export const KIMI_CU_INSTALL_COMMAND = `/plugins install ${KIMI_CU_PLUGIN_URL}`

export function kimiCuInstallInfo() {
  return {
    platform: 'win32',
    architecture: 'x64',
    command: KIMI_CU_INSTALL_COMMAND,
    verified: false,
    note: '仅显示官方安装命令；不会下载、解压或执行插件。',
  }
}
