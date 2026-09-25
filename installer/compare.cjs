/** Compare versions using the official runtime's own SemVer library. */
const {createRequire}=require('node:module')
const {join}=require('node:path')
const [app,installed,available]=process.argv.slice(2)
const resources=process.platform==='win32'?'resources':'Contents/Resources'
const runtime=createRequire(join(app,resources,'app.asar/dsh/package.json'))
const semver=runtime('semver')
process.exitCode=semver.valid(installed)&&semver.valid(available)&&semver.gte(installed,available)?0:1
