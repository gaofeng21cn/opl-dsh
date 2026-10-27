import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MODEL_PLUGIN_FIXTURE,
  startModelPluginFixture,
} from '../scripts/qualification-model-plugins.mjs'

test('the OFM qualification fixture serves the current inference model listing', async () => {
  const fixture = await startModelPluginFixture()
  try {
    const base = fixture.environment.OUR_FREE_MODEL_BASE
    for (const path of ['/inference/v1/models', '/zen/v1/models']) {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(10_000) })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { data: [{ id: MODEL_PLUGIN_FIXTURE }] })
    }
    const kilo = await fetch(base + '/kilo/models', { signal: AbortSignal.timeout(10_000) })
    assert.deepEqual(await kilo.json(), { data: [] })
  } finally {
    await fixture.close()
  }
})
