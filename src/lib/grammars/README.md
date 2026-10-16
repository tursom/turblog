# TLA+ TextMate grammars

`tlaplus-grammar.json` and `pluscal-grammar.json` are vendored without modification from
[tlaplus/vscode-tlaplus](https://github.com/tlaplus/vscode-tlaplus/tree/2646260c65b2e7bc5d4323bc7662570fb3186bf4/languages),
commit `2646260c65b2e7bc5d4323bc7662570fb3186bf4`. Their MIT license is included in `LICENSE`.

`../tlaplus.mjs` supplies Shiki language names and aliases, enables TLA+ snippets without
a `MODULE` header, and adds recursive block comments. PlusCal is registered because the
TLA+ grammar references it for embedded algorithms. Builds use these local files and do
not download grammars.
