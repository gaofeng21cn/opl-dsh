/** Whether the desktop renderer is running on Windows. */
export function isWindowsDesktop(): boolean {
  return /^Win/i.test(globalThis.navigator?.platform ?? '')
}
