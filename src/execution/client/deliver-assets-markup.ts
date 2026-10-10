/**
 * Recognise the official `<deliver-assets>` delivery markup in untrusted
 * assistant text.
 *
 * The markup arrives as plain Markdown text: ACP replays an external harness
 * reply into one `assistant/message` text block, so the official renderer sees
 * the tags verbatim and no attachment is mapped. This module only decides what
 * is a real local-file delivery; it never touches the filesystem, never
 * resolves a path against a workspace, and never rewrites the surrounding
 * prose.
 *
 * Deliberately conservative. A block converts only when it is closed, sits
 * outside every code fence and code span, and holds nothing but supported
 * `<media type="file" .../>` entries that name an absolute local path.
 * Anything else — an unclosed tag, an `image`/`video` entry, a remote URL, a
 * dangerous scheme, a relative path, stray prose between entries — leaves the
 * whole block as untouched text so the original message stays copyable.
 */

/** One converted local file delivery. */
export interface DeliverAssetFile {
  /** Absolute path exactly as the model wrote it, entities already decoded. */
  readonly path: string
  /** `caption` (official spec), else `name`, else the path's last segment. */
  readonly name: string
}

/** Assistant text split into preserved prose and converted deliveries. */
export type DeliverAssetsSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'assets'; readonly files: readonly DeliverAssetFile[] }

const OPEN_BLOCK = /^<deliver[-_]assets\s*>/i
const CLOSE_BLOCK = /^<\/deliver[-_]assets\s*>/i
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
/** Reject control characters; a path carrying one is never a real delivery. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return true
  }
  return false
}
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * Decode XML escapes inside one attribute value only.
 *
 * A copied reply may escape the tag's own angle brackets or encode spaces as
 * `&#x20;`, so `src` can arrive with its spaces written as entities. Body
 * prose never passes through this, so an entity the model wrote in its answer
 * stays literal. One left-to-right pass means `&amp;lt;` decodes to `&lt;` and
 * never to `<`.
 * @param value - raw attribute value.
 * @returns the decoded value.
 */
function decodeEntities(value: string): string {
  return value.replace(/&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z]+);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Test whether a delivery target is an absolute local path.
 *
 * Remote URLs and dangerous schemes must never reach `openFile`, so this
 * accepts only a Windows drive path, a backslash UNC path, or a single-slash
 * POSIX path. `//host/share` is rejected because it is indistinguishable from
 * a protocol-relative URL.
 * @param value - decoded `src` attribute.
 * @returns whether the value can be handed to the official file opener.
 */
export function isLocalAbsolutePath(value: string): boolean {
  if (!value || hasControlCharacter(value)) return false
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (/^\\\\[^\\/]+\\[^\\/]+/.test(value)) return true
  return value.startsWith('/') && !value.startsWith('//')
}

/** Last path segment, tolerating both separators. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

/**
 * Identity of one delivered file within a message.
 *
 * Windows drive and UNC paths name a case-insensitive filesystem, so those
 * collapse; a POSIX path stays case-sensitive because `/tmp/A.md` and
 * `/tmp/a.md` really are two files there.
 * @param path - decoded absolute path.
 * @returns the key used to keep one card per real file.
 */
function pathKey(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/]+\\[^\\/]+/.test(path)
    ? path.replaceAll('\\', '/').toLowerCase()
    : path
}

/**
 * Parse every attribute of one self-closing tag.
 * @param source - text between `<media` and `/>`.
 * @returns decoded attribute values keyed by lower-cased name.
 */
function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const match of source.matchAll(
    /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
  )) {
    attributes.set(
      (match[1] ?? '').toLowerCase(),
      decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''),
    )
  }
  return attributes
}

/**
 * Convert one closed block's inner markup.
 *
 * Every character between the block tags must belong to a self-closing
 * `<media/>` entry or to whitespace; leftover prose or a paired `<media></media>`
 * fails the whole block rather than silently dropping an entry. An empty
 * result is a valid block whose entries were all already delivered.
 * @param inner - block content between the open and close tags.
 * @param seen - paths already delivered by this message, so a repeated entry
 * collapses to one card across sibling blocks and across replays.
 * @returns the newly delivered files, or null when the block must stay text.
 */
function parseBlock(inner: string, seen: Set<string>): DeliverAssetFile[] | null {
  const files: DeliverAssetFile[] = []
  const pending = new Set<string>()
  let cursor = 0
  for (const match of inner.matchAll(/<media\s+([^<>]*?)\/>/gi)) {
    if (inner.slice(cursor, match.index).trim()) return null
    const attributes = parseAttributes(match[1] ?? '')
    if (attributes.get('type')?.trim().toLowerCase() !== 'file') return null
    const path = attributes.get('src')?.trim()
    if (!path || !isLocalAbsolutePath(path)) return null
    // A retried or replayed step can repeat an entry; one card per real file.
    // The cursor advances either way, so a skipped duplicate never reads as
    // leftover prose and fails the whole block.
    const end = match.index + match[0].length
    const key = pathKey(path)
    if (seen.has(key) || pending.has(key)) {
      cursor = end
      continue
    }
    pending.add(key)
    const name = attributes.get('caption')?.trim() || attributes.get('name')?.trim()
    files.push({ path, name: name || baseName(path) })
    cursor = end
  }
  if (inner.slice(cursor).trim()) return null
  for (const key of pending) seen.add(key)
  return files
}

/** Normalize one escaped tag layer while retaining original text offsets. */
function normalizeTags(source: string): { text: string; offsets: number[] } {
  const offsets: number[] = []
  let text = ''
  let cursor = 0
  const tags =
    /(?<![\\&])(?:\\<(?:\/?deliver[-_]assets\s*|media\s+[^<>]*?\/)\\?>|&lt;(?:\/?deliver[-_]assets\s*|media\s+[^<>]*?\/)&gt;)/gi
  for (const match of source.matchAll(tags)) {
    const start = match.index
    while (cursor < start) {
      offsets.push(cursor)
      text += source[cursor++]
    }
    const encoded = match[0].startsWith('&lt;')
    const innerStart = start + (encoded ? 4 : 2)
    const innerEnd = start + match[0].length - (encoded ? 4 : match[0].endsWith('\\>') ? 2 : 1)
    offsets.push(start)
    text += '<'
    for (let index = innerStart; index < innerEnd; index++) {
      offsets.push(index)
      text += source[index]
    }
    offsets.push(innerEnd)
    text += '>'
    cursor = start + match[0].length
  }
  while (cursor < source.length) {
    offsets.push(cursor)
    text += source[cursor++]
  }
  offsets.push(source.length)
  return { text, offsets }
}

/** Locate the next backtick run of exactly `length` backticks. */
function findRun(text: string, from: number, length: number): number {
  let index = from
  while (index < text.length) {
    if (text[index] !== '`') {
      index++
      continue
    }
    let run = 0
    while (text[index + run] === '`') run++
    if (run === length) return index
    index += run
  }
  return -1
}

/**
 * Collect every code fence and code span, where markup must stay literal.
 * @param text - raw assistant text.
 * @returns ascending half-open regions covering all fenced and inline code.
 */
function codeRegions(text: string): [number, number][] {
  const regions: [number, number][] = []
  let line = 0
  while (line < text.length) {
    const newline = text.indexOf('\n', line)
    const lineEnd = newline === -1 ? text.length : newline
    const fence = FENCE_OPEN.exec(text.slice(line, lineEnd))
    if (!fence) {
      if (newline === -1) break
      line = newline + 1
      continue
    }
    const marker = fence[1]!
    const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`)
    let cursor = newline === -1 ? text.length : newline + 1
    let end = text.length
    while (cursor <= text.length) {
      const nextNewline = text.indexOf('\n', cursor)
      const stop = nextNewline === -1 ? text.length : nextNewline
      if (closing.test(text.slice(cursor, stop))) {
        end = stop
        break
      }
      if (nextNewline === -1) break
      cursor = nextNewline + 1
    }
    regions.push([line, end])
    if (end === text.length) break
    line = end + 1
  }

  // Inline spans may cross a line break and never start inside a fence.
  let cursor = 0
  let region = 0
  while (cursor < text.length) {
    while (region < regions.length && regions[region]![1] <= cursor) region++
    if (region < regions.length && regions[region]![0] <= cursor) {
      cursor = regions[region]![1]
      continue
    }
    if (text[cursor] !== '`') {
      cursor++
      continue
    }
    let run = 0
    while (text[cursor + run] === '`') run++
    const closing = findRun(text, cursor + run, run)
    if (closing === -1) {
      cursor += run
      continue
    }
    regions.push([cursor, closing + run])
    cursor = closing + run
  }
  return regions.sort((left, right) => left[0] - right[0])
}

/** One closed block found outside code, with its inner content bounds. */
interface BlockRange {
  readonly start: number
  readonly end: number
  readonly innerStart: number
  readonly innerEnd: number
}

/**
 * Find closed delivery blocks that no code region covers.
 *
 * An unfinished opener produces no card and cannot consume a later block.
 * @param text - raw assistant text.
 * @param regions - code regions from {@link codeRegions}.
 * @returns ascending block ranges.
 */
function closedBlocks(text: string, regions: [number, number][]): BlockRange[] {
  const blocks: BlockRange[] = []
  let index = 0
  let region = 0
  while (index < text.length) {
    while (region < regions.length && regions[region]![1] <= index) region++
    if (region < regions.length && regions[region]![0] <= index) {
      index = regions[region]![1]
      continue
    }
    if (text[index] !== '<' || text[index - 1] === '\\') {
      index++
      continue
    }
    const open = OPEN_BLOCK.exec(text.slice(index))
    if (!open) {
      index++
      continue
    }
    const innerStart = index + open[0].length
    let scan = innerStart
    let closer = -1
    let innerEnd = -1
    let abandoned = false
    let scanRegion = region
    while (scan < text.length) {
      while (scanRegion < regions.length && regions[scanRegion]![1] <= scan) scanRegion++
      if (scanRegion < regions.length && regions[scanRegion]![0] <= scan) {
        scan = regions[scanRegion]![1]
        continue
      }
      if (text[scan] === '<' && text[scan - 1] !== '\\') {
        const close = CLOSE_BLOCK.exec(text.slice(scan))
        if (close) {
          closer = scan
          innerEnd = scan
          break
        }
        // Another opener before any closer proves this one was never closed.
        // Abandon it and resume at the new opener, so an unfinished block
        // cannot swallow the valid block that follows it.
        if (OPEN_BLOCK.exec(text.slice(scan))) {
          index = scan
          abandoned = true
          break
        }
      }
      scan++
    }
    if (closer === -1) {
      // An abandoned opener resumes at the next one; only a block that really
      // runs off the end of the reply stops the scan.
      if (abandoned) continue
      break
    }
    blocks.push({
      start: index,
      end: closer + CLOSE_BLOCK.exec(text.slice(closer))![0].length,
      innerStart,
      innerEnd,
    })
    index = blocks[blocks.length - 1]!.end
  }
  return blocks
}

/**
 * Split assistant text into preserved prose and converted file deliveries.
 *
 * Safe to call on every render and on every replay: the result is a pure
 * function of the text, so a re-read of stored history yields the same cards
 * and a chunked stream yields none until its block is closed.
 * @param text - assistant text exactly as the session recorded it.
 * @returns ordered segments; a message with nothing to convert is one text segment.
 */
export function parseDeliverAssets(text: string): DeliverAssetsSegment[] {
  if (!/(?:<|&lt;)deliver[-_]assets/i.test(text)) return [{ kind: 'text', text }]
  const normalized = normalizeTags(text)
  const regions = codeRegions(normalized.text)
  const blocks = closedBlocks(normalized.text, regions)
  if (!blocks.length) return [{ kind: 'text', text }]

  const segments: DeliverAssetsSegment[] = []
  const seen = new Set<string>()
  let cursor = 0
  let files: DeliverAssetFile[] = []
  for (const block of blocks) {
    const converted = parseBlock(normalized.text.slice(block.innerStart, block.innerEnd), seen)
    // A malformed or unsupported block stays in the surrounding prose.
    if (converted === null) continue
    const start = normalized.offsets[block.start]!
    const end = normalized.offsets[block.end]!
    if (start > cursor) {
      if (files.length) segments.push({ kind: 'assets', files })
      files = []
      segments.push({ kind: 'text', text: text.slice(cursor, start) })
    }
    files.push(...converted)
    cursor = end
  }
  if (files.length) segments.push({ kind: 'assets', files })
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments.length ? segments : [{ kind: 'text', text }]
}

/**
 * Collect the converted deliveries of one assistant message.
 * @param text - assistant text exactly as the session recorded it.
 * @returns every local file delivery, in document order and deduplicated.
 */
export function deliverAssetFiles(text: string): DeliverAssetFile[] {
  const files: DeliverAssetFile[] = []
  for (const segment of parseDeliverAssets(text))
    if (segment.kind === 'assets') files.push(...segment.files)
  return files
}
