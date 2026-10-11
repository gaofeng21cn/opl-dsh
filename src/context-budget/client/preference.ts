/** Local display preference shared by settings and composer entries. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

const key = 'opl.context-budget.enabled.v1'

/** Persist the display toggle in this Desktop's browser storage. */
export class BudgetPreference {
  readonly state = createSnapshotStore({ enabled: false, savingFailed: false })

  /** @param storage - Browser storage operations, resolved inside guarded calls. */
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'>) {
    try {
      this.state.set({ enabled: storage.getItem(key) === 'true', savingFailed: false })
    } catch (_error) {
      // Unavailable local storage leaves the display disabled for this window.
      this.state.set({ enabled: false, savingFailed: true })
    }
  }

  /** @param enabled - Whether this Client shows and reads context budgets. */
  setEnabled(enabled: boolean): void {
    let savingFailed = false
    try {
      this.storage.setItem(key, String(enabled))
    } catch (_error) {
      // The current window keeps the selection; settings reports that it was not saved.
      savingFailed = true
    }
    this.state.set({ enabled, savingFailed })
  }
}
