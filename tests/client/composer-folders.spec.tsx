import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = ts.createSourceFile(
  'ExecutionCatalogSection.tsx',
  readFileSync(
    new URL('../../src/execution/client/ExecutionCatalogSection.tsx', import.meta.url),
    'utf8',
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
)

function detailsPanels() {
  const panels: Array<{ panel: string; hasOpen: boolean; text: string }> = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'details') {
      const panel = node.openingElement.attributes.properties.find(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) && property.name.text === 'data-opl-panel',
      )
      const value = panel?.initializer
      const panelName = value && ts.isStringLiteral(value) ? value.text : undefined
      if (panelName) {
        panels.push({
          panel: panelName,
          hasOpen: node.openingElement.attributes.properties.some(
            (property) => ts.isJsxAttribute(property) && property.name.text === 'open',
          ),
          text: node.getText(source),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return panels
}

describe('执行组合分区', () => {
  it('按 generated 状态把官方和自定义组合分别渲染到对应分组', () => {
    const text = source.getText()
    expect(text).toContain('data-opl-panel="official-combinations"')
    expect(text).toContain('data-opl-panel="custom-combination-list"')
    expect(text).toMatch(/combinations\.filter\(\(item\) => item\.generated\)/)
    expect(text).toMatch(/combinations\.filter\(\(item\) => !item\.generated\)/)
  })

  it('列表默认展开且可折叠，添加表单默认折叠', () => {
    const panels = detailsPanels()
    expect(panels.find((panel) => panel.panel === 'combination-list')).toMatchObject({
      hasOpen: true,
    })
    expect(panels.find((panel) => panel.panel === 'custom-combinations')).toMatchObject({
      hasOpen: false,
    })
  })
})
