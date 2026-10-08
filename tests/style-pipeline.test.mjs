import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

for (const surface of ['content', 'options', 'popup', 'sidepanel']) {
  test(`Tailwind 4 compiles the ${surface} stylesheet and shared theme`, async () => {
    const from = fileURLToPath(new URL(`../src/entrypoints/${surface}/style.css`, import.meta.url));
    const result = await postcss([tailwind()]).process(await readFile(from, 'utf8'), { from });
    const unresolved = [];
    result.root.walkAtRules((rule) => {
      if (['apply', 'tailwind', 'import'].includes(rule.name)) unresolved.push(rule.name);
    });
    assert.deepEqual(unresolved, []);
    assert.match(result.css, /--color-gray-200/);
    assert.match(result.css, /--spacing/);
    if (surface === 'content' || surface === 'options') {
      const selector = surface === 'content' ? '.st-status-btn' : '.input';
      const declarations = [];
      result.root.walkRules(selector, (rule) => rule.walkDecls((decl) => declarations.push([decl.prop, decl.value])));
      assert.ok(declarations.some(([prop, value]) => prop === 'border-width' && value === '1px'));
      assert.ok(declarations.some(([prop]) => prop === 'padding-inline'));
    }
  });
}
