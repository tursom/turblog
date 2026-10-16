import tlaGrammar from './grammars/tlaplus-grammar.json' with { type: 'json' };
import pluscalGrammar from './grammars/pluscal-grammar.json' with { type: 'json' };

// The upstream grammar starts at MODULE; blog fences also contain standalone expressions.
const tlaplus = {
  ...tlaGrammar,
  name: 'tlaplus',
  aliases: ['tla', 'tla+'],
  patterns: tlaGrammar.repository.module.patterns,
  repository: {
    ...tlaGrammar.repository,
    block_comments: {
      ...tlaGrammar.repository.block_comments,
      patterns: [{ include: '#block_comments' }],
    },
  },
};

// TLA+ modules can embed PlusCal algorithms inside comments.
const pluscal = {
  ...pluscalGrammar,
  name: 'pluscal',
  repository: {
    ...pluscalGrammar.repository,
    block_comments: {
      ...pluscalGrammar.repository.block_comments,
      patterns: [{ include: '#block_comments' }],
    },
  },
};

export default [tlaplus, pluscal];
