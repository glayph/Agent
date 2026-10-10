'use strict';

/**
 * Splits text into paragraph-sized memory units.
 *
 * A memory is a passage that carries one idea, not a single word and not a whole
 * conversation dump. Passages this size are what a reader would call a
 * paragraph: big enough to keep their meaning, small enough that recalling one
 * costs a few dozen tokens instead of the whole message.
 *
 *  - blank lines separate paragraphs; fenced code blocks are never split inside
 *  - headings and very short paragraphs are merged with their neighbour
 *  - a paragraph that is too long is cut at sentence ends (., !, ?, Bengali "।")
 */

const DEFAULTS = Object.freeze({
  minWords: 20,     // below this a paragraph is merged with its neighbour
  targetWords: 110, // preferred size when packing sentences
  maxWords: 200,    // hard ceiling for one unit
});

const SENTENCE_END = /(?<=[.!?\u0964\u0965\u3002\uFF01\uFF1F])\s+/u;

function countWords(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return 0;
  const spaced = trimmed.split(/\s+/u).length;
  // Scripts written without spaces (Chinese, Japanese) would count as one word.
  if (spaced === 1 && trimmed.length > 40) return Math.ceil(trimmed.length / 6);
  return spaced;
}

/** Break the text into raw blocks: fenced code stays whole, everything else splits on blank lines. */
function toBlocks(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  const blocks = [];
  const fence = /```[\s\S]*?(?:```|$)/g;
  let cursor = 0;
  let match;
  const pushProse = (prose) => {
    for (const part of prose.split(/\n\s*\n/u)) {
      const cleaned = part.trim();
      if (cleaned) blocks.push({ text: cleaned, code: false });
    }
  };
  while ((match = fence.exec(normalized)) !== null) {
    pushProse(normalized.slice(cursor, match.index));
    blocks.push({ text: match[0].trim(), code: true });
    cursor = match.index + match[0].length;
  }
  pushProse(normalized.slice(cursor));
  return blocks;
}

function splitLong(text, options) {
  const sentences = text.split(SENTENCE_END).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let current = [];
  let words = 0;
  const flush = () => {
    if (current.length) out.push(current.join(' '));
    current = [];
    words = 0;
  };
  for (const sentence of sentences) {
    const sentenceWords = countWords(sentence);
    if (sentenceWords > options.maxWords) {
      // A single endless sentence: cut it on word boundaries.
      flush();
      const tokens = sentence.split(/\s+/u);
      for (let index = 0; index < tokens.length; index += options.targetWords) {
        out.push(tokens.slice(index, index + options.targetWords).join(' '));
      }
      continue;
    }
    if (words > 0 && words + sentenceWords > options.targetWords) flush();
    current.push(sentence);
    words += sentenceWords;
  }
  flush();
  return out;
}

/**
 * @param {string} text
 * @param {{minWords?: number, targetWords?: number, maxWords?: number}} [opts]
 * @returns {{index: number, text: string, wordCount: number}[]}
 */
function splitParagraphs(text, opts = {}) {
  const options = { ...DEFAULTS, ...opts };
  const units = [];
  for (const block of toBlocks(text)) {
    if (block.code) {
      // Code keeps its structure; only an enormous block is cut, on line boundaries.
      if (countWords(block.text) <= options.maxWords * 2) {
        units.push({ text: block.text, code: true });
      } else {
        let chunk = [];
        let words = 0;
        for (const line of block.text.split('\n')) {
          const lineWords = countWords(line);
          if (words + lineWords > options.maxWords * 2 && chunk.length) {
            units.push({ text: chunk.join('\n'), code: true });
            chunk = [];
            words = 0;
          }
          chunk.push(line);
          words += lineWords;
        }
        if (chunk.length) units.push({ text: chunk.join('\n'), code: true });
      }
      continue;
    }
    if (countWords(block.text) > options.maxWords) {
      for (const part of splitLong(block.text, options)) units.push({ text: part, code: false });
    } else {
      units.push({ text: block.text, code: false });
    }
  }

  // Merge short units (headings, one-liners, list items) into a neighbour so that
  // no memory is a fragment. Code blocks are never merged into prose.
  const merged = [];
  for (const unit of units) {
    const previous = merged[merged.length - 1];
    const previousWords = previous ? countWords(previous.text) : 0;
    const unitWords = countWords(unit.text);
    const canMerge = previous && !previous.code && !unit.code
      && (previousWords < options.minWords || unitWords < options.minWords)
      && previousWords + unitWords <= options.maxWords;
    if (canMerge) previous.text = `${previous.text}\n${unit.text}`;
    else merged.push({ ...unit });
  }
  // A short tail left over after merging joins the previous prose unit when it fits.
  if (merged.length > 1) {
    const last = merged[merged.length - 1];
    const before = merged[merged.length - 2];
    if (!last.code && !before.code && countWords(last.text) < options.minWords
      && countWords(before.text) + countWords(last.text) <= options.maxWords) {
      before.text = `${before.text}\n${last.text}`;
      merged.pop();
    }
  }
  return merged.map((unit, index) => ({ index, text: unit.text, wordCount: countWords(unit.text) }));
}

module.exports = { splitParagraphs, countWords, DEFAULTS };
