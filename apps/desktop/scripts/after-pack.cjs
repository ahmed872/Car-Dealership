// electron-builder never copies node_modules folders from extraResources, so the API's production
// dependencies (stage/api/node_modules) are copied into the packed app here.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const from = path.join(__dirname, '..', 'stage', 'api', 'node_modules');
  const to = path.join(context.appOutDir, 'resources', 'api', 'node_modules');
  if (!fs.existsSync(from)) throw new Error(`missing ${from}: run pnpm stage first`);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  console.log(`  • copied API node_modules into ${to}`);
};
