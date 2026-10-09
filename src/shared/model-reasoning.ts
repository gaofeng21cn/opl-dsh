/** Default effort for an OPL model choice; explicit Session selections are handled by the caller. */
export function modelDefaultEffort(
  model: string,
  reasoning: { defaultEffort?: string; efforts: readonly { id: string }[] } | undefined,
): string | undefined {
  return model.split('::').at(-1) === 'deepseek-flash' &&
    reasoning?.efforts.some((e) => e.id === 'max')
    ? 'max'
    : reasoning?.defaultEffort
}
