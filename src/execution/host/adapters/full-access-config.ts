/** Map an already-authorized full-access session to OpenCode/Kilo's official permission setting. */
export function fullAccessCliConfig(content: string): string {
  // The adapter's route serializer owns this document; no user configuration is read or changed.
  const config = JSON.parse(content) as Record<string, unknown>
  return JSON.stringify({ ...config, permission: 'allow' })
}
