/** Create a portable directory from the previously accepted Windows build; no compilation. */
import { packageCodexCandidate } from './lifecycle.mjs'
const [binary, output] = process.argv.slice(2)
if (!binary || !output)
  throw Error('用法：node package-candidate.mjs <codex.exe绝对路径> <新交付目录绝对路径>')
console.log(JSON.stringify(packageCodexCandidate(binary, output)))
