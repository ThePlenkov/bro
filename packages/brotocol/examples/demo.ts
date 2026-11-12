/** `npx tsx examples/demo.ts` — scan the fixture spec tree, print the
 *  indented tree and the resolved graph edges. */
import { fileURLToPath } from 'node:url';
import { graph, specProtocol, tree } from '../src/index.ts';

const protocol = specProtocol({ dir: fileURLToPath(new URL('./spec-tree', import.meta.url)) });

console.log('tree:');
for (const line of tree(protocol)) {
  console.log(`  ${line}`);
}

console.log('\nedges:');
for (const e of graph(protocol).edges) {
  console.log(`  ${e.from} -> ${e.to} (${e.via})`);
}
