import { readFileSync } from 'node:fs';
import { check } from '../src/check.js';
import { run } from '../src/interp.js';
import { parse } from '../src/parser.js';

const util = { name: 'util', src: readFileSync('scratch_repro/util.d/util.ag','utf8') };
async function t(label: string, mainFile: string) {
  const src = readFileSync(mainFile,'utf8');
  const prog = parse(src);
  try {
    check(prog, [util]);
    const r = await run(prog, { modules: [util] });
    console.log(label, 'ACCEPTED, stdout=', r.stdout.join(','), 'ledger=', r.ledger.events.map(e=>e.etype).join(','));
  } catch (e: any) {
    console.log(label, 'REJECTED', e.name, '-', e.message);
  }
}
await t('private-fn-call', 'scratch_repro/main_privcall.ag');
await t('pub-fn-call    ', 'scratch_repro/main_pubcall.ag');
