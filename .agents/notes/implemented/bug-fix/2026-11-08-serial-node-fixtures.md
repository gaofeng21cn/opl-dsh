# Node fixture test isolation

The Node integration tests run with one test-file worker at a time. Several update and installer fixtures temporarily replace built-in subprocess or filesystem exports; the Node test runner can otherwise execute those files concurrently and let one fixture observe another file's mock. The update runner's installation test injects its version, platform, architecture and installer callbacks, so it does not replace process-global subprocess APIs and remains isolated on every supported platform. Individual tests remain asynchronous within their file.

## Verification

`node --test --test-concurrency=1 tests/*.test.mjs` passes with the complete Node suite.
