'use strict';

/**
 * Shared tokenizer for the graph memory.
 *
 * Splitting on "anything that is not a letter or digit" breaks every Indic
 * script: Bengali vowel signs (ি, ো, ে ...) are Unicode marks (\p{M}), not
 * letters, so "মেমোরি" used to be cut into one-character pieces and dropped.
 * Marks therefore belong inside a word.
 */

const WORD_SPLIT = /[^\p{L}\p{M}\p{N}_-]+/u;
const BENGALI_CHAR = /[\u0980-\u09FF]/u;

// Common Bengali case/plural endings. Both the indexed text and the query are
// reduced the same way, so "মেমোরিতে" (in memory) still finds "মেমোরি" (memory).
// Longest first; one suffix is removed, and never down to fewer than 3 characters.
const BENGALI_SUFFIXES = [
  'গুলোকে', 'গুলিকে', 'গুলোর', 'গুলির', 'দেরকে', 'গুলো', 'গুলি',
  'টিকে', 'টির', 'টার', 'দের', 'েরা', 'য়ের', 'ের', 'কে', 'তে', 'রা', 'টা', 'টি',
].sort((a, b) => b.length - a.length);

// Function words carry no topic. Without this list "is"/"of"/"the" would make
// almost any stored sentence look relevant to almost any question.
const ENGLISH_STOP_WORDS = new Set((
  'a an the and or but if then so of to in on at by for with from as into about is are was were be been being am ' +
  'do does did doing have has had will would can could should may might must it its this that these those ' +
  'i me my we our you your he she they them his her their what when where which who whom why how not no yes ' +
  'there here than too very just also please tell give show let'
).split(' '));

const BENGALI_STOP_WORDS = new Set([
  'আমি', 'আমার', 'আমাকে', 'আমরা', 'তুমি', 'তোমার', 'তোমাকে', 'আপনি', 'আপনার',
  'এই', 'এটি', 'এটা', 'এটাই', 'ওই', 'ওটা', 'সেই', 'সেটা', 'এবং', 'বা', 'কিন্তু',
  'যে', 'যদি', 'তাহলে', 'জন্য', 'থেকে', 'মধ্যে', 'সাথে', 'সঙ্গে', 'করো', 'করুন',
  'করা', 'করে', 'করি', 'করবো', 'করতে', 'হবে', 'হয়', 'হয়ে', 'হচ্ছে', 'আছে', 'নেই',
  'না', 'কী', 'কি', 'কে', 'কেন', 'কখন', 'কোথায়', 'কিভাবে', 'কীভাবে', 'তার', 'তাদের',
  'তাকে', 'এর', 'ওর', 'কোনো', 'সব', 'আর', 'তো', 'যাতে', 'যেন', 'দাও', 'দিন',
]);

function splitWords(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .split(WORD_SPLIT)
    .map((token) => token.replace(/^[-_]+|[-_]+$/g, ''))
    .filter(Boolean);
}

function stem(token) {
  if (!BENGALI_CHAR.test(token)) return token;
  for (const suffix of BENGALI_SUFFIXES) {
    if (token.length - suffix.length >= 3 && token.endsWith(suffix)) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

/** Unique, stemmed, stop-word-free tokens (at most `max`). */
function tokenize(text, options = {}) {
  const stopWords = options.stopWords || new Set();
  const max = options.max || 96;
  const out = new Set();
  for (const raw of splitWords(text)) {
    if (raw.length < 2 || stopWords.has(raw) || ENGLISH_STOP_WORDS.has(raw) || BENGALI_STOP_WORDS.has(raw)) continue;
    const token = stem(raw);
    if (token.length < 2 || stopWords.has(token) || ENGLISH_STOP_WORDS.has(token) || BENGALI_STOP_WORDS.has(token)) continue;
    out.add(token);
    if (out.size >= max) break;
  }
  return [...out];
}

module.exports = { splitWords, stem, tokenize, BENGALI_STOP_WORDS, ENGLISH_STOP_WORDS };
