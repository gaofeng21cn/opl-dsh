/**
 * Minimal DOM for rendering the real OPL client components under Vitest.
 *
 * The workspace's pinned offline install has no jsdom/happy-dom, so React DOM
 * is given the small surface it actually touches: element/text/comment nodes
 * with the tree operations, attributes, styles and geometry reads React DOM
 * needs, plus the `window` globals its input-selection helpers probe. Anything
 * the shim does not model returns an empty value rather than throwing, so an
 * unsupported read cannot silently pass a test as if it were implemented.
 *
 * Importing this module installs the shim as the process `document`/`window`
 * and announces the React act environment. Do that before importing anything
 * that reads those globals — `react-dom` inspects them while its module body
 * runs — and then use {@link createTestDom} for a per-test document.
 */

type ShimNode = ShimElement | ShimText

const documents: ShimDocument[] = []

class ShimElement {
  readonly nodeType = 1
  readonly childNodes: ShimNode[] = []
  readonly attributes = new Map<string, string>()
  readonly style: Record<string, string> = {}
  readonly dataset: Record<string, string> = {}
  parentNode: ShimElement | null = null
  ownerDocument: ShimDocument | null = null
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml'
  nodeName: string
  prefix: string | null = null
  private text = ''

  constructor(name: string) {
    this.nodeName = name.toUpperCase()
  }
  get tagName(): string {
    return this.nodeName
  }
  get firstChild(): ShimNode | null {
    return this.childNodes[0] ?? null
  }
  get lastChild(): ShimNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }
  get nextSibling(): ShimNode | null {
    if (!this.parentNode) return null
    const index = this.parentNode.childNodes.indexOf(this)
    return this.parentNode.childNodes[index + 1] ?? null
  }
  get textContent(): string {
    return this.text + this.childNodes.map((child) => child.textContent).join('')
  }
  set textContent(value: string | null) {
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes.length = 0
    this.text = value ?? ''
  }
  appendChild<T extends ShimNode>(child: T): T {
    return this.insertBefore(child, null)
  }
  insertBefore<T extends ShimNode>(child: T, before: ShimNode | null): T {
    const previous = child.parentNode
    if (previous) previous.removeChild(child)
    const index = before ? this.childNodes.indexOf(before) : -1
    if (index < 0) this.childNodes.push(child)
    else this.childNodes.splice(index, 0, child)
    child.parentNode = this
    if (child instanceof ShimElement && !child.ownerDocument)
      child.ownerDocument = this.ownerDocument
    return child
  }
  removeChild<T extends ShimNode>(child: T): T {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }
  replaceChild(next: ShimNode, previous: ShimNode): ShimNode {
    this.insertBefore(next, previous)
    return this.removeChild(previous)
  }
  setAttribute(name: string, value: unknown): void {
    const text = String(value)
    this.attributes.set(name, text)
    if (name === 'class') this.style['class'] = text
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true
  }
  contains(node: unknown): boolean {
    let current = node as ShimNode | null
    while (current) {
      if (current === this) return true
      current = current.parentNode
    }
    return false
  }
  querySelector(): null {
    return null
  }
  querySelectorAll(): [] {
    return []
  }
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }
  }
  focus(): void {
    this.ownerDocument!.activeElement = this
  }
  blur(): void {
    this.ownerDocument!.activeElement = null
  }
  scrollIntoView(): void {}
}

class ShimText {
  readonly nodeType: number
  parentNode: ShimElement | null = null
  ownerDocument: ShimDocument | null = null
  data: string

  constructor(data: string, nodeType = 3) {
    this.data = data
    this.nodeType = nodeType
  }
  get textContent(): string {
    return this.data
  }
  get nodeValue(): string {
    return this.data
  }
  set nodeValue(value: string | null) {
    this.data = value ?? ''
  }
  set textContent(value: string | null) {
    this.data = value ?? ''
  }
}

class ShimDocument {
  readonly nodeType = 9
  readonly documentElement = new ShimElement('html')
  readonly head = new ShimElement('head')
  readonly body = new ShimElement('body')
  activeElement: ShimElement | null = null
  ownerDocument: null = null

  constructor() {
    for (const node of [this.documentElement, this.head, this.body]) node.ownerDocument = this
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
  }
  createElement(name: string): ShimElement {
    const node = new ShimElement(name)
    node.ownerDocument = this
    return node
  }
  createElementNS(_namespace: string, name: string): ShimElement {
    return this.createElement(name)
  }
  createTextNode(data: string): ShimText {
    const node = new ShimText(data)
    node.ownerDocument = this
    return node
  }
  createComment(data: string): ShimText {
    const node = new ShimText(data, 8)
    node.ownerDocument = this
    return node
  }
  createDocumentFragment(): ShimElement {
    return this.createElement('#document-fragment')
  }
  createEvent(type: string): { type: string; initEvent: (next: string) => void } {
    return { type, initEvent: (next: string) => void next }
  }
  querySelector(): null {
    return null
  }
  querySelectorAll(): [] {
    return []
  }
  getElementById(): null {
    return null
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

class ShimWindow {
  readonly document: ShimDocument
  readonly HTMLIFrameElement = class ShimHTMLIFrameElement {}
  constructor(document: ShimDocument) {
    this.document = document
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true
  }
  getSelection() {
    return { rangeCount: 0 }
  }
}

/** Build one detached document for a test case. */
export function createTestDom() {
  const document = new ShimDocument()
  documents.push(document)
  return {
    document,
    window: new ShimWindow(document),
    /** Attach a fresh render container to the shimmed body. */
    container(): ShimElement {
      const node = document.createElement('div')
      document.body.appendChild(node)
      return node
    },
    /** Text content of a node or of the live document body. */
    textOf(node: unknown = document.body): string {
      return (node as ShimNode | null)?.textContent ?? ''
    },
  }
}

/**
 * Install the shim as the process's `document`/`window`.
 * @returns the installed document pair.
 */
export function installTestDom() {
  const dom = createTestDom()
  Object.assign(globalThis, { document: dom.document, window: dom.window })
  return dom
}

installTestDom()
// React's act() refuses to flush effects unless the environment announces it.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
