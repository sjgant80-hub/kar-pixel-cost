#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const kernel = readFileSync(new URL('./kernel.mjs', import.meta.url), 'utf8')
  .replace(/^export /gm, '').replace(/\r\n/g, '\n').trimEnd();
const findings = readFileSync(new URL('./findings.json', import.meta.url), 'utf8').trim();
let page = readFileSync(new URL('./index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function replaceBetween(text, beginMarker, endMarker, body) {
  const a = text.indexOf(beginMarker), b = text.indexOf(endMarker);
  if (a === -1 || b === -1 || b < a) { console.error('markers missing: ' + beginMarker); process.exit(1); }
  return text.slice(0, a + beginMarker.length) + '\n' + body + '\n' + text.slice(b);
}

page = replaceBetween(page, '// ⟦KERNEL-BEGIN⟧ generated from kernel.mjs by make-page.mjs — do not edit here', '// ⟦KERNEL-END⟧', kernel);
page = replaceBetween(page, '// ⟦FINDINGS-BEGIN⟧ generated from findings.json by make-page.mjs — do not edit here', '// ⟦FINDINGS-END⟧', 'const FINDINGS = ' + findings + ';');

writeFileSync(new URL('./index.html', import.meta.url), page);
console.log('kernel injected: ' + kernel.length + ' chars · findings injected: ' + findings.length + ' chars');
