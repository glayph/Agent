'use strict';

const NodeGraphRAG = require('./nodegraphrag');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const dataDir = process.env.MEMORY_DATA_DIR || './data';
  const rag = new NodeGraphRAG({ dataDir, autoSaveIntervalMs: 0 });

  await rag.initialize();

  if (command === 'store') {
    const content = args.slice(1).join(' ');
    const memoryId = await rag.addMemory(content);
    console.log(JSON.stringify({ memoryId }));
    return;
  }

  if (command === 'search') {
    const query = args.slice(1).join(' ');
    const results = await rag.search(query, { topK: 5 });
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (command === 'context') {
    const query = args.slice(1).join(' ');
    const context = await rag.getContext(query, 2048);
    console.log(context);
    return;
  }

  console.log('Usage: node src/cli.js <store|search|context> <text>');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
