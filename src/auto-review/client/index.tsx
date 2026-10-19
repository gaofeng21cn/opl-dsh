/**
 * Locale contribution for Auto Review.
 *
 * The execution settings page is the single user-facing owner. It composes the
 * existing Auto Review section and supplies its read/save seam, so this module
 * owns copy and controls without adding another navigation entry.
 */
import type { Context } from '@deepseek-ai/cordis'
import { AUTO_REVIEW_NAMESPACE, en, zh } from './locales.ts'

export type { AutoReviewReadState, AutoReviewView } from './controller.ts'
export type { AutoReviewSectionProps } from './AutoReviewSection.tsx'

/** Register only the copy consumed by the execution settings page. */
export const inject = ['locale']

/**
 * Register Auto Review copy.
 * @param ctx - official Client root.
 * @returns nothing.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(AUTO_REVIEW_NAMESPACE, { zh, en }))
}
