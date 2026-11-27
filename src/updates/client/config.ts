/** Browser dependencies supplied by the suite's generated RPC adapter. */
import type { ReactNode } from 'react'
import type { OplUpdateApi } from '../contracts.ts'

/** A missing connection generation disables writes and invalidates pending responses. */
export interface UpdateConnectionSource {
  getSnapshot(): number | undefined
  subscribe(listener: () => void): () => void
}

/** The Host owns discovery, preferences, downloads, and prepared updates. */
export interface Config {
  api: OplUpdateApi
  connection?: UpdateConnectionSource
  /** Observe Host status changes; the Client reads status without scheduling discovery. */
  subscribe?: (listener: () => void) => () => void
  /** Open the Updates or Engines settings section when supplied by its navigation owner. */
  openSettings?: (section?: 'updates' | 'engines') => void
  engineCount?: () => Promise<number>
  /** Render external execution-engine update controls inside the dedicated Updates page. */
  renderEngineUpdates?: () => ReactNode
  /** Register/clear the inline sidebar update indicator next to the settings launcher. */
  registerInlineNotice?: (render: ((wide: boolean) => ReactNode) | undefined) => void
}
