export function discoverWindowsKimiCu(
  suiteRoot?: string,
  env?: NodeJS.ProcessEnv,
): {
  plugin: string
  executable: string
  native: string
  version: string
  external: boolean
} | null
