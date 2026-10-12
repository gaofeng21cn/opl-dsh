/** Install upstream model plugins once; their own managers retain update ownership. */
const { existsSync, readFileSync, mkdtempSync, cpSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const MODEL_PLUGINS = [
  {
    name: 'dsh-our-free-model',
    // Upstream v2.1.0, without repacking or changing its configuration/code.
    source:
      'https://codeload.github.com/Ebony-Vinyl/dsh-our-free-model/tar.gz/7e3a1da5407a4206b2c672f6845ada3244fb300e',
  },
]

async function installModelPlugins({ dir, install }) {
  for (const plugin of MODEL_PLUGINS) {
    const profile = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (Object.hasOwn(profile.dependencies ?? {}, plugin.name)) {
      // Preserve user versions, sources and disabled bundles. Repair a missing
      // installation from the existing manifest/lock rather than choosing a version.
      if (!existsSync(join(dir, 'node_modules', plugin.name, 'package.json')))
        await install(['install'])
      continue
    }
    await install(['add', plugin.source])
  }
}

/** pnpm may re-extract unchanged tarball dependencies when updating another package. */
async function preserveModelPlugins({ dir, install }) {
  const retained = MODEL_PLUGINS.filter((plugin) =>
    existsSync(join(dir, 'node_modules', plugin.name, 'package.json')),
  )
  if (!retained.length) return install()
  const backup = mkdtempSync(join(dir, '.opl-model-plugins-'))
  for (const plugin of retained)
    cpSync(join(dir, 'node_modules', plugin.name), join(backup, plugin.name), { recursive: true })
  try {
    return await install()
  } finally {
    // The profile is stopped. Restore all original bytes, including files added
    // by an upstream update; source/version selection remains in the profile.
    // A failed restore retains the complete backup instead of deleting recovery.
    for (const plugin of retained) {
      const installed = join(dir, 'node_modules', plugin.name)
      rmSync(installed, { recursive: true, force: true })
      cpSync(join(backup, plugin.name), installed, { recursive: true })
    }
    rmSync(backup, { recursive: true })
  }
}

module.exports = { MODEL_PLUGINS, installModelPlugins, preserveModelPlugins }
