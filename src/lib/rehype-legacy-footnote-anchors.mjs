/**
 * @typedef {object} HastNode
 * @property {string} [type]
 * @property {string} [tagName]
 * @property {unknown} [value]
 * @property {Record<string, unknown>} [properties]
 * @property {HastNode[]} [children]
 */

/** @param {string} target */
function pairedAnchorId(target) {
  if (target.includes('_ftnref')) return target.replace('_ftnref', '_ftn');
  if (target.includes('_ftn')) return target.replace('_ftn', '_ftnref');
  if (target.includes('-FNtext')) return target.replace('-FNtext', '-FNanker');
  if (target.includes('-FNanker')) return target.replace('-FNanker', '-FNtext');
  return undefined;
}

/**
 * @param {HastNode} node
 * @returns {string}
 */
function textContent(node) {
  if (node.type === 'text' && typeof node.value === 'string') return node.value;
  if (node.tagName === 'br') return '\n';
  return node.children?.map(textContent).join('') ?? '';
}

/**
 * @param {HastNode} node
 * @param {HastNode | undefined} parent
 */
function precedingFootnoteMarker(node, parent) {
  if (!textContent(node).includes('<=') || !parent?.children) return undefined;
  const nodeIndex = parent.children.indexOf(node);
  const precedingText = parent.children.slice(0, nodeIndex).map(textContent).join('');
  const markers = [...precedingText.matchAll(/(?:^|\n)\(([0-9]+[a-z]?)\)/gi)];
  return markers.at(-1)?.[1];
}

/**
 * @param {HastNode} node
 * @param {HastNode | undefined} parent
 */
function restoreGermanFootnote(node, parent) {
  if (!node.properties) return false;
  const properties = node.properties;
  const href = properties.href;
  if (typeof href !== 'string') return false;
  const target = href.slice(1).match(/^(.*-)(M|Z)([^/]+)$/);
  if (!target) return false;

  const linkText = textContent(node).trim();
  const reference = linkText.match(/^\(([0-9]+[a-z]?)(?:\)|$)/i);
  const isBacklink = linkText.includes('<=');
  if (!reference && !isBacklink) return false;

  const marker = reference?.[1] ?? precedingFootnoteMarker(node, parent);
  if (!marker) {
    properties.id = `${target[1]}${target[2] === 'M' ? 'Z' : 'M'}${target[3]}`;
    return true;
  }

  const isReference = Boolean(reference);
  properties.id = `${target[1]}${isReference ? 'Z' : 'M'}${marker}`;
  properties.href = `#${target[1]}${isReference ? 'M' : 'Z'}${marker}`;
  return true;
}

/** @param {HastNode} node */
function restoreGermanFootnoteImage(node) {
  if (node.tagName !== 'img' || !node.properties) return;
  const src = node.properties.src;
  const alt = node.properties.alt;
  if (typeof src !== 'string' || typeof alt !== 'string') return;

  const target = src.slice(1).match(/^(.*-)(M|Z)([^/]+)$/);
  const reference = alt.match(/^\(([0-9]+[a-z]?)\)$/i);
  if (!src.startsWith('#') || !target || !reference) return;

  const marker = reference[1];
  node.tagName = 'a';
  node.properties = {
    href: `#${target[1]}M${marker}`,
    id: `${target[1]}Z${marker}`,
  };
  node.children = [{ type: 'text', value: `(${marker})` }];
}

/** @param {HastNode} tree */
function finishLegacyFootnotes(tree) {
  /** @type {HastNode[]} */
  const nodes = [];
  /** @param {HastNode} node */
  const collect = (node) => {
    nodes.push(node);
    node.children?.forEach(collect);
  };
  collect(tree);

  let ids = new Set(
    nodes.map((node) => node.properties?.id).filter((id) => typeof id === 'string'),
  );
  const missingNotes = [];
  for (const node of nodes) {
    const href = node.properties?.href;
    if (typeof href !== 'string' || !href.startsWith('#')) continue;
    const target = href.slice(1);
    if (/-M[0-9]+[a-z]?$/i.test(target) && !ids.has(target)) missingNotes.push(target);
  }

  for (const node of nodes) {
    if (node.tagName !== 'p') continue;
    const marker = textContent(node)
      .trim()
      .match(/^\(([0-9]+[a-z]?)\)/i)?.[1];
    if (!marker) continue;
    const targets = missingNotes.filter((target) => target.endsWith(`-M${marker}`));
    if (targets.length === 1) {
      node.properties ??= {};
      node.properties.id = targets[0];
    }
  }

  const seenIds = new Set();
  for (const node of nodes) {
    const properties = node.properties;
    if (!properties) continue;
    const id = properties.id;
    if (typeof id !== 'string') continue;
    if (seenIds.has(id)) delete properties.id;
    else seenIds.add(id);
  }
  ids = seenIds;

  const legacyTarget = /(?:_ftn(?:ref)?[^/]*|-(?:M|Z)[^/-]+|-FN(?:text|anker)[^/]+)$/i;
  for (const node of nodes) {
    const properties = node.properties;
    if (!properties) continue;
    const href = properties.href;
    if (
      typeof href === 'string' &&
      href.startsWith('#') &&
      legacyTarget.test(href) &&
      !ids.has(href.slice(1))
    ) {
      delete properties.href;
    }
  }

  markFootnotePreviews(nodes);
}

/** @param {HastNode[]} nodes */
function markFootnotePreviews(nodes) {
  /** @type {Map<string, HastNode>} */
  const targets = new Map();
  for (const node of nodes) {
    const id = node.properties?.id;
    if (typeof id === 'string') targets.set(id, node);
  }

  for (const node of nodes) {
    if (node.tagName !== 'a' || !node.properties) continue;
    const href = node.properties.href;
    if (typeof href !== 'string' || !href.startsWith('#')) continue;

    const targetId = href.slice(1);
    const target = targets.get(targetId);
    if (!target?.properties) continue;

    let targetKind;
    if ('dataFootnoteRef' in node.properties) targetKind = 'standard';
    else if (/_ftn(?!ref)[^/]*$/i.test(targetId) || /-FNtext[^/]+$/i.test(targetId)) {
      targetKind = target.tagName === 'a' ? 'start' : 'block';
    } else if (/-M[^/-]+$/i.test(targetId)) {
      targetKind = target.tagName === 'a' ? 'end' : 'block';
    }
    if (!targetKind) continue;

    node.properties.dataFootnotePreviewRef = '';
    target.properties.dataFootnotePreviewTarget = targetKind;
  }
}

export default function rehypeLegacyFootnoteAnchors() {
  /** @param {HastNode} tree */
  return (tree) => {
    /**
     * @param {HastNode} node
     * @param {HastNode | undefined} parent
     */
    const visit = (node, parent) => {
      restoreGermanFootnoteImage(node);
      if (node.tagName === 'a' && node.properties && !node.properties.id) {
        const href = node.properties.href;
        if (typeof href === 'string' && href.startsWith('#')) {
          if (!restoreGermanFootnote(node, parent)) {
            const id = pairedAnchorId(href.slice(1));
            if (id) node.properties.id = id;
          }
        }
      }
      node.children?.forEach((child) => visit(child, node));
    };

    visit(tree, undefined);
    finishLegacyFootnotes(tree);
  };
}
