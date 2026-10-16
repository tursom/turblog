import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import { load } from 'cheerio';
import config from '../astro.config.mjs';

const processor = await createMarkdownProcessor(
  /** @type {import('@astrojs/markdown-remark').AstroMarkdownOptions} */ (config.markdown),
);

/** @param {string} language @param {string} source */
async function renderCode(language, source) {
  const { code } = await processor.render(`\`\`\`${language}\n${source}\n\`\`\``);
  const $ = load(code);
  assert.equal($('pre.astro-code').length, 1);
  // Astro normalizes the fence's language class, stripping the '+' from 'tla+'.
  assert.equal(
    $('pre').attr('data-language'),
    language === 'tla+' ? 'tla' : language,
    'must not fall back to plaintext',
  );
  assert.equal($('code').text(), source, 'highlighting must preserve source text');
  return $;
}

/** @param {import('cheerio').CheerioAPI} $ @param {string} text */
function tokenStyle($, text) {
  const token = $('code span[style]').filter((_, node) => $(node).text() === text);
  assert.ok(token.length, `expected highlighted token: ${text}`);
  const style = token.first().attr('style');
  assert.ok(style);
  assert.match(style, /--shiki-light:/);
  assert.match(style, /--shiki-dark:/);
  return style;
}

for (const language of ['tla', 'tla+', 'tlaplus']) {
  test(`${language} highlights complete modules in both themes`, async () => {
    const source = String.raw`---- MODULE Counter ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = x + 1
Spec == Init /\ [][Next]_x
Message == "<ready>&"
\* A comment
====`;
    const $ = await renderCode(language, source);
    const keyword = tokenStyle($, 'VARIABLE');
    const number = tokenStyle($, '0');
    const string = tokenStyle($, '"<ready>&"');
    const comment = tokenStyle($, '\\* A comment');
    tokenStyle($, '[][Next]_x');
    assert.notEqual(keyword, string);
    assert.notEqual(number, comment);
    assert.equal($('ready').length, 0, 'code must remain escaped HTML');
  });
}

test('standalone snippets highlight operators and nested comments', async () => {
  const $ = await renderCode(
    'tla',
    String.raw`VARIABLE x
(* outer
   (* inner *) still outer
   VARIABLE hidden
*)
Init == x \in 0..10
Eventually == <> (x = 10)
Label == "done"`,
  );
  const comment = tokenStyle($, '   VARIABLE hidden');
  assert.notEqual(comment, tokenStyle($, 'VARIABLE'));
  tokenStyle($, '\\in');
  tokenStyle($, '<>');
  tokenStyle($, '"done"');
});

test('embedded PlusCal resolves its grammar and returns to TLA+', async () => {
  const $ = await renderCode(
    'tlaplus',
    `---- MODULE Algorithm ----
(* --algorithm Counter
variable x = 0;
begin
  Step: x := x + 1;
end algorithm; *)
VARIABLE y
====`,
  );
  tokenStyle($, 'variable');
  tokenStyle($, 'begin');
  tokenStyle($, 'VARIABLE');
});

test('existing JavaScript highlighting still works', async () => {
  const $ = await renderCode('js', 'const answer = 42;');
  assert.notEqual(tokenStyle($, 'const'), tokenStyle($, ' 42'));
});
