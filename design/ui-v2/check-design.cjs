'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ui = __dirname;
const base = path.resolve(ui, '../..');
const read = file => fs.readFileSync(file, 'utf8');
const data = JSON.parse(read(path.join(ui, 'sample-data.json')));
const ids = new Set(data.nodes.map(node => node.id));
const clusters = new Set(data.clusters.map(cluster => cluster.id));
const story = data.nodes.filter(node => node.anchor && !node.fixture);
const density = data.nodes.filter(node => node.fixture && !node.anchor);
assert.equal(ids.size, data.nodes.length, 'Duplicate object ID');
assert.deepEqual(data.counts, { nodes: 710, anchors: 14, densityFixtures: 696, edges: 1615 });
assert.equal(story.length, 14);
assert.equal(density.length, 696);
assert.equal(story.length + density.length, data.nodes.length);
for (const node of data.nodes) {
  assert(clusters.has(node.cluster), `Unknown cluster ${node.id}`);
  assert.equal(node.position.length, 3);
  assert(node.position.every(Number.isFinite), `Invalid position ${node.id}`);
  if (node.fixture) {
    assert(node.status.includes('密度演示'));
    assert.equal(node.level, '演示');
    assert(!node.excerpt, 'Density fixture has a prose excerpt');
  }
}
const edgeKeys = new Set();
for (const edge of data.edges) {
  assert(ids.has(edge.a) && ids.has(edge.b), 'Missing edge endpoint');
  assert.notEqual(edge.a, edge.b);
  const key = [edge.a, edge.b].sort().join('|');
  assert(!edgeKeys.has(key), 'Duplicate display edge');
  edgeKeys.add(key);
  if (!edge.fixture) assert(story.some(node => node.id === edge.a) && story.some(node => node.id === edge.b));
}
assert.equal(data.edges.filter(edge => !edge.fixture).length, 13);
assert.equal(data.edges.filter(edge => edge.fixture).length, 1602);
console.log('PASS data: 710 unique objects = 14 story + 696 density; 1615 valid edges = 13 story + 1602 density.');

const js = read(path.join(ui, 'app.js'));
new vm.Script(js, { filename: 'app.js' });
assert(!/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b|navigator\.sendBeacon|https?:\/\//.test(js), 'Network API or external URL in UI script');
const template = read(path.join(ui, 'screen.html'));
const css = read(path.join(ui, 'styles.css'));
const document = read(path.join(ui, 'index.html'));
const markup = document.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, match => match.slice(0, match.indexOf('>') + 1) + '</script>');
const htmlIds = [...markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(htmlIds).size, htmlIds.length, 'Duplicate HTML ID');
assert(htmlIds.includes('sw-night-v2'));
const selectors = [...js.matchAll(/\.querySelector(?:All)?\(\s*(['"])(.*?)\1\s*\)/g)].flatMap(match => match[2].split(','));
const generated = new Set(['textarea']);
function exists(selector) {
  if (generated.has(selector)) return true;
  if (selector.startsWith('#')) return htmlIds.includes(selector.slice(1));
  if (selector.startsWith('.')) return new RegExp(`class="[^"]*\\b${selector.slice(1)}\\b`).test(markup);
  if (selector.startsWith('[')) {
    const match = selector.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/);
    assert(match, `Unsupported check selector ${selector}`);
    return match[2] === undefined ? new RegExp(`\\b${match[1]}(?:[\\s=>])`).test(markup) : markup.includes(`${match[1]}="${match[2]}"`);
  }
  return new RegExp(`<${selector}(?:\\s|>)`).test(markup);
}
for (const selector of selectors) assert(exists(selector), `Missing queried target ${selector}`);
for (const name of ['kind', 'title', 'version', 'scope', 'state', 'source-title', 'quote', 'explanation']) assert(markup.includes(`data-review-${name}`));
for (const page of ['galaxy', 'writing', 'review']) assert(template.includes(`data-screen="${page}"`));
for (const ref of [...template.matchAll(/\bdata-select-scene="([^"]+)"/g)]) assert(ids.has(ref[1]));
assert(template.includes('独立确认前状态样例'));
assert(template.includes('知情来源与时点待补；不入本场记忆包'));
assert(template.includes('前场摘要 s03 的依赖未核验'));
assert(template.includes('type="button" disabled>仅设计演示'));
assert(!template.includes('tabindex='));
console.log(`PASS source: JS parses; ${selectors.length} literal selectors and 8 dynamic review targets exist in assembled markup; no network APIs; three explicit demo screens.`);

const inlinePath = process.argv[2];
for (const file of [path.join(ui, 'index.html'), ...(inlinePath ? [inlinePath] : [])]) {
  const text = read(file);
  const embedded = [...text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(embedded.length, 2, 'Unexpected script count');
  const jsonScript = embedded.find(match => match[1].includes('application/json'));
  const executable = embedded.find(match => !match[1].includes('application/json'));
  assert.deepEqual(JSON.parse(jsonScript[2]), data, 'Embedded sample data differs');
  assert.equal(executable[2].trim(), js.trim(), 'Embedded script differs');
  assert(text.includes(css), 'Embedded CSS differs');
  assert(!/<!--(?:STYLES|DATA|SCRIPT)-->|<script\b[^>]*\bsrc=|<link\b|<iframe\b|<img\b/.test(text));
  if (file === inlinePath) {
    assert(text.startsWith('<div id="sw-night-v2">'));
    assert(!/<!doctype|<html\b|<head\b|<body\b/i.test(text));
    assert(Buffer.byteLength(text) < 1000000);
    assert(!/<[^>]*\\"/.test(text.split('<script')[0]), 'Escaped literal markup');
    console.log(`PASS inline: ${Buffer.byteLength(text)} bytes; literal fragment; embedded JSON, JS and CSS match source.`);
  }
}
console.log('PASS offline page: source and embedded output match; no unresolved placeholders or external resources.');

const documents = ['README.md', 'PROJECT_STATUS.md', 'docs/10-prd.md', 'docs/13-long-memory-system.md', 'docs/14-galaxy-ui-design.md', 'design/ui-v2/validation.md'];
let localLinks = 0;
for (const relative of documents) {
  const absolute = path.join(base, relative);
  const text = read(absolute);
  assert.equal((text.match(/^```/gm) || []).length % 2, 0, `Unbalanced fence ${relative}`);
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const link = match[1];
    if (/^[a-z][a-z\d+.-]*:|^#/i.test(link)) continue;
    const target = decodeURIComponent(link.split('#')[0]);
    assert(fs.existsSync(path.resolve(path.dirname(absolute), target)), `Missing local link ${relative}: ${link}`);
    localLinks++;
  }
}
const prd = read(path.join(base, 'docs/10-prd.md'));
for (let n = 1; n <= 18; n++) assert(prd.includes(`| PR${String(n).padStart(2, '0')} ·`));
const memory = read(path.join(base, 'docs/13-long-memory-system.md'));
for (let n = 1; n <= 12; n++) assert(memory.includes(`| LM${String(n).padStart(2, '0')} ·`));
console.log(`PASS documents: ${localLinks} local links resolve; six Markdown files have balanced fences; PR01-18 and LM01-12 entries exist.`);

const expected = new Map([['01-galaxy.png', [1600, 1000]], ['02-writing-memory.png', [1600, 1000]], ['03-memory-review.png', [1600, 1000]], ['04-mobile-directions.png', [1660, 1150]]]);
for (const [file, size] of expected) {
  const bytes = fs.readFileSync(path.join(ui, file));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], size);
  console.log(`PASS image: ${file} ${size[0]}x${size[1]} PNG.`);
}
console.log('Static design check complete. No application or browser code executed; no build, service, database or model.');
