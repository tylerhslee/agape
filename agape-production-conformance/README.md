# Agape production conformance

This package is the black-box release oracle for behavior that must work through
the shipped Agape CLI. Tests create ordinary projects, start loopback connector
services, and invoke a fresh CLI process. They never import the interpreter,
memory drivers, Studio helpers, or the runtime-conformance adapter.

`manifest.json` owns the P01-P16 capability, fixture, test, and source/package
allocation registry. The runner selects individual full test names from that
manifest and starts a separate shell-free Vitest process for every selected test.

```sh
npm test
npm run test:allocated -- --target source --os linux --lane slow
npm run test:allocated -- --target package --os linux --lane full
npm run test:allocated -- --target package --os linux --lane smoke
npm run test:allocated -- --target source --os linux --lane standard --list true
```

Set `AGAPE_PRODUCTION_BIN` to exercise an extracted release launcher. Without it,
the suite invokes the repository TypeScript CLI through its pinned `tsx` loader.
Partial and `required_pending` capabilities deliberately fail their individually
allocated coverage gates; absence is never reported as a skip or a green result.
