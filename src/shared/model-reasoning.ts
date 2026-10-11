/** Default effort for an OPL model choice; explicit Session selections are handled by the caller. */
export function modelDefaultEffort(
  model: string,
  reasoning: { defaultEffort?: string; efforts: readonly { id: string }[] } | undefined,
): string | undefined {
  const id = model.split('::').at(-1) ?? ''
  const preferred = id === 'deepseek-flash' ? 'high' : id.startsWith('gpt-') ? 'medium' : undefined
  return preferred && reasoning?.efforts.some((e) => e.id === preferred)
    ? preferred
    : reasoning?.defaultEffort
}
