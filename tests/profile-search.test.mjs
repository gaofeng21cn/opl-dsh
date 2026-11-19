import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureGatewaySearchProvider } from '../installer/profile-search.mjs'

test('adds the Gateway search route to a profile without a web entry', () => {
  const result = ensureGatewaySearchProvider('- id: webserver\n- id: llm-pi-ai\n')
  assert.match(result, /- id: web\n  config:\n    searchProvider: opl-gateway\n- id: llm-pi-ai/)
})

test('preserves an existing web entry and adds the route to its config', () => {
  const result = ensureGatewaySearchProvider(
    '- id: web\n  config:\n    fetchProvider: http\n- id: llm-pi-ai\n',
  )
  assert.match(
    result,
    /- id: web\n  config:\n    searchProvider: opl-gateway\n    fetchProvider: http/,
  )
})

test('does not duplicate the route', () => {
  const source = '- id: web\n  config:\n    searchProvider: opl-gateway\n'
  assert.equal(ensureGatewaySearchProvider(source), source)
})
