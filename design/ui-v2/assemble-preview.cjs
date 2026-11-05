'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = __dirname;
const template = fs.readFileSync(path.join(base, 'screen.html'), 'utf8');
const css = fs.readFileSync(path.join(base, 'styles.css'), 'utf8');
const script = fs.readFileSync(path.join(base, 'app.js'), 'utf8');
const sample = JSON.parse(fs.readFileSync(path.join(base, 'sample-data.json'), 'utf8'));
new vm.Script(script);
const serialized = JSON.stringify(sample).replace(/</g, '\\u003c');
const fragment = template
  .replace('<!--STYLES-->', `<style>\n${css}\n</style>`)
  .replace('<!--DATA-->', `<script type="application/json" data-galaxy-data>${serialized}</script>`)
  .replace('<!--SCRIPT-->', `<script>\n${script}\n</script>`);
const document = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>织章 · 夜航知识星系 UI v0.2</title><style>html,body{margin:0;background:#090f18}body{min-width:320px}</style></head><body>\n${fragment}\n</body></html>\n`;
const standalonePath = path.join(base, 'index.html');
const refreshReviewed = process.argv.includes('--refresh-reviewed');
function checkOutput(file, marker) {
  if (!fs.existsSync(file)) return;
  if (!refreshReviewed || !fs.readFileSync(file, 'utf8').includes(marker)) {
    throw new Error('Existing output must be inspected before a reviewed refresh.');
  }
}
checkOutput(standalonePath, '<title>织章 · 夜航知识星系 UI v0.2</title>');
const inlinePath = process.argv[2]?.startsWith('--') ? null : process.argv[2];
if (inlinePath) checkOutput(inlinePath, '<div id="sw-night-v2">');
fs.writeFileSync(standalonePath, document, 'utf8');
if (inlinePath) {
  if (Buffer.byteLength(fragment) > 1000000) throw new Error('Inline preview exceeds 1 MB.');
  const inlineCss = '\n#sw-night-v2 button,#sw-night-v2 summary{cursor:var(--cursor-interaction,pointer)}';
  fs.writeFileSync(inlinePath, fragment.replace('</style>', `${inlineCss}\n</style>`), 'utf8');
  console.log(`Inline preview: ${Buffer.byteLength(fragment).toLocaleString()} bytes.`);
}
console.log(`Created offline preview: ${sample.counts.nodes} explicit sample objects, ${sample.counts.edges} sample edges; no external resources.`);
