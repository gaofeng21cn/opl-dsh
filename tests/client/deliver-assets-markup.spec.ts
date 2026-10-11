import { describe, expect, it } from 'vitest'
import {
  deliverAssetFiles,
  isLocalAbsolutePath,
  parseDeliverAssets,
} from '../../src/execution/client/deliver-assets-markup.ts'

const block = (...entries: string[]) =>
  `<deliver-assets>\n  ${entries.join('\n  ')}\n</deliver-assets>`

describe('deliver-assets markup recognition', () => {
  it('converts a closed file delivery and keeps the surrounding prose', () => {
    const text = `报告已完成。\n\n${block('<media type="file" src="C:/out/report.md" name="报告" />')}\n\n以上。`
    expect(deliverAssetFiles(text)).toEqual([{ path: 'C:/out/report.md', name: '报告' }])
    expect(parseDeliverAssets(text)).toEqual([
      { kind: 'text', text: '报告已完成。\n\n' },
      { kind: 'assets', files: [{ path: 'C:/out/report.md', name: '报告' }] },
      { kind: 'text', text: '\n\n以上。' },
    ])
  })

  it('accepts the official caption attribute, name, and the underscore variant', () => {
    expect(
      deliverAssetFiles(block('<media type="file" src="C:/a.md" caption="官方标题" />')),
    ).toEqual([{ path: 'C:/a.md', name: '官方标题' }])
    expect(deliverAssetFiles(block('<media type="file" src="C:/b.md" />'))).toEqual([
      { path: 'C:/b.md', name: 'b.md' },
    ])
    expect(
      deliverAssetFiles(
        `<deliver_assets><media type="file" src="C:/c.md" name="c" /></deliver_assets>`,
      ),
    ).toEqual([{ path: 'C:/c.md', name: 'c' }])
  })

  it('keeps Windows paths with spaces and Chinese names intact', () => {
    const files = deliverAssetFiles(
      block(
        '<media type="file" src="C:/Users/root/My Reports/年度报告 2026.md" name="年度报告 2026" />',
      ),
    )
    expect(files).toEqual([
      { path: 'C:/Users/root/My Reports/年度报告 2026.md', name: '年度报告 2026' },
    ])
  })

  it('handles backslash drive paths and POSIX absolute paths', () => {
    expect(isLocalAbsolutePath('C:\\out\\report.md')).toBe(true)
    expect(isLocalAbsolutePath('/home/root/report.md')).toBe(true)
    expect(isLocalAbsolutePath('\\\\server\\share\\report.md')).toBe(true)
  })

  it('decodes entities inside attributes only and never in the body', () => {
    const files = deliverAssetFiles(
      `正文 &amp; 符号保持原样。\n\n${block(
        '<media type="file" src="C:/a&#x20;b.md" name="报告 &lt;终稿&gt;" />',
      )}`,
    )
    expect(files).toEqual([{ path: 'C:/a b.md', name: '报告 <终稿>' }])
    const [first] = parseDeliverAssets(
      `正文 &amp; 符号保持原样。\n\n${block('<media type="file" src="C:/a&#x20;b.md" name="n" />')}`,
    )
    expect(first).toEqual({ kind: 'text', text: '正文 &amp; 符号保持原样。\n\n' })
  })

  it('does not double-decode an escaped ampersand', () => {
    expect(deliverAssetFiles(block('<media type="file" src="C:/x.md" name="&amp;lt;" />'))).toEqual(
      [{ path: 'C:/x.md', name: '&lt;' }],
    )
  })

  it('keeps markup inside fenced code as literal text', () => {
    const text = '示例：\n\n```xml\n' + block('<media type="file" src="C:/x.md" />') + '\n```\n'
    expect(deliverAssetFiles(text)).toEqual([])
    expect(parseDeliverAssets(text)).toEqual([{ kind: 'text', text }])
  })

  it('keeps markup inside inline code as literal text', () => {
    const text =
      '写成 ' + '`<deliver-assets><media type="file" src="C:/x.md" /></deliver-assets>`' + ' 即可。'
    expect(deliverAssetFiles(text)).toEqual([])
  })

  it('keeps an unclosed block as text so a streaming reply shows no partial card', () => {
    const text = `正在生成：\n${block('<media type="file" src="C:/x.md" />')}`.replace(
      '</deliver-assets>',
      '',
    )
    expect(deliverAssetFiles(text)).toEqual([])
    expect(parseDeliverAssets(text)).toEqual([{ kind: 'text', text }])
  })

  it('keeps unsupported media types as original text instead of faking support', () => {
    for (const type of ['image', 'video', 'audio']) {
      const text = block(`<media type="${type}" src="C:/clip.png" name="clip" />`)
      expect(deliverAssetFiles(text)).toEqual([])
      expect(parseDeliverAssets(text)).toEqual([{ kind: 'text', text }])
    }
  })

  it('never treats a remote URL or dangerous scheme as a local file', () => {
    for (const src of [
      'https://example.com/a.md',
      'http://example.com/a.md',
      'file:///C:/a.md',
      'javascript:alert(1)',
      'data:text/plain,hi',
      'vbscript:msgbox',
      '//example.com/a.md',
      'out/report.md',
      './report.md',
    ]) {
      expect(isLocalAbsolutePath(src)).toBe(false)
      expect(deliverAssetFiles(block(`<media type="file" src="${src}" name="x" />`))).toEqual([])
    }
  })

  it('keeps a whole block as text when any entry is invalid or stray prose sits between entries', () => {
    const mixed = block(
      '<media type="file" src="C:/ok.md" name="ok" />',
      '<media type="file" src="https://example.com/x.md" />',
    )
    expect(deliverAssetFiles(mixed)).toEqual([])
    const prose = block(
      '<media type="file" src="C:/ok.md" />',
      '另外还有：',
      '<media type="file" src="C:/b.md" />',
    )
    expect(deliverAssetFiles(prose)).toEqual([])
    const paired = '<deliver-assets><media type="file" src="C:/a.md"></media></deliver-assets>'
    expect(deliverAssetFiles(paired)).toEqual([])
  })

  it('merges adjacent blocks and deduplicates a repeated entry into one card', () => {
    const text =
      block('<media type="file" src="C:/a.md" name="a" />') +
      block(
        '<media type="file" src="C:/b.md" name="b" />',
        '<media type="file" src="C:/a.md" name="a" />',
      )
    expect(parseDeliverAssets(text)).toEqual([
      {
        kind: 'assets',
        files: [
          { path: 'C:/a.md', name: 'a' },
          { path: 'C:/b.md', name: 'b' },
        ],
      },
    ])
  })

  it('is pure, so a replayed read yields the same deliveries', () => {
    const text = `done\n${block('<media type="file" src="C:/x.md" name="x" />')}`
    expect(deliverAssetFiles(text)).toEqual(deliverAssetFiles(text))
  })

  it('converts only once the closing tag has arrived', () => {
    const open = '<deliver-assets><media type="file" src="C:/x.md" name="x" />'
    expect(deliverAssetFiles(open)).toEqual([])
    expect(deliverAssetFiles(`${open}</deliver-assets>`)).toEqual([{ path: 'C:/x.md', name: 'x' }])
  })

  it('returns ordinary text untouched when the reply has no delivery markup', () => {
    const text = '普通回答，没有交付标记。'
    expect(parseDeliverAssets(text)).toEqual([{ kind: 'text', text }])
  })
})

describe('deliver-assets parser negatives', () => {
  it('keeps a failed block as text without suppressing a later valid delivery', () => {
    const bad = block('<media type="file" src="https://example.com/remote.md" name="远端" />')
    const good = block('<media type="file" src="C:/out/ok.md" name="本地" />')
    const text = `${bad}\n${good}`
    expect(deliverAssetFiles(text)).toEqual([{ path: 'C:/out/ok.md', name: '本地' }])
    const segments = parseDeliverAssets(text)
    expect(segments[0]).toEqual({ kind: 'text', text: `${bad}\n` })
    expect(segments.at(-1)).toEqual({
      kind: 'assets',
      files: [{ path: 'C:/out/ok.md', name: '本地' }],
    })
  })

  it('keeps an unclosed block from suppressing a later valid delivery', () => {
    const text = `<deliver-assets><media type="file" src="C:/cut.md" />\n${block(
      '<media type="file" src="C:/ok.md" name="本地" />',
    )}`
    expect(deliverAssetFiles(text)).toEqual([{ path: 'C:/ok.md', name: '本地' }])
  })

  it('recognises valid markup locally beside escaped and code examples of itself', () => {
    const escaped =
      '`&lt;deliver-assets&gt;&lt;media type="file" src="C:/decoy.md" /&gt;&lt;/deliver-assets&gt;`'
    const example = '```\n' + block('<media type="file" src="C:/example.md" />') + '\n```'
    const real = block('<media type="file" src="C:/real.md" name="真实交付" />')
    const text = `${escaped}\n\n${example}\n\n${real}`
    // Only the genuine delivery converts; the escaped prose and the fenced
    // code example both stay exactly as written.
    expect(deliverAssetFiles(text)).toEqual([{ path: 'C:/real.md', name: '真实交付' }])
    const segments = parseDeliverAssets(text)
    expect(segments[0]!.kind).toBe('text')
    expect(segments[0]!.text).toContain('&lt;deliver-assets&gt;')
    expect(segments[0]!.text).toContain('C:/example.md')
  })

  it('converts one layer of encoded tags while preserving surrounding entities', () => {
    const text =
      '&lt;deliver-assets&gt;&lt;media type="file" src="C:/a.md" name="a" /&gt;&lt;/deliver-assets&gt;'
    expect(deliverAssetFiles(text)).toEqual([{ path: 'C:/a.md', name: 'a' }])
  })

  it('deduplicates Windows paths that differ only by case, keeping the first spelling', () => {
    const text = block(
      '<media type="file" src="C:/Out/Report.md" name="首次" />',
      '<media type="file" src="c:/out/report.md" name="重复" />',
    )
    expect(deliverAssetFiles(text)).toEqual([{ path: 'C:/Out/Report.md', name: '首次' }])
  })

  it('keeps case-distinct POSIX paths as two real files', () => {
    const text = block(
      '<media type="file" src="/home/root/Report.md" name="a" />',
      '<media type="file" src="/home/root/report.md" name="b" />',
    )
    expect(deliverAssetFiles(text)).toHaveLength(2)
  })

  it('keeps a delivery whose only entry repeats a sibling block as one card and no stray text', () => {
    const text =
      block('<media type="file" src="C:/a.md" name="a" />') +
      block('<media type="file" src="C:/a.md" name="a" />')
    expect(parseDeliverAssets(text)).toEqual([
      { kind: 'assets', files: [{ path: 'C:/a.md', name: 'a' }] },
    ])
  })
})

describe('chief parser regressions', () => {
  it('does not commit duplicate identities from a rejected block', () => {
    const bad = block(
      '<media type="file" src="C:/a.md" />',
      '<media type="file" src="https://x/a" />',
    )
    const text = bad + '\n' + block('<media type="file" src="C:/a.md" />')
    expect(deliverAssetFiles(text)).toEqual([{ path: 'C:/a.md', name: 'a.md' }])
    expect(parseDeliverAssets(text)[0]).toEqual({ kind: 'text', text: bad + '\n' })
  })
  it('deduplicates alternate Windows separators without rewriting the displayed path', () => {
    const text = block(
      '<media type="file" src="C:/A.md" />',
      String.raw`<media type="file" src="c:\a.md" />`,
    )
    expect(deliverAssetFiles(text)).toEqual([{ path: 'C:/A.md', name: 'A.md' }])
  })
  it('converts backslash-escaped tags and keeps prose byte-for-byte', () => {
    const escaped = block('<media type="file" src="C:/a.md" />').replaceAll(
      '<',
      String.fromCharCode(92) + '<',
    )
    const text = 'before &amp;\n' + escaped + ' after &#x20;'
    expect(parseDeliverAssets(text)).toEqual([
      { kind: 'text', text: 'before &amp;\n' },
      { kind: 'assets', files: [{ path: 'C:/a.md', name: 'a.md' }] },
      { kind: 'text', text: ' after &#x20;' },
    ])
  })
  it('preserves rejected escaped blocks and escaped tags inside code', () => {
    const bad =
      '&lt;deliver-assets&gt;&lt;media type="file" src="https://x/a" /&gt;&lt;/deliver-assets&gt;'
    expect(parseDeliverAssets(bad)).toEqual([{ kind: 'text', text: bad }])
    const escaped = block('<media type="file" src="C:/a.md" />').replaceAll(
      '<',
      String.fromCharCode(92) + '<',
    )
    const code = '```xml\n' + escaped + '\n```'
    expect(parseDeliverAssets(code)).toEqual([{ kind: 'text', text: code }])
  })
  it('does not recursively decode tag entities', () => {
    const text =
      '&amp;lt;deliver-assets&amp;gt;&amp;lt;media type="file" src="C:/a.md" /&amp;gt;&amp;lt;/deliver-assets&amp;gt;'
    expect(parseDeliverAssets(text)).toEqual([{ kind: 'text', text }])
  })
  it('does not strip multiple backslash layers or interpret a malformed escaped tag', () => {
    const text = block('<media type="file" src="C:/a.md" />').replaceAll(
      '<',
      String.fromCharCode(92, 92) + '<',
    )
    expect(parseDeliverAssets(text)).toEqual([{ kind: 'text', text }])
  })
})
