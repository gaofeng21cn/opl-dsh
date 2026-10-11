/** Serializes reviewer settings publication against native and external task admission. */
export interface AutoReviewMaintenance {
  /**
   * Hold the shared runtime exclusion through validation and durable publication.
   * @param operation - Settings operation; it must recheck reviewer activity before writing.
   * @returns The operation's result; missing or busy owners must reject without publication.
   */
  change<T>(operation: () => Promise<T>): Promise<T>
}
