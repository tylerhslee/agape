# Agape production conformance

This package is the black-box release oracle for behavior that must work through
the shipped Agape CLI. Tests create ordinary projects, start loopback connector
services, and invoke a fresh CLI process. They never import the interpreter,
memory drivers, Studio helpers, or the runtime-conformance adapter.

`manifest.json` owns the P01-P16 capability, fixture, test, and source/package
allocation registry. The runner selects individual full test names from that
manifest and starts a separate shell-free Vitest process for every selected test.

`manifest.json` partitions capabilities into four explicit profiles:

- `core-agent`: source instructions plus the negative guarantee that ordinary
  cognition does not learn implicitly.
- `optional-memory`: explicitly selected `mem <-` / `mem ->` behavior and
  its isolation, modality, and provenance obligations.
- `studio-fact-checker`: protected judgment evidence and private
  retention/export required by the Studio fact-checking workflow.
- `research`: autonomous adaptation and behavior-transition work. It remains
  visible in CI but is non-blocking and has no package/release allocation.

`release_blocking: true` capabilities must be implemented and allocated for
the selected source/package lane. Pending or missing coverage fails; changing
profiles never converts it to a skip. Research retains its honest
`partial`/`required_pending` status without blocking a release.

```sh
npm test
npm run test:core
npm run test:optional-memory
npm run test:studio-fact-checker
npm run test:research
npm run test:research:slow
npm run test:allocated -- --profile core-agent --target package --os linux --lane full
npm run test:allocated -- --profile optional-memory --target source --os linux --lane standard --list true
```

Set `AGAPE_PRODUCTION_BIN` to exercise an extracted release launcher. Without it,
the suite invokes the repository TypeScript CLI through its pinned `tsx` loader.
Partial and `required_pending` release-blocking capabilities deliberately fail
their individually allocated coverage gates; absence is never reported as a skip
or a green release result.
