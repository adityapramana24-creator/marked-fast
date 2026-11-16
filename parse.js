// parse.js — dependency-free CommonMark + GFM renderer, byte-compatible with
// marked 18.1.3 (default options). Written from scratch for the
// markdown-render-speed-02 competition. Single-pass direct-to-HTML design:
// a line-based block scanner feeds a recursive inline renderer.

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  return new DocParser(src).render();
}

// ---------------------------------------------------------------------------
// Character classification (Unicode-aware, matching marked's flanking rules)
// ---------------------------------------------------------------------------

const PUNCT_RE = /[\p{P}\p{S}]/u;
const SPACE_RE = /\s/;
const ALNUM_RE = /[\p{L}\p{N}]/u;

function isSpace(ch) {
  return ch === '' ? true : SPACE_RE.test(ch);
}
function isPunct(ch) {
  // In GFM mode marked treats '~' as a word character, not punctuation.
  return ch !== '' && ch !== '~' && PUNCT_RE.test(ch);
}
function isAlnum(ch) {
  return ch !== '' && ALNUM_RE.test(ch);
}
function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

// ---------------------------------------------------------------------------
// Escaping and entities
// ---------------------------------------------------------------------------

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Escape text the way marked does: '&' is left alone when it starts a valid
// character reference (&#1-7 digits; &#x1-6 hex; or &word;), otherwise
// escaped; < > " ' are always escaped.
const ESCAPE_TEST_RE = /[&<>"']/;
const ENTITY_REF_RE = /^&(?:#\d{1,7};|#[xX][0-9a-fA-F]{1,6};|\w+;)/;
function escapeText(s) {
  if (!ESCAPE_TEST_RE.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      const rest = s.slice(i, i + 64);
      if (ENTITY_REF_RE.test(rest)) continue;
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === '<' || c === '>' || c === '"' || c === "'") {
      out += s.slice(start, i) + ESCAPE_MAP[c];
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape for code spans / code blocks: every & is escaped, no ref check.
function escapeCode(s) {
  if (!ESCAPE_TEST_RE.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const rep = ESCAPE_MAP[c];
    if (rep) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode numeric character references (&#35; &#x22;). Decimal: 1-7 digits;
// hex: 1-6 digits. Named references pass through untouched. Invalid code
// points (0, surrogates, > 0x10FFFF) become U+FFFD. Code point 38 becomes
// '&amp;' (never a bare '&', so it cannot fuse with following text).
const NUMERIC_REF_RE = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/g;
function decodeNumericRefs(s) {
  if (s.indexOf('&#') === -1) return s;
  return s.replace(NUMERIC_REF_RE, (m, body) => {
    let cp;
    if (body[1] === 'x' || body[1] === 'X') {
      cp = parseInt(body.slice(2), 16);
    } else {
      cp = parseInt(body.slice(1), 10);
    }
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

// marked's cleanUrl: encodeURI, then restore '%' (so %25 becomes %).
// Returns null when encodeURI throws (lone surrogate) — the caller then
// renders the link as plain text.
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
  return href;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Mask placeholder: a control char that behaves as a "word-like" character
// for flanking (not space, not punctuation, not alphanumeric), so emphasis
// delimiters adjacent to masked regions still flank correctly.
const MASK = '\u0001';
const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
// Email local-part chars (for the maybeEmailStart gate; a Set lookup
// is cheaper than a per-char regex test).
const EMAIL_LOCAL_CHARS = new Set(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&\'*+/=?^_`{|}~-'.split(''),
);

// Block-level tag names (CommonMark list, as used by marked).
const BLOCK_TAGS = new Set(
  ('address|article|aside|base|basefont|blockquote|body|caption|center|col|' +
   'colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|' +
   'footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|' +
   'legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|' +
   'p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|' +
   'track|ul').split('|')
);

// Attribute pattern inside a tag (no newlines inside quoted values).
const TAG_ATTR = `\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s"'=<>\\\`]+)?`;
const OPEN_TAG_RE = new RegExp(
  `^<[a-zA-Z][a-zA-Z0-9-]*(?:${TAG_ATTR})*\\s*\\/?>`
);
const CLOSE_TAG_RE = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/;
const COMMENT_RE = /^<!--(?:-?>|[\s\S]*?-->)/;
const PI_RE = /^<\?[\s\S]*?\?>/;
const DECL_RE = /^<![A-Z][\s\S]*?>/;
const CDATA_RE = /^<!\[CDATA\[[\s\S]*?\]\]>/;

// Inline autolink <scheme:...> — scheme 2-32 chars, letter first.
const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/;
// Inline autolink <email> — needs a dot in the domain.
const EMAIL_TAG_RE = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)>/;

// Extended autolinks (GFM): www. and email, tried when not inside <a>.
// Bare scheme URLs (http/https/ftp only) are also linkified.
const SCHEME_URL_RE = /^(?:https?|ftp):\/\/(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/i;
// The 'www.' prefix must be lowercase; the domain may mix case.
const WWW_RE = /^www\.(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/;
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
// mailto: / xmpp: bare URLs (lowercase only). xmpp: may carry a
// /resource (no further '/').
const MAILTO_XMPP_RE = /^(?:mailto:[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)/;
// Trailing-trim for www./scheme URLs, applied until stable: drops
// trailing punctuation, unbalanced ')', and a trailing named entity
// (&word;) as a whole (a numeric &#...; keeps its digits, loses ';').
const BACKPEDAL_RE = /^(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

// Emphasis masking (marked's #n): two regex passes over the raw text.
// Pass 1 finds code spans (loose: inner backticks allowed) and escapes;
// pass 2 masks links, code spans and HTML tags with [aaa...] placeholders.
// The mask is computed from the RAW text, so a "phantom" code span or
// link (one that does not form a real token) still masks emphasis.
const MASK_PUNCT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCK_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+?\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)(?<b>`+)[^`]+?\k<b>(?!`)|<(?! )[^<>]*?>/g;
// Reflink search for the emphasis mask (marked's #n reflinkSearch):
// full reflink first (ref REQUIRED), then shortcut/collapsed with a
// (?!\() guard. The label only allows backticks as a loose code span
// or as `` before ]; stray backticks break the full-reflink match.
// Built once at module scope (was a per-call new RegExp).
const MASK_REFLINK_LABEL_INNER =
  '[^\\[\\]`\\\\]|\\\\[\\s\\S]|\\[[^\\[\\]]*\\]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])';
const MASK_REFLINK_RE = new RegExp(
  `!?\\[((?:${MASK_REFLINK_LABEL_INNER})*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\])+)\\]|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\])+)\\](?:\\[\\])?(?!\\()`,
  'g',
);

class InlineParser {
  constructor(refs) {
    this.refs = refs; // Map: normalized label -> { href, title }
    this.inLink = false; // persists across blocks; set by inline <a ...>
    this.inRawBlock = false; // reset at each block's inline parse
    this.linkEmitted = false; // set when a link token is produced
  }

  // Render one inline span (a paragraph's text, a heading's text, a table
  // cell, emphasis content, a link label). topLevel=true when called for a
  // whole block: resets inRawBlock.
  render(text, topLevel) {
    if (topLevel) this.inRawBlock = false;
    if (!text) return '';
    const { segs } = this.buildMask(text, false);
    // The emphasis/del mask is computed from the raw text (marked's #n),
    // NOT from the parsed segments: phantom code spans/links mask too.
    // Skip it when there are no emphasis/del delimiters (marked's #e
    // does the same) — findEmphasis/findDel are never called then.
    const masked =
      text.includes('*') || text.includes('_') || text.includes('~')
        ? this.maskForEmphasis(text)
        : text;
    return this.emit(text, masked, segs, 0, text.length);
  }

  // Masked copy of the text for emphasis/del scanning, following
  // marked's #n: (1) resolvable reflinks become [aaa...]; (2) escapes
  // become '+' and code spans keep their backticks but lose inner
  // backticks (to '+'); (3) links, code spans and HTML tags become
  // [aaa...] placeholders of the same length.
  maskForEmphasis(text) {
    let t = text;
    if (this.refs && this.refs.size > 0 && t.includes('[')) {
      // Reflink masking, following marked's #n: the key comes from the
      // LAST '[' (so a collapsed [label][] does NOT resolve here — its
      // key is ''), and a label containing a resolvable inner reflink
      // is preserved (only inner reflinks are masked recursively).
      // Two alternatives like marked's reflinkSearch: full reflink
      // first (ref REQUIRED — a single optional-ref regex greedily
      // consumes the [ref] as a nested label group, gen5 doc-20), then
      // shortcut/collapsed with a (?!\\() guard. The label only allows
      // backticks as a loose code span (`+(?!`)[^`]*?`+(?!`)) or as
      // `` before ]; stray backticks break the full-reflink match so
      // the label falls through to the nolink alternative (gen6
      // doc-02: `` a ` b `` leaves a trailing `` that no code span
      // can consume).
      const re = MASK_REFLINK_RE;
      const refs = this.refs;
      const linkInText = (s) => {
        if (!s.includes('[')) return false;
        // An inline link inside the label counts (blockSkip match that
        // is a link, not an image).
        for (const mm of s.matchAll(MASK_BLOCK_RE)) {
          if (
            mm[0].startsWith('[') &&
            mm[0].includes('](') &&
            s[mm.index - 1] !== '!'
          ) {
            return true;
          }
        }
        for (const mm of s.matchAll(re)) {
          const o = mm[0].lastIndexOf('[');
          if (mm[0].charAt(0) === '!') continue;
          if (!refs.has(InlineParser.normLabel(mm[0].slice(o + 1, -1)))) {
            continue;
          }
          if (o > 1 && linkInText(mm[0].slice(1, o - 1))) continue;
          return true;
        }
        return false;
      };
      const repl = (m) => {
        const o = m.lastIndexOf('[');
        if (!refs.has(InlineParser.normLabel(m.slice(o + 1, -1)))) {
          return m;
        }
        if (o > 1 && m.charAt(0) !== '!') {
          const inner = m.slice(1, o - 1);
          if (linkInText(inner)) {
            // The shared global regex is re-entered here (this repl
            // runs inside t.replace(re, repl)); save/restore lastIndex
            // so the outer iteration resumes correctly.
            const savedLastIndex = re.lastIndex;
            const maskedInner = inner.replace(re, repl);
            re.lastIndex = savedLastIndex;
            return (
              '[' +
              maskedInner +
              '][' +
              'a'.repeat(Math.max(0, m.length - o - 2)) +
              ']'
            );
          }
        }
        return '[' + 'a'.repeat(Math.max(0, m.length - 2)) + ']';
      };
      t = t.replace(re, repl);
    }
    t = t.replace(MASK_PUNCT_RE, (n, s, r) => {
      if (r) return '+'.repeat(n.length);
      if (s) {
        return (
          s +
          n.slice(s.length, -s.length).replace(/`/g, '+') +
          s
        );
      }
      return n;
    });
    t = t.replace(MASK_BLOCK_RE, (n) => {
      return '[' + 'a'.repeat(Math.max(0, n.length - 2)) + ']';
    });
    return t;
  }

  // Scan text left to right, finding atomic segments (code spans, HTML
  // tags, autolinks, resolved links/images, escapes) and building a masked
  // copy where each atomic segment is replaced by MASK chars of the same
  // length, so emphasis/delimiter scanning cannot match inside them.
  // Returns { masked, segs } with segs a Map startIndex -> segment.
  buildMask(text, needMasked = true) {
    const n = text.length;
    const mask = needMasked ? new Array(n) : null;
    if (mask) for (let i = 0; i < n; i++) mask[i] = text[i];
    const segs = new Map();
    let i = 0;
    while (i < n) {
      const c = text[i];
      if (c === '\\' && i + 1 < n && ASCII_PUNCT.has(text[i + 1])) {
        // Escape: mask both chars.
        if (mask) {
          mask[i] = MASK;
          mask[i + 1] = MASK;
        }
        i += 2;
        continue;
      }
      if (c === '`') {
        const span = this.matchCodeSpan(text, i);
        if (span) {
          if (mask) for (let j = span.start; j < span.end; j++) mask[j] = MASK;
          segs.set(span.start, span);
          i = span.end;
          continue;
        }
        // No matching closer: the whole backtick run is literal text.
        while (text[i] === '`') i++;
        continue;
      }
      if (c === '<') {
        const tag = this.matchTag(text, i);
        if (tag) {
          if (mask) for (let j = tag.start; j < tag.end; j++) mask[j] = MASK;
          segs.set(tag.start, tag);
          i = tag.end;
          continue;
        }
        i++;
        continue;
      }
      if (c === '[' || (c === '!' && text[i + 1] === '[')) {
        const link = this.matchLink(text, i);
        if (link) {
          if (mask) for (let j = link.start; j < link.end; j++) mask[j] = MASK;
          segs.set(link.start, link);
          i = link.end;
          continue;
        }
        i++;
        continue;
      }
      i++;
    }
    return { masked: mask ? mask.join('') : text, segs };
  }

  // Match a code span starting at the backtick run at pos. Returns
  // { start, end, kind: 'code', html } or null.
  matchCodeSpan(text, pos) {
    let runLen = 0;
    while (text[pos + runLen] === '`') runLen++;
    const closer = '`'.repeat(runLen);
    let idx = pos + runLen;
    for (;;) {
      const found = text.indexOf(closer, idx);
      if (found === -1) return null;
      // The closer must be a run of exactly runLen backticks.
      if (text[found - 1] === '`' || text[found + runLen] === '`') {
        idx = found + 1;
        continue;
      }
      let content = text.slice(pos + runLen, found);
      content = content.replace(/\n/g, ' ');
      if (
        content.length >= 2 &&
        content[0] === ' ' &&
        content[content.length - 1] === ' ' &&
        content.trim() !== ''
      ) {
        content = content.slice(1, -1);
      }
      return {
        start: pos,
        end: found + runLen,
        kind: 'code',
        html: '<code>' + escapeCode(content) + '</code>',
      };
    }
  }

  // Match an inline HTML tag or autolink starting at '<' (pos).
  // Returns a segment { start, end, kind, html } or null.
  matchTag(text, pos) {
    const rest = text.slice(pos);
    let m = COMMENT_RE.exec(rest);
    if (m) return { start: pos, end: pos + m[0].length, kind: 'html', html: m[0] };
    m = PI_RE.exec(rest);
    if (m) return { start: pos, end: pos + m[0].length, kind: 'html', html: m[0] };
    m = DECL_RE.exec(rest);
    if (m) return { start: pos, end: pos + m[0].length, kind: 'html', html: m[0] };
    m = CDATA_RE.exec(rest);
    if (m) return { start: pos, end: pos + m[0].length, kind: 'html', html: m[0] };
    // Autolink <scheme:...> — href and text both entity-encode=true.
    // The href is the cleanUrl'd form; the text is the raw URL.
    m = AUTOLINK_RE.exec(rest);
    if (m) {
      const href = cleanUrl(m[1]);
      if (href === null) return null;
      return {
        start: pos,
        end: pos + m[0].length,
        kind: 'autolink',
        html:
          '<a href="' +
          escapeCode(href) +
          '">' +
          escapeCode(m[1]) +
          '</a>',
      };
    }
    // Autolink <email>.
    m = EMAIL_TAG_RE.exec(rest);
    if (m) {
      const esc = escapeCode(m[1]);
      return {
        start: pos,
        end: pos + m[0].length,
        kind: 'autolink',
        html: '<a href="mailto:' + esc + '">' + esc + '</a>',
      };
    }
    m = OPEN_TAG_RE.exec(rest);
    if (m) return { start: pos, end: pos + m[0].length, kind: 'html', html: m[0] };
    m = CLOSE_TAG_RE.exec(rest);
    if (m) return { start: pos, end: pos + m[0].length, kind: 'html', html: m[0] };
    return null;
  }

  // Normalize a link label for reference lookup: collapse whitespace,
  // trim, case-fold (marked's fold: toLowerCase().toUpperCase().toLowerCase()
  // is equivalent to toLowerCase for our purposes, but keep the exact chain
  // for fold edge cases).
  static normLabel(label) {
    return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
  }

  // Unescape backslash escapes in a destination or title.
  static unescapeBackslash(s) {
    if (s.indexOf('\\') === -1) return s;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && i + 1 < s.length && ASCII_PUNCT.has(s[i + 1])) {
        out += s[i + 1];
        i++;
      } else {
        out += s[i];
      }
    }
    return out;
  }

  // Scan a link label starting at '[' (pos). Returns the index just past
  // the matching ']' and the label's inner range, or null. Handles nested
  // balanced brackets and backslash escapes.
  scanLabel(text, pos) {
    let depth = 0;
    let i = pos;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (c === '\\' && i + 1 < n) {
        i += 2;
        continue;
      }
      if (c === '`' && depth === 1) {
        // Code-span skipping applies ONLY at the outermost label level:
        // inside a nested [...] group, marked's label regex consumes
        // backticks as ordinary chars ([^\[\]\\]), not as code spans
        // (gen3 doc-40: `` a ` b `` inside [path ...] must not break
        // the outer label scan). A ']' inside a code span does not close the label. Marked's
        // label regex uses a LOOSE code span here: a backtick run,
        // non-backtick content, a backtick run (any lengths) — so skip
        // to the end of the NEXT backtick run, not a same-length one.
        // The closer must come before the label's closing ']' (an
        // unescaped ']' at depth 0 ends the label first, so a backtick
        // after it is NOT a closer for this run).
        let runLen = 0;
        while (text[i + runLen] === '`') runLen++;
        let next = -1;
        let d = depth;
        for (let j = i + runLen; j < n; j++) {
          const cj = text[j];
          if (cj === '\\' && j + 1 < n) {
            j++;
            continue;
          }
          if (cj === '`') {
            next = j;
            break;
          }
          if (cj === '[') d++;
          else if (cj === ']') {
            d--;
            if (d === 0) break;
          }
        }
        if (next === -1) {
          // No closer: allowed only as 2+ backticks immediately
          // before ']' (marked's ``+(?=]) alternative); otherwise
          // an unclosed backtick run breaks the label.
          if (runLen >= 2 && text[i + runLen] === ']') {
            i += runLen;
            continue;
          }
          return null;
        }
        let runLen2 = 0;
        while (text[next + runLen2] === '`') runLen2++;
        i = next + runLen2;
        continue;
      }
      if (c === '<') {
        // A ']' inside an HTML tag or autolink does not close the label.
        const tag = this.matchTag(text, i);
        if (tag) {
          i = tag.end;
          continue;
        }
      }
      if (c === '[') {
        depth++;
      } else if (c === ']') {
        depth--;
        if (depth === 0) {
          return { end: i + 1, labelStart: pos + 1, labelEnd: i };
        }
      }
      i++;
    }
    return null;
  }

  // Scan a reference label (for [text][ref], collapsed refs, and defs):
  // no unescaped '[' or ']' allowed inside (unlike link text labels,
  // which allow balanced brackets and skip code spans/tags).
  scanRefLabel(text, pos) {
    let i = pos + 1; // skip '['
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (c === '\\' && i + 1 < n) {
        i += 2;
        continue;
      }
      if (c === '[') return null;
      if (c === ']') {
        return { end: i + 1, labelStart: pos + 1, labelEnd: i };
      }
      i++;
    }
    return null;
  }

  // Parse an inline link destination + optional title starting just after
  // '('. Returns { href, title, end } (end = index past ')') or null.
  parseInlineDest(text, pos) {
    const n = text.length;
    let i = pos;
    // Skip whitespace after '('.
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) i++;
    let href = '';
    if (i < n && text[i] === '<') {
      // <...> destination: no '<', no newline; backslash escapes allowed.
      let j = i + 1;
      let dest = '';
      while (j < n) {
        const c = text[j];
        if (c === '\n') return null;
        if (c === '<') return null;
        if (c === '>') break;
        if (c === '\\' && j + 1 < n && ASCII_PUNCT.has(text[j + 1])) {
          dest += text[j + 1];
          j += 2;
          continue;
        }
        dest += c;
        j++;
      }
      if (j >= n || text[j] !== '>') return null;
      href = dest;
      i = j + 1;
    } else {
      // Bare destination: no spaces, balanced parens allowed.
      let depth = 0;
      let dest = '';
      let j = i;
      while (j < n) {
        const c = text[j];
        if (c === ' ' || c === '\t' || c === '\n') break;
        if (c === '\\' && j + 1 < n && ASCII_PUNCT.has(text[j + 1])) {
          dest += text[j + 1];
          j += 2;
          continue;
        }
        if (c === '(') {
          depth++;
          dest += c;
          j++;
          continue;
        }
        if (c === ')') {
          if (depth === 0) break;
          depth--;
          dest += c;
          j++;
          continue;
        }
        dest += c;
        j++;
      }
      href = dest;
      i = j;
    }
    // Skip whitespace, then optional title, then whitespace, then ')'.
    let title = null;
    let k = i;
    while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
    if (k < n && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
      const q = text[k];
      const close = q === '(' ? ')' : q;
      let t = '';
      let j = k + 1;
      let ok = false;
      while (j < n) {
        const c = text[j];
        if (c === '\\' && j + 1 < n && ASCII_PUNCT.has(text[j + 1])) {
          t += text[j + 1];
          j += 2;
          continue;
        }
        if (c === close) {
          ok = true;
          break;
        }
        // Single-quoted titles cannot contain a blank line.
        if (q === "'" && c === '\n') {
          let m = j + 1;
          while (m < n && (text[m] === ' ' || text[m] === '\t')) m++;
          if (m < n && text[m] === '\n') return null;
        }
        // Paren titles cannot contain an unescaped '(' ... actually they
        // CAN contain '('; only unescaped ')' closes. Handled above.
        t += c;
        j++;
      }
      if (!ok) return null;
      title = t;
      k = j + 1;
      while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
    }
    if (k >= n || text[k] !== ')') return null;
    return { href, title, end: k + 1 };
  }

  // Try to match a link or image starting at pos ('[' or '![').
  // Returns a segment or null.
  matchLink(text, pos) {
    const isImage = text[pos] === '!';
    const bracket = isImage ? pos + 1 : pos;
    if (text[bracket] !== '[') return null;
    const label = this.scanLabel(text, bracket);
    if (!label) return null;
    const labelText = text.slice(label.labelStart, label.labelEnd);
    let href = null;
    let title = null;
    let end = -1;
    const after = label.end;
    if (text[after] === '(') {
      const dest = this.parseInlineDest(text, after + 1);
      if (dest) {
        href = dest.href;
        title = dest.title;
        end = dest.end;
      } else {
        // Inline link failed: fall back to a shortcut reference.
        const key = InlineParser.normLabel(labelText);
        const def = this.refs.get(key);
        if (!def) return null;
        href = def.href;
        title = def.title;
        end = label.end;
      }
    } else if (text[after] === '[') {
      // Full/collapsed reference. If the ref LABEL fails to scan
      // (malformed, e.g. nested '[', or no closing ']'), fall back to
      // a shortcut reference (probe48). If it scans but the ref is
      // undefined, NO shortcut fallback (cm-568).
      const ref = this.scanRefLabel(text, after);
      if (!ref) {
        const key = InlineParser.normLabel(labelText);
        const def = this.refs.get(key);
        if (!def) return null;
        href = def.href;
        title = def.title;
        end = label.end;
      } else {
        const refText = text.slice(ref.labelStart, ref.labelEnd);
        const key = InlineParser.normLabel(refText === '' ? labelText : refText);
        const def = this.refs.get(key);
        if (!def) return null;
        href = def.href;
        title = def.title;
        end = ref.end;
      }
    } else {
      // Shortcut reference.
      const key = InlineParser.normLabel(labelText);
      const def = this.refs.get(key);
      if (!def) return null;
      href = def.href;
      title = def.title;
      end = label.end;
    }
    // A link whose label contains a link is rejected (images exempt).
    if (!isImage) {
      const inner = this.buildMask(labelText, false);
      for (const seg of inner.segs.values()) {
        if (seg.kind === 'link') return null;
      }
    }
    return {
      start: pos,
      end,
      kind: isImage ? 'image' : 'link',
      labelStart: label.labelStart,
      labelEnd: label.labelEnd,
      href,
      title,
    };
  }

  // Flanking classification for a delimiter run in the masked text.
  // Returns 0 = neither, 1 = open-only, 2 = close-only, 3 = both.
  // Punctuation for the '_' closer regex (marked's live emStrongRDelimUnd
  // is kt, built with the non-GFM sets: '~' COUNTS as punctuation). The
  // '*' closer (ht) uses the GFM sets where '~' is a word char.
  static flank(masked, runStart, runEnd, tildeIsPunct) {
    const before = runStart > 0 ? masked[runStart - 1] : '';
    const after = runEnd < masked.length ? masked[runEnd] : '';
    const beforeSpace = before === '' || isSpace(before);
    const afterSpace = after === '' || isSpace(after);
    const punct = (ch) => (tildeIsPunct && ch === '~') || isPunct(ch);
    const beforePunct = punct(before);
    const afterPunct = punct(after);
    const left =
      !afterSpace && (!afterPunct || beforeSpace || beforePunct);
    const right =
      !beforeSpace && (!beforePunct || afterSpace || afterPunct);
    return (left ? 1 : 0) | (right ? 2 : 0);
  }

  // Forward-scan emphasis (marked's emStrong algorithm, reimplemented).
  // masked: masked text; pos: current delimiter position; delim: '*'/'_'.
  // Returns { start, end, tag, contentStart, contentEnd } or null.
  // `masked` is the #n mask (closer search); `text` is the unmasked
  // original (the opener run is measured here: marked's opener regex
  // runs on the unmasked text, so a masked opener still opens).
  findEmphasis(masked, text, pos, delim) {
    const n = masked.length;
    // Run length from pos, measured in the UNMASKED text.
    let k = 0;
    while (pos + k < n && text[pos + k] === delim) k++;
    if (k === 0) return null;
    // Total run length: marked extends BACKWARDS over delimiters in the
    // MASKED text (a preceding delimiter hidden by the mask does not
    // extend the run — gen10 doc-10: the first '*' of '**' is inside a
    // phantom code span in the mask, so the second '*' has y=1, not 2).
    let runStart = pos;
    while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
    const y = pos + k - runStart;
    // o: the char before pos (unmasked) is the delimiter.
    const o = pos > 0 && text[pos - 1] === delim;
    const after = pos + k < n ? text[pos + k] : '';
    // Opener must be followed by a non-space char that is not the delimiter.
    if (after === '' || isSpace(after) || after === delim) return null;
    // The char before the whole run (not before pos): when the run
    // extends backwards over already-consumed delimiters, marked tests
    // the char before the run for both the intra-word '_' rule and the
    // left-flanking rule.
    const runBefore = runStart > 0 ? text[runStart - 1] : '';
    // Intra-word '_' cannot open.
    if (delim === '_' && isAlnum(runBefore)) return null;
    // Not left-flanking: followed by punctuation, preceded by a
    // non-punctuation non-space char.
    if (isPunct(after) && runBefore !== '' && !isPunct(runBefore) && !isSpace(runBefore)) {
      return null;
    }
    // R: can the run also close? Marked computes this from the MASKED
    // text (the char before the run comes from the mask, where a space
    // inside a phantom code span/link is 'a', making R true — gen10
    // doc-10). The char after the opener is from the UNMASKED text
    // (marked's emStrongLDelim runs on the unmasked remainder).
    const runAfter = pos + k < n ? text[pos + k] : '';
    const maskRunBefore = runStart > 0 ? masked[runStart - 1] : '';
    const R =
      maskRunBefore !== '' &&
      !isSpace(maskRunBefore) &&
      (isPunct(runAfter) || (delim === '*' && !isPunct(maskRunBefore)));
    let m = k;
    let f = 0;
    let i = pos + k;
    // End of the previous delimiter run examined (bounds the skip check).
    let prevEnd = pos + k;
    // The other delimiter's double run forms skip spans: a '*' candidate
    // inside a '__...__' span (or '_' inside '**...**') is not a
    // candidate at all (marked's closer regex skips such spans).
    // CRITICAL: the skip alternative starts with '^', so it can only
    // match at lastIndex=0 — only the FIRST delimiter run after the
    // opener can be skipped. After any match advances lastIndex, the
    // '^' fails and no further skipping happens (verified by probe45
    // + direct regex trace, t44).
    const other = delim === '*' ? '_' : '*';
    const dbl = other + other;
    let firstCandidate = true;
    while (i < n) {
      // Find the next run of the delimiter.
      while (i < n && masked[i] !== delim) i++;
      if (i >= n) break;
      let b = 0;
      while (i + b < n && masked[i + b] === delim) b++;
      const runEnd = i + b;
      // Skip-pattern check (first candidate only): is this run inside
      // a double-other-delimiter span with no delimiter chars
      // intervening?
      let skipped = false;
      if (firstCandidate) {
        // The span must OPEN at the first double-other run after the
        // opener; no delimiter chars may intervene anywhere — including
        // between the opener and the opening double run (the pattern's
        // leading [^_*]*? forbids them; gen3 doc-20).
        const u1 = masked.indexOf(dbl, prevEnd);
        if (u1 !== -1 && u1 + 2 <= i) {
          const preStar = masked.indexOf('*', prevEnd);
          const preUnd = masked.indexOf('_', prevEnd);
          const cleanBefore =
            (preStar === -1 || preStar >= u1) &&
            (preUnd === -1 || preUnd >= u1);
          if (cleanBefore) {
            const nextOther = masked.indexOf(other, u1 + 2);
            if (nextOther === -1 || nextOther >= i) {
              const u2 = masked.indexOf(dbl, runEnd);
              if (u2 !== -1) {
                const nextStar = masked.indexOf('*', runEnd);
                const nextUnd = masked.indexOf('_', runEnd);
                if (
                  (nextStar === -1 || nextStar >= u2) &&
                  (nextUnd === -1 || nextUnd >= u2)
                ) {
                  skipped = true;
                }
              }
            }
          }
        }
      }
      firstCandidate = false;
      if (skipped) {
        prevEnd = runEnd;
        i = runEnd;
        continue;
      }
      // For '_', a run with word chars on both sides is inert.
      if (delim === '_') {
        const bBefore = i > 0 ? masked[i - 1] : '';
        const bAfter = runEnd < n ? masked[runEnd] : '';
        if (isAlnum(bBefore) && isAlnum(bAfter)) {
          prevEnd = runEnd;
          i = runEnd;
          continue;
        }
      }
      const fl = InlineParser.flank(masked, i, runEnd, delim === '_');
      if (fl === 0) {
        prevEnd = runEnd;
        i = runEnd;
        continue;
      }
      if (fl === 1) {
        // Open-only: add to the remaining opener length.
        m += b;
        prevEnd = runEnd;
        i = runEnd;
        continue;
      }
      // Both-type with o=true: stop scanning entirely (no match).
      if (fl === 3 && o) return null;
      // Rule of 3 applies to both-type candidates, or when R is true.
      if (fl === 3 || R) {
        if (y % 3 !== 0 && (y + b) % 3 === 0) {
          f += b;
          prevEnd = runEnd;
          i = runEnd;
          continue;
        }
      }
      // Use as closer.
      m -= b;
      if (m > 0) {
        prevEnd = runEnd;
        i = runEnd;
        continue;
      }
      const used = Math.min(b, b + m + f);
      const take = Math.min(k, used);
      const tag = take % 2 === 1 ? 'em' : 'strong';
      const strip = take % 2 === 1 ? 1 : 2;
      return {
        start: pos,
        end: i + used,
        tag,
        contentStart: pos + strip,
        contentEnd: i + used - strip,
      };
    }
    return null;
  }

  // Forward-scan strikethrough. Like emphasis, but the closer run length
  // must equal the opener length and there is no rule of 3.
  findDel(masked, text, pos) {
    const n = masked.length;
    let k = 0;
    while (pos + k < n && text[pos + k] === '~') k++;
    if (k === 0) return null;
    // Strikethrough uses 1-2 tildes only; a longer run is not an opener.
    if (k > 2) return null;
    let runStart = pos;
    while (runStart > 0 && text[runStart - 1] === '~') runStart--;
    const o = runStart < pos;
    const after = pos + k < n ? text[pos + k] : '';
    if (after === '' || isSpace(after) || after === '~') return null;
    const before = pos > 0 ? text[pos - 1] : '';
    if (isPunct(after) && before !== '' && !isPunct(before) && !isSpace(before)) {
      return null;
    }
    let m = k;
    let i = pos + k;
    while (i < n) {
      while (i < n && masked[i] !== '~') i++;
      if (i >= n) break;
      let b = 0;
      while (i + b < n && masked[i + b] === '~') b++;
      const runEnd = i + b;
      // Closer length must equal opener length.
      if (b !== k) {
        i = runEnd;
        continue;
      }
      const fl = InlineParser.flank(masked, i, runEnd);
      if (fl === 0) {
        i = runEnd;
        continue;
      }
      if (fl === 1) {
        m += b;
        i = runEnd;
        continue;
      }
      if (fl === 3 && o) return null;
      m -= b;
      if (m > 0) {
        i = runEnd;
        continue;
      }
      return {
        start: pos,
        end: runEnd,
        tag: 'del',
        contentStart: pos + k,
        contentEnd: i,
      };
    }
    return null;
  }

  // Extended autolink (scheme URL, www., or email) starting at pos.
  // Only when not inside an <a>. Returns { end, html } or null.
  matchExtendedAutolink(text, pos) {
    if (this.inLink) return null;
    const before = pos > 0 ? text[pos - 1] : '';
    const rest = text.slice(pos);
    // mailto: / xmpp: bare URLs. Tried before the bare email so the
    // scheme is part of the link.
    if (text[pos] === 'm' || text[pos] === 'x') {
      const m = MAILTO_XMPP_RE.exec(rest);
      if (m) {
        const url = m[0];
        const href = cleanUrl(url);
        if (href === null) return null;
        const esc = escapeCode(url);
        return {
          end: pos + url.length,
          html: '<a href="' + escapeCode(href) + '">' + esc + '</a>',
        };
      }
    }
    // Bare scheme URL (http/https/ftp only). No preceding-char
    // restriction (the '://' makes it unambiguous).
    if (text[pos] === 'h' || text[pos] === 'H' || text[pos] === 'f' || text[pos] === 'F') {
      const m = SCHEME_URL_RE.exec(rest);
      if (m) {
        let url = m[0];
        let prev;
        do {
          prev = url;
          const b = BACKPEDAL_RE.exec(url);
          url = b ? b[0] : '';
        } while (url !== prev);
        // A bare scheme + '://' with no domain is not a URL.
        if (url !== '' && !/^(?:https?|ftp):\/\/*$/i.test(url)) {
          const href = cleanUrl(url);
          if (href === null) return null;
          const esc = escapeCode(url);
          return {
            end: pos + url.length,
            html: '<a href="' + escapeCode(href) + '">' + esc + '</a>',
          };
        }
      }
    }
    // www.: the preceding char must not be alphanumeric, '.', '/' or '-'.
    // ('_' is allowed.)
    if (
      text[pos] === 'w' &&
      (before === '' ||
        (!isAlnum(before) &&
          before !== '.' &&
          before !== '/' &&
          before !== '-'))
    ) {
      const m = WWW_RE.exec(rest);
      if (m) {
        let url = m[0];
        let prev;
        do {
          prev = url;
          const b = BACKPEDAL_RE.exec(url);
          url = b ? b[0] : '';
        } while (url !== prev);
        if (url !== '' && url !== 'www.') {
          const href = cleanUrl('http://' + url);
          if (href === null) return null;
          const label = escapeCode(url);
          return {
            end: pos + url.length,
            html: '<a href="' + escapeCode(href) + '">' + label + '</a>',
          };
        }
      }
    }
    // Email: the preceding char must not be an email local-part char
    // (the local part is greedy).
    if (
      before === '' ||
      !/[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(before)
    ) {
      const m = EMAIL_RE.exec(rest);
      if (m) {
        const email = m[0];
        const href = cleanUrl('mailto:' + email);
        if (href === null) return null;
        const esc = escapeCode(email);
        return {
          end: pos + email.length,
          html: '<a href="' + escapeCode(href) + '">' + esc + '</a>',
        };
      }
    }
    return null;
  }

  // Emit HTML for text[start..end), using the prebuilt mask and segments.
  emit(text, masked, segs, start, end) {
    const out = [];
    let i = start;
    let textStart = start;
    // No '@' in this span means no email autolink is possible: skip the
    // per-char maybeEmailStart gate entirely.
    const hasAt = text.indexOf('@', start) !== -1 && text.indexOf('@', start) < end;
    const flushText = (upto) => {
      if (upto <= textStart) return;
      const raw = text.slice(textStart, upto);
      if (this.inRawBlock) {
        out.push(raw);
      } else {
        out.push(escapeText(decodeNumericRefs(raw)));
      }
      textStart = upto;
    };
    while (i < end) {
      const seg = segs.get(i);
      if (seg) {
        flushText(i);
        if (seg.kind === 'html') {
          this.updateTagState(seg.html);
          out.push(seg.html);
        } else if (seg.kind === 'code' || seg.kind === 'autolink') {
          out.push(seg.html);
        } else if (seg.kind === 'image') {
          out.push(this.renderImage(text, seg));
        } else {
          out.push(this.renderLink(text, seg));
        }
        i = seg.end;
        textStart = i;
        continue;
      }
      const c = text[i];
      if (c === '\\' && i + 1 < end) {
        const nx = text[i + 1];
        if (nx === '\n') {
          flushText(i);
          out.push('<br>');
          i += 2;
          // Leading whitespace on the line after a hard break is
          // stripped.
          while (i < end && (text[i] === ' ' || text[i] === '\t')) i++;
          textStart = i;
          continue;
        }
        if (ASCII_PUNCT.has(nx)) {
          flushText(i);
          out.push(escapeText(nx));
          i += 2;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      if (c === '\n') {
        // Hard break: 2+ spaces before the newline.
        let j = i - 1;
        let spaces = 0;
        while (j >= textStart && text[j] === ' ') {
          spaces++;
          j--;
        }
        if (spaces >= 2) {
          flushText(i - spaces);
          out.push('<br>');
          i++;
          // Leading whitespace on the line after a hard break is
          // stripped.
          while (i < end && (text[i] === ' ' || text[i] === '\t')) i++;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      if (c === '*' || c === '_') {
        const em = this.findEmphasis(masked, text, i, c);
        if (em) {
          flushText(i);
          const inner = this.render(
            text.slice(em.contentStart, em.contentEnd),
            false
          );
          out.push('<' + em.tag + '>' + inner + '</' + em.tag + '>');
          i = em.end;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      if (c === '~') {
        const del = this.findDel(masked, text, i);
        if (del) {
          flushText(i);
          const inner = this.render(
            text.slice(del.contentStart, del.contentEnd),
            false
          );
          out.push('<del>' + inner + '</del>');
          i = del.end;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      if (c === 'w' && !this.inLink) {
        const auto = this.matchExtendedAutolink(text, i);
        if (auto) {
          flushText(i);
          out.push(auto.html);
          i = auto.end;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      if (
        (c === 'h' || c === 'H' || c === 'f' || c === 'F') &&
        !this.inLink
      ) {
        const auto = this.matchExtendedAutolink(text, i);
        if (auto) {
          flushText(i);
          out.push(auto.html);
          i = auto.end;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      if ((c === 'm' || c === 'x') && !this.inLink) {
        const auto = this.matchExtendedAutolink(text, i);
        if (auto) {
          flushText(i);
          out.push(auto.html);
          i = auto.end;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      if (hasAt && !this.inLink && this.maybeEmailStart(text, i)) {
        const auto = this.matchExtendedAutolink(text, i);
        if (auto) {
          flushText(i);
          out.push(auto.html);
          i = auto.end;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      i++;
    }
    flushText(end);
    return out.join('');
  }

  // Cheap gate for email autolinks: current char can start a local part,
  // is at a word boundary, and an '@' follows before any whitespace.
  maybeEmailStart(text, i) {
    const c = text[i];
    if (!EMAIL_LOCAL_CHARS.has(c)) return false;
    const before = i > 0 ? text[i - 1] : '';
    if (before !== '' && EMAIL_LOCAL_CHARS.has(before)) {
      return false;
    }
    const at = text.indexOf('@', i);
    if (at === -1) return false;
    for (let j = i; j < at; j++) {
      if (text[j] === ' ' || text[j] === '\n' || text[j] === '\t') return false;
    }
    return true;
  }

  // Update inLink / inRawBlock from an inline HTML tag's text.
  updateTagState(tag) {
    if (!this.inLink && /^<a /i.test(tag)) {
      this.inLink = true;
    } else if (this.inLink && /^<\/a>/i.test(tag)) {
      this.inLink = false;
    }
    if (
      !this.inRawBlock &&
      /^<(pre|code|kbd|script)(\s|>)/i.test(tag)
    ) {
      this.inRawBlock = true;
    } else if (
      this.inRawBlock &&
      /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)
    ) {
      this.inRawBlock = false;
    }
  }

  // Render a link segment. Handles the label-contains-link state dance
  // and the cleanUrl-failure fallback (label only, no <a>).
  renderLink(text, seg) {
    const labelText = text.slice(seg.labelStart, seg.labelEnd);
    const savedInLink = this.inLink;
    const savedEmitted = this.linkEmitted;
    const savedRaw = this.inRawBlock;
    this.inLink = true;
    this.linkEmitted = false;
    const labelHtml = this.render(labelText, false);
    const nested = this.linkEmitted;
    this.linkEmitted = savedEmitted;
    this.inLink = savedInLink;
    if (nested) {
      // Should not happen (mask-time check), but stay safe: render the
      // whole source span as inline content.
      this.inRawBlock = savedRaw;
      return this.render(text.slice(seg.start, seg.end), false);
    }
    const href = cleanUrl(decodeNumericRefs(seg.href));
    if (href === null) {
      return labelHtml;
    }
    this.linkEmitted = true;
    let out = '<a href="' + escapeText(href) + '"';
    if (seg.title !== null && seg.title !== '') {
      out += ' title="' + escapeText(decodeNumericRefs(seg.title)) + '"';
    }
    return out + '>' + labelHtml + '</a>';
  }

  // Render an image segment.
  renderImage(text, seg) {
    const labelText = text.slice(seg.labelStart, seg.labelEnd);
    const savedInLink = this.inLink;
    const savedEmitted = this.linkEmitted;
    this.inLink = true;
    this.linkEmitted = false;
    const alt = this.plainText(labelText);
    this.linkEmitted = savedEmitted;
    this.inLink = savedInLink;
    const href = cleanUrl(decodeNumericRefs(seg.href));
    if (href === null) {
      return escapeText(alt);
    }
    let out = '<img src="' + escapeText(href) + '" alt="' + escapeText(alt) + '"';
    if (seg.title !== null && seg.title !== '') {
      out += ' title="' + escapeText(decodeNumericRefs(seg.title)) + '"';
    }
    return out + '>';
  }

  // Render a label as plain text (for image alt attributes): emphasis and
  // links flatten to their inner text, code spans yield raw content,
  // hard breaks yield nothing, HTML tags stay verbatim.
  plainText(labelText) {
    if (!labelText) return '';
    const sub = new InlineParser(this.refs);
    const { masked, segs } = sub.buildMask(labelText);
    const out = [];
    let i = 0;
    let textStart = 0;
    const n = labelText.length;
    const flush = (upto) => {
      if (upto <= textStart) return;
      out.push(decodeNumericRefs(labelText.slice(textStart, upto)));
      textStart = upto;
    };
    while (i < n) {
      const seg = segs.get(i);
      if (seg) {
        flush(i);
        if (seg.kind === 'html') {
          out.push(seg.html);
        } else if (seg.kind === 'code') {
          // Raw code content: strip the <code> wrapper we precomputed.
          out.push(seg.html.replace(/^<code>/, '').replace(/<\/code>$/, ''));
        } else if (seg.kind === 'autolink') {
          const inner = seg.html.replace(/^<a href="[^"]*">/, '').replace(/<\/a>$/, '');
          out.push(inner);
        } else {
          out.push(sub.plainText(labelText.slice(seg.labelStart, seg.labelEnd)));
        }
        i = seg.end;
        textStart = i;
        continue;
      }
      const c = labelText[i];
      if (c === '\\' && i + 1 < n) {
        const nx = labelText[i + 1];
        if (nx === '\n') {
          flush(i);
          i += 2;
          textStart = i;
          continue;
        }
        if (ASCII_PUNCT.has(nx)) {
          flush(i);
          out.push(nx);
          i += 2;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      if (c === '\n') {
        let j = i - 1;
        let spaces = 0;
        while (j >= textStart && labelText[j] === ' ') {
          spaces++;
          j--;
        }
        if (spaces >= 2) {
          flush(i - spaces);
          i++;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      if (c === '*' || c === '_') {
        const em = sub.findEmphasis(masked, labelText, i, c);
        if (em) {
          flush(i);
          out.push(
            sub.plainText(labelText.slice(em.contentStart, em.contentEnd))
          );
          i = em.end;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      if (c === '~') {
        const del = sub.findDel(masked, labelText, i);
        if (del) {
          flush(i);
          out.push(
            sub.plainText(labelText.slice(del.contentStart, del.contentEnd))
          );
          i = del.end;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      i++;
    }
    flush(n);
    return out.join('');
  }
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// A parsed line: the raw text plus precomputed indent info.
function lineIndent(line) {
  let i = 0;
  let col = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') {
      col++;
      i++;
    } else if (c === '\t') {
      col += 4 - (col % 4);
      i++;
    } else {
      break;
    }
  }
  return { indent: col, contentStart: i };
}

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

// Strip up to `n` columns of leading indent from a line. Tabs are
// expanded to spaces on absolute columns FIRST (CommonMark model), then
// `n` columns are removed; the remainder keeps its spaces.
function stripIndent(line, n) {
  if (n <= 0) return line;
  let col = 0;
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    const w = line[i] === ' ' ? 1 : 4 - (col % 4);
    if (col + w > n) {
      // n cuts into this whitespace char (a tab): the remainder is
      // spaces.
      return ' '.repeat(col + w - n) + line.slice(i + 1);
    }
    col += w;
    i++;
    if (col >= n) break;
  }
  return line.slice(i);
}

// Fence-indent stripping (backtick fences only): remove up to `n`
// leading whitespace CHARACTERS (a tab counts as one, never split
// into spaces). Verified by probe39/40: a tab at the start of a
// content line is removed whole when the fence indent is > 0.
function stripFenceIndent(line, n) {
  let i = 0;
  while (i < n && i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    i++;
  }
  return line.slice(i);
}

// Expand only the LEADING whitespace (spaces/tabs) of `s` to spaces,
// assuming `s` starts at column `startCol`. Tabs later in the string are
// left untouched.
function expandLeadingTabs(s, startCol) {
  let col = startCol;
  let i = 0;
  let out = '';
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === ' ') {
      out += ' ';
      col++;
    } else {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    }
    i++;
  }
  return out + s.slice(i);
}

class DocParser {
  constructor(src) {
    this.src = src;
    this.refs = new Map();
    this.inline = new InlineParser(this.refs);
  }

  render() {
    const lines = this.src.split('\n');
    const { blocks } = this.parseBlocks(lines, 0, lines.length, 0, false);
    return this.renderBlocks(blocks);
  }

  // Parse lines[start..end) at the given container level into block nodes.
  // Returns an array of nodes. Each node: { type, ... }.
  // `codeMerged` is an optional Set of line indices (relative to
  // `lines`) that the blockquote chunking already stripped 4 columns
  // from (code-merged lazy lines); they set prevCodeMerge so the
  // following normal line gets a blank line before it (gen7 doc-12).
  parseBlocks(lines, start, end, depth, inListItem, codeMerged = null) {
    const blocks = [];
    let i = start;
    // `inListItem` is dynamic: marked's lexer `state.top` starts false
    // inside a list item (text tokens, code-merge applies), but a nested
    // LIST flips it to true (paragraph regex, no code-merge) for the
    // rest of the item (a nested blockquote saves/restores it, so it
    // does not flip). Probe61.
    let top = !inListItem;
    // Current open paragraph's lines (null when not in a paragraph).
    let para = null;
    // Looseness tracking: blankBetween is true when a blank line falls
    // between two top-level blocks of this parse (used for list
    // looseness; blank lines inside nested blocks do not count).
    let pendingBlank = false;
    let blankBetween = false;
    const pushBlock = (node) => {
      if (pendingBlank) blankBetween = true;
      pendingBlank = false;
      blocks.push(node);
    };
    const closePara = (keepTrailing) => {
      if (para) {
        // A paragraph ending in a code-merged line keeps a trailing
        // '\n' when a new block closes it, or when a blank line closes
        // a text-token paragraph (top=false: the code token's text
        // ends with '\n' and the text-token merge keeps it; t122).
        // End-of-parse drops it (the last item's text is trimEnd'd).
        if (keepTrailing && para.prevCodeMerge) para.lines.push('');
        const hadLines = para.lines.length > 0;
        const node = this.finishParagraph(para);
        if (node) pushBlock(node);
        else if (hadLines && pendingBlank) {
          // A defs-only paragraph after a blank line still counts as
          // content after the blank line (marked emits a def token).
          blankBetween = true;
          pendingBlank = false;
        }
        para = null;
      }
    };

    while (i < end) {
      const rawLine = lines[i];
      if (isBlankLine(rawLine)) {
        // A whitespace-only line at the very end of the source (no
        // trailing newline) is paragraph content, not a separator —
        // but only when state.top is true (paragraph regex: the
        // '[ \t]+\n' exclusion needs a following newline). With
        // top=false the space tokenizer claims it (doc-26/28 vs
        // gen2 doc-17).
        if (rawLine.length > 0 && i === end - 1 && para && top) {
          para.lines.push(rawLine);
          i++;
          continue;
        }
        // A blank line closes a code-merged paragraph keeping the
        // trailing '\n' ONLY if no more blocks follow in this parse
        // (the code token's text ends with '\n' when the item text
        // ends there; when a block follows, the code regex does not
        // consume the trailing newline — t125 vs gen7 doc-20).
        let moreAfter = false;
        for (let t = i + 1; t < end; t++) {
          if (!isBlankLine(lines[t])) { moreAfter = true; break; }
        }
        closePara(!moreAfter);
        if (blocks.length > 0) pendingBlank = true;
        i++;
        continue;
      }
      const { indent, contentStart } = lineIndent(rawLine);
      const content = rawLine.slice(contentStart);

      // Fenced code (``` or ~~~), up to 3 spaces indent.
      if (indent <= 3) {
        const fence = this.matchFence(content);
        if (fence) {
          closePara(true);
          const { node, next } = this.parseFencedCode(lines, i, end, fence, depth);
          pushBlock(node);
          i = next;
          continue;
        }
      }

      // ATX heading.
      if (indent <= 3) {
        const atx = this.matchATX(content);
        if (atx) {
          closePara(true);
          pushBlock(atx);
          i++;
          continue;
        }
      }

      // HTML block (types 1-6 can interrupt a paragraph; type 7 cannot).
      if (indent <= 3) {
        const html = this.matchHtmlBlock(lines, i, end, !!para);
        if (html) {
          closePara(true);
          pushBlock(html.node);
          i = html.next;
          continue;
        }
      }

      // Setext heading underline (only inside a paragraph). Checked before
      // the thematic break: '---' under a paragraph is a heading, not an
      // hr. Definitions are extracted first: a paragraph that is only defs
      // has no text to promote, so the underline line is re-processed.
      if (para && indent <= 3) {
        const setext = this.matchSetext(content);
        if (setext) {
          const remaining = this.extractDefs(para.lines);
          para = null;
          if (remaining.length > 0) {
            pushBlock({
              type: 'heading',
              level: setext,
              text: remaining.join('\n').trim(),
            });
            i++;
            continue;
          }
          // Only defs: fall through and re-process this line.
        }
      }

      // Thematic break.
      if (indent <= 3 && this.matchHR(content)) {
        closePara(true);
        pushBlock({ type: 'hr' });
        i++;
        continue;
      }

      // Blockquote.
      if (indent <= 3 && content.startsWith('>')) {
        closePara(true);
        const { node, next } = this.parseBlockquote(lines, i, end, depth);
        pushBlock(node);
        i = next;
        continue;
      }

      // List. An empty item (marker only, no content) cannot interrupt
      // a paragraph. Inside a list item, an ordered list may start
      // with any number (the text there is a 'text' token, not a
      // paragraph, and it ends before any list marker).
      if (indent <= 3) {
        const marker = this.matchListMarker(content, !!para && top);
        if (marker && !(para && marker.empty)) {
          closePara(true);
          const { node, next } = this.parseList(lines, i, end, depth, marker);
          pushBlock(node);
          // A nested list flips state.top to true for the rest of this
          // parse (marked's list tokenizer leaves top=true).
          top = true;
          i = next;
          continue;
        }
      }

      // Indented code (4+ spaces, cannot interrupt a paragraph).
      if (!para && indent >= 4) {
        const { node, next } = this.parseIndentedCode(lines, i, end);
        pushBlock(node);
        i = next;
        continue;
      }

      // Table (header + delimiter row). Detected at the block level so
      // the body can include tab-only lines (the table body terminator
      // is a spaces-only line, not a tab line — marked's table regex
      // uses ' *\n'). A table cannot interrupt a paragraph.
      if (!para) {
        const tbl = this.parseTable(lines, i, end);
        if (tbl) {
          pushBlock(tbl.node);
          i = tbl.next;
          continue;
        }
      }

      // Otherwise: paragraph line (lazy continuation is handled by the
      // caller for blockquotes/lists; at this level every text line
      // joins the paragraph). Inside a list item, a paragraph
      // continuation line indented by 4+ columns loses 4 columns
      // (marked lexes it as indented code and merges the stripped
      // content into the paragraph).
      if (!para) para = { type: 'paragraph', lines: [] };
      if (codeMerged && codeMerged.has(i) && para.lines.length > 0) {
        // Already stripped by the blockquote chunking; mark for the
        // blank-line rule (gen7 doc-12).
        para.lines.push(rawLine);
        para.prevCodeMerge = true;
      } else if (!top && para.lines.length > 0 && indent >= 4) {
        // Indented-code line merged into the paragraph (marked's code
        // token text ends with '\n'); a following normal line is
        // preceded by a blank line (probe54).
        para.lines.push(stripIndent(rawLine, 4));
        para.prevCodeMerge = true;
      } else {
        if (para.prevCodeMerge) para.lines.push('');
        para.lines.push(rawLine);
        para.prevCodeMerge = false;
      }
      i++;
    }
    closePara();
    return { blocks, blankBetween };
  }

  // Match a fence opener. Returns { char, len, info } or null.
  matchFence(content) {
    const c = content[0];
    if (c !== '`' && c !== '~') return null;
    let len = 0;
    while (content[len] === c) len++;
    if (len < 3) return null;
    const info = content.slice(len);
    // A backtick fence's info string may not contain backticks.
    if (c === '`' && info.indexOf('`') !== -1) return null;
    return { char: c, len, info: info.trim() };
  }

  parseFencedCode(lines, start, end, fence, depth) {
    const contentLines = [];
    // Backtick fences strip the opening fence's indent (0-3) from
    // content lines (cm-131/132/133). Tilde fences do NOT strip it
    // (marked quirk, verified by probe37/38).
    const fenceIndent =
      fence.char === '`' ? lineIndent(lines[start]).indent : 0;
    let i = start + 1;
    let closed = false;
    while (i < end) {
      // At the top level, the trailing phantom '' (from a final newline)
      // is not a line. Inside containers there is no phantom, so a
      // trailing '' there is a real blank content line.
      if (depth === 0 && i === end - 1 && lines[i] === '') break;
      const line = lines[i];
      const { indent, contentStart } = lineIndent(line);
      const content = line.slice(contentStart);
      if (indent <= 3 && content[0] === fence.char) {
        let len = 0;
        while (content[len] === fence.char) len++;
        if (len >= fence.len && content.slice(len).trim() === '') {
          closed = true;
          i++;
          break;
        }
      }
      contentLines.push(
        fenceIndent > 0 ? stripFenceIndent(line, fenceIndent) : line
      );
      i++;
    }
    let text = contentLines.join('\n');
    // The content ends with exactly one newline: the join already ends
    // with one when the last content line is blank.
    if (contentLines.length > 0 && contentLines[contentLines.length - 1] !== '') {
      text += '\n';
    }
    const rawLang = fence.info.split(/\s+/)[0] || '';
    const lang = InlineParser.unescapeBackslash(rawLang);
    return {
      node: { type: 'code', lang, text },
      next: i,
    };
  }

  matchATX(content) {
    let level = 0;
    while (content[level] === '#') level++;
    if (level === 0 || level > 6) return null;
    const rest = content.slice(level);
    if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
    // Strip trailing spaces, then a trailing closing sequence of #s
    // (preceded by a space — the space after the opening hashes counts),
    // then trim.
    const text = rest.replace(/ +$/, '').replace(/ +#+$/, '').trim();
    return { type: 'heading', level, text };
  }

  matchHR(content) {
    return /^(?:\*[ \t]*){3,}$/.test(content) ||
      /^(?:-[ \t]*){3,}$/.test(content) ||
      /^(?:_[ \t]*){3,}$/.test(content);
  }

  matchSetext(content) {
    if (/^=+[ \t]*$/.test(content)) return 1;
    if (/^-+[ \t]*$/.test(content)) return 2;
    return 0;
  }

  parseIndentedCode(lines, start, end) {
    const contentLines = [];
    let i = start;
    let lastNonBlank = -1;
    while (i < end) {
      const line = lines[i];
      if (isBlankLine(line)) {
        // A blank line may belong to the code block if a following
        // indented line continues it.
        let j = i + 1;
        let continues = false;
        while (j < end) {
          if (isBlankLine(lines[j])) {
            j++;
            continue;
          }
          continues = lineIndent(lines[j]).indent >= 4;
          break;
        }
        if (!continues) break;
        // A blank line inside the code block keeps its spaces beyond
        // the 4-column code indent.
        contentLines.push(stripIndent(line, 4));
        i++;
        continue;
      }
      const { indent } = lineIndent(line);
      if (indent < 4) break;
      contentLines.push(stripIndent(line, 4));
      lastNonBlank = contentLines.length - 1;
      i++;
    }
    // Drop trailing blank lines (they were only tentatively included).
    const kept = contentLines.slice(0, lastNonBlank + 1);
    const text = kept.length ? kept.join('\n') + '\n' : '';
    return { node: { type: 'code', lang: '', text }, next: i };
  }

  // Strip trailing blank lines per marked's ge(): if the text ends with 2+
  // blank lines, remove them all; a single trailing newline is kept.
  static stripTrailingBlanks(text) {
    const parts = text.split('\n');
    let t = parts.length - 1;
    while (t >= 0 && /^[ \t]*$/.test(parts[t])) t--;
    if (parts.length - t <= 2) return text;
    return parts.slice(0, t + 1).join('\n');
  }

  // Build an HTML block's text from lines i..closeLine, including the
  // following EMPTY lines only (marked's \n+ consumes newlines, not
  // whitespace-only lines: a '\t' line after --> is NOT part of the
  // raw text, so ge() keeps the single trailing newline). Types 6-7
  // pass includeWsBlanks=true: their regex consumes blank lines WITH
  // whitespace ((?:\n[ \t]*)+\n). next = closeLine + 1; the main loop
  // skips the blank lines.
  htmlBlockText(lines, i, end, closeLine, includeWsBlanks) {
    let k = closeLine + 1;
    while (
      k < end &&
      (lines[k] === '' || (includeWsBlanks && isBlankLine(lines[k])))
    ) {
      k++;
    }
    let raw = lines.slice(i, k).join('\n');
    if (k < end) raw += '\n';
    return {
      text: DocParser.stripTrailingBlanks(raw),
      next: closeLine + 1,
    };
  }

  // Find the first line at or after i (up to end) containing a match for
  // the given regex. Returns the line index, or -1.
  findLineMatching(lines, i, end, re) {
    for (let j = i; j < end; j++) {
      if (re.test(lines[j])) return j;
    }
    return -1;
  }

  // Match an HTML block starting at line i. inPara=true when a paragraph
  // is open (type 7 cannot interrupt). Returns { node, next } or null.
  // When `noType7` is true, type 7 (complete non-block tag) is not
  // matched — the table body terminator uses only types 1-6 (marked's
  // table regex html alternative is the block-tag pattern).
  matchHtmlBlock(lines, i, end, inPara, noType7) {
    const line = lines[i];
    const { indent, contentStart } = lineIndent(line);
    if (indent > 3) return null;
    const content = line.slice(contentStart);
    if (!content.startsWith('<')) return null;

    // Type 1: <pre|<script|<style|<textarea followed by whitespace or '>'.
    let m = /^<(pre|script|style|textarea)([\s>]|$)/i.exec(content);
    if (m) {
      const tag = m[1].toLowerCase();
      let closeLine = this.findLineMatching(
        lines, i, end, new RegExp('</' + tag + '>', 'i')
      );
      if (closeLine === -1) closeLine = end - 1;
      const { text, next } = this.htmlBlockText(lines, i, end, closeLine);
      return { node: { type: 'html', text }, next };
    }

    // Type 2: comment (may span lines; unterminated runs to end).
    if (content.startsWith('<!--')) {
      let closeLine = this.findLineMatching(lines, i, end, /-->/);
      if (closeLine === -1) closeLine = end - 1;
      const { text, next } = this.htmlBlockText(lines, i, end, closeLine);
      return { node: { type: 'html', text }, next };
    }

    // Type 3: processing instruction <?...?>.
    if (content.startsWith('<?')) {
      let closeLine = this.findLineMatching(lines, i, end, /\?>/);
      if (closeLine === -1) closeLine = end - 1;
      const { text, next } = this.htmlBlockText(lines, i, end, closeLine);
      return { node: { type: 'html', text }, next };
    }

    // Type 4: declaration <!A...>.
    if (/^<![A-Z]/i.test(content)) {
      let closeLine = this.findLineMatching(lines, i, end, />/);
      if (closeLine === -1) closeLine = end - 1;
      const { text, next } = this.htmlBlockText(lines, i, end, closeLine);
      return { node: { type: 'html', text }, next };
    }

    // Type 5: CDATA <![CDATA[...]]>.
    if (content.startsWith('<![CDATA[')) {
      let closeLine = this.findLineMatching(lines, i, end, /\]\]>/);
      if (closeLine === -1) closeLine = end - 1;
      const { text, next } = this.htmlBlockText(lines, i, end, closeLine);
      return { node: { type: 'html', text }, next };
    }

    // Type 6: block tag (open or close), followed by space/tab/newline,
    // '/>' or '>' or end of line. Runs until a blank line.
    m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(content);
    if (m && BLOCK_TAGS.has(m[1].toLowerCase())) {
      const after = content.slice(m[0].length);
      if (
        after === '' ||
        after[0] === ' ' ||
        after[0] === '\t' ||
        after[0] === '/' ||
        after[0] === '>'
      ) {
        return this.htmlBlockToBlank(lines, i, end);
      }
    }

    // Type 7: complete open or close tag alone on the line (plus spaces).
    // Cannot interrupt a paragraph.
    if (!inPara && !noType7) {
      if (/^<[a-zA-Z][a-zA-Z0-9-]*(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)* *\/?> *$/.test(content)) {
        const tagName = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(content)[1].toLowerCase();
        if (!['pre', 'script', 'style', 'textarea'].includes(tagName)) {
          return this.htmlBlockToBlank(lines, i, end);
        }
      }
      if (/^<\/[a-zA-Z][a-zA-Z0-9-]* *> *$/.test(content)) {
        return this.htmlBlockToBlank(lines, i, end);
      }
    }
    return null;
  }

  // An HTML block that runs until a blank line (types 6 and 7).
  htmlBlockToBlank(lines, i, end) {
    let j = i;
    while (j < end && !isBlankLine(lines[j])) j++;
    const closeLine = j - 1;
    const { text, next } = this.htmlBlockText(lines, i, end, closeLine, true);
    return { node: { type: 'html', text }, next };
  }

  srcEndsWithNewline() {
    return this.src.endsWith('\n');
  }

  // Parse a blockquote starting at line i. Collects '>' lines plus lazy
  // continuation lines, strips the prefix, and parses the inner content.
  parseBlockquote(lines, i, end, depth) {
    const children = [];
    let inner = [];
    // True once the current chunk has a '>' line (a lazy line after
    // that starts a NEW chunk — marked's chunk loop breaks at the
    // first non-'>' line after a '>' line).
    let chunkHasGt = false;
    // True once the current chunk has a non-indented line (a lazy
    // line after that keeps its indent — it is part of the paragraph
    // regex match, not a code-merged line).
    let chunkHasNonIndented = false;
    // Inner lines of the last completed chunk (for the lazy-line gate
    // when the current chunk is empty).
    let prevInner = null;
    // True when lazy lines were absorbed into a LIST in this chunk
    // (no split happened): the next '>' line must flush the chunk
    // first, so the list absorbs only the lazy lines, not the '>'
    // lines (marked re-lexes the list with only the lazy lines; gen1
    // doc-05). A BLOCKQUOTE absorbs '>' lines too (re-lexed with
    // '>' stripped), so no flush is needed for it (cm-251).
    let chunkAbsorbedIntoList = false;
    // Indices into `inner` of lines the chunking code-merged (stripped
    // 4 columns from a lazy line); passed to parseBlocks so the
    // following normal line gets a blank line before it (gen7 doc-12).
    let chunkCodeMerged = new Set();
    let j = i;
    let inFence = null; // { char, len } while inside a fenced code block
    // Parse the current chunk and append its blocks to children
    // (merging a leading paragraph into a preceding paragraph).
    // Accepts pre-parsed blocks to avoid parsing twice (the inline
    // parser's inLink state would advance twice).
    const flushChunk = (preBlocks) => {
      if (inner.length === 0) return [];
      const blocks =
        preBlocks ||
        this.parseBlocks(inner, 0, inner.length, depth + 1, false, chunkCodeMerged).blocks;
      const chunkStartsBlank = isBlankLine(inner[0]);
      if (
        blocks.length > 0 &&
        children.length > 0 &&
        !chunkStartsBlank &&
        blocks[0].type === 'paragraph' &&
        children[children.length - 1].type === 'paragraph'
      ) {
        children[children.length - 1].text += '\n' + blocks[0].text;
        children.push(...blocks.slice(1));
      } else {
        children.push(...blocks);
      }
      prevInner = inner;
      inner = [];
      chunkHasGt = false;
      chunkHasNonIndented = false;
      chunkAbsorbedIntoList = false;
      chunkCodeMerged = new Set();
      return blocks;
    };
    while (j < end) {
      const line = lines[j];
      const { indent, contentStart } = lineIndent(line);
      const content = line.slice(contentStart);
      if (indent <= 3 && content.startsWith('>')) {
        // If lazy lines were absorbed into a list in this chunk,
        // flush it first: the '>' line starts a new chunk (the list
        // absorbs only the lazy lines, gen1 doc-05).
        if (chunkAbsorbedIntoList) flushChunk();
        // Strip '>' plus one optional column of whitespace. Tabs are
        // expanded on absolute columns first, so a tab after '>' is only
        // partly consumed.
        const afterGt = expandLeadingTabs(content.slice(1), indent + 1);
        const stripped = afterGt.startsWith(' ')
          ? afterGt.slice(1)
          : afterGt;
        inner.push(stripped);
        chunkHasGt = true;
        const { indent: sIndent } = lineIndent(stripped);
        if (sIndent < 4) chunkHasNonIndented = true;
        // Track fence state for lazy-continuation decisions.
        inFence = this.trackFence(stripped, inFence);
        j++;
        continue;
      }
      if (isBlankLine(line)) {
        // A blank line (with no '>') ends the blockquote.
        break;
      }
      // Lazy continuation: only if the inner content currently ends in a
      // paragraph line and this line does not start an interrupting block.
      // A lazy line after a '>' line starts a NEW chunk (marked's chunk
      // loop) — UNLESS the current chunk ends in a list, in which case
      // the lazy line is absorbed into the list (marked re-lexes the
      // list with the remaining lines; probe46). Leading indented lazy
      // lines in a chunk are code-merged (stripped 4 columns) into the
      // preceding paragraph, while a lazy line after a non-indented line
      // keeps its indent (it is part of the paragraph regex match). A
      // lazy line that looks like a setext underline is indented by 4
      // spaces so it stays paragraph text.
      const gateInner = inner.length > 0 ? inner : prevInner;
      if (
        !inFence &&
        gateInner &&
        this.innerEndsInParagraph(gateInner, 0, true) &&
        !this.startsInterrupt(content, indent, true)
      ) {
        if (chunkHasGt) {
          // A lazy line after a '>' line starts a new chunk — unless
          // the current chunk ends in a list or blockquote (then the
          // lazy line stays in this chunk: marked re-lexes the list /
          // blockquote with the remaining lines; probe46, cm-250/251).
          const savedInLink = this.inline.inLink;
          const savedInRawBlock = this.inline.inRawBlock;
          const blocks = this.parseBlocks(
            inner,
            0,
            inner.length,
            depth + 1,
            false,
            chunkCodeMerged,
          ).blocks;
          const lastType =
            blocks.length > 0 ? blocks[blocks.length - 1].type : null;
          // If the chunk ends in a blockquote/list, the lazy line is
          // absorbed only if that nested block itself ends in a
          // paragraph (a nested blockquote ending in a fence cannot
          // absorb it — the lazy line ends the OUTER blockquote too,
          // gen7 doc-30).
          const lastBlock =
            blocks.length > 0 ? blocks[blocks.length - 1] : null;
          const nestedEndsInPara =
            lastBlock && this.blockEndsInParagraph(lastBlock);
          if (
            (lastType === 'list' || lastType === 'blockquote') &&
            nestedEndsInPara
          ) {
            // Do not split; the lazy line joins this chunk. Restore
            // the inline state (the chunk is re-parsed at flush time;
            // refdefs are first-wins so re-extraction is safe).
            this.inline.inLink = savedInLink;
            this.inline.inRawBlock = savedInRawBlock;
            chunkHasGt = false;
            if (lastType === 'list') chunkAbsorbedIntoList = true;
          } else if (
            (lastType === 'list' || lastType === 'blockquote') &&
            !nestedEndsInPara
          ) {
            // The nested block cannot absorb the lazy line: the
            // blockquote ends here (gen7 doc-30). Keep the speculative
            // parse's blocks (no re-parse).
            flushChunk(blocks);
            break;
          } else {
            // Keep the speculative parse's inline state (the blocks
            // are used as-is, no re-parse).
            flushChunk(blocks);
            // After a chunk ending in code/heading/hr/html/table the
            // blockquote ENDS (marked's chunk loop breaks).
            if (
              lastType === 'code' ||
              lastType === 'heading' ||
              lastType === 'hr' ||
              lastType === 'html' ||
              lastType === 'table'
            ) {
              break;
            }
          }
        }
        // Compute the piece AFTER the split decision: the strip-4 rule
        // uses the NEW chunk's chunkHasNonIndented (false after a
        // split, so leading indented lazy lines are code-merged).
        let piece;
        let pieceCodeMerged = false;
        if (indent <= 3 && this.matchSetext(content)) {
          piece = '    ' + content;
        } else if (indent >= 4 && !chunkHasNonIndented) {
          piece = stripIndent(line, 4);
          pieceCodeMerged = true;
        } else {
          piece = line;
        }
        if (indent < 4) chunkHasNonIndented = true;
        // If the piece itself would start a block (e.g. cm-238's
        // `    - bar` strips to `- bar`, a list marker), EMBED it into
        // the last inner line (or, if this chunk is empty after a
        // split, into the previous chunk's paragraph child) so it
        // stays paragraph text. Otherwise push it as its own line so
        // list parsing can strip the item indent from it.
        const { indent: pIndent, contentStart: pCs } = lineIndent(piece);
        const pContent = piece.slice(pCs);
        if (this.startsInterrupt(pContent, pIndent)) {
          if (inner.length > 0) {
            inner[inner.length - 1] += '\n' + piece;
          } else if (
            children.length > 0 &&
            children[children.length - 1].type === 'paragraph'
          ) {
            children[children.length - 1].text += '\n' + piece;
          } else {
            inner.push(piece);
          }
        } else {
          if (pieceCodeMerged) chunkCodeMerged.add(inner.length);
          inner.push(piece);
        }
        j++;
        continue;
      }
      break;
    }
    flushChunk();
    // No trailing phantom: marked strips the trailing newline from the
    // blockquote's inner text.
    return { node: { type: 'blockquote', children }, next: j };
  }

  // Track fenced-code state while collecting blockquote lines.
  trackFence(stripped, inFence) {
    const { indent, contentStart } = lineIndent(stripped);
    const content = stripped.slice(contentStart);
    if (indent > 3) return inFence;
    if (inFence) {
      if (content[0] === inFence.char) {
        let len = 0;
        while (content[len] === inFence.char) len++;
        if (len >= inFence.len && content.slice(len).trim() === '') return null;
      }
      return inFence;
    }
    const fence = this.matchFence(content);
    if (fence) return { char: fence.char, len: fence.len };
    return null;
  }

  // Are the item lines currently inside a fenced code block? Scans
  // forward, stripping blockquote prefixes (a fence opened via `> ``` `
  // keeps later `> ...` lines as its content), and tracks fence
  // open/close. A lazy line cannot continue a fence (gen4 doc-10).
  endsInFence(lines) {
    let inFence = null;
    for (const raw of lines) {
      for (const seg of raw.split('\n')) {
        let line = seg;
        // Strip nested blockquote prefixes to reach the content.
        for (;;) {
          const { indent, contentStart } = lineIndent(line);
          const content = line.slice(contentStart);
          if (indent <= 3 && content.startsWith('>')) {
            const afterGt = expandLeadingTabs(content.slice(1), indent + 1);
            line = afterGt.startsWith(' ') ? afterGt.slice(1) : afterGt;
            continue;
          }
          break;
        }
        inFence = this.trackFence(line, inFence);
      }
    }
    return inFence !== null;
  }

  // Does a parsed block end in a paragraph (recursing into blockquotes
  // and lists)? Used to decide whether a lazy line can be absorbed
  // into a trailing blockquote/list (gen7 doc-30: a nested blockquote
  // ending in a fence cannot absorb it).
  blockEndsInParagraph(block) {
    if (!block) return false;
    if (block.type === 'paragraph') return true;
    if (block.type === 'blockquote') {
      const ch = block.children;
      return ch.length > 0 && this.blockEndsInParagraph(ch[ch.length - 1]);
    }
    if (block.type === 'list') {
      const items = block.items;
      if (items.length === 0) return false;
      const ch = items[items.length - 1].children;
      return ch.length > 0 && this.blockEndsInParagraph(ch[ch.length - 1]);
    }
    return false;
  }

  // Does the inner content (list of stripped lines) currently end in a
  // paragraph line? (Used for lazy continuation.) Nested '>' prefixes
  // and list markers are stripped before the check, so a lazy line can
  // reach a paragraph inside nested blockquotes/lists.
  // `allowIndentedContinuation`: in a blockquote chunk (no fence can be
  // open — the gate checks !inFence), an indented line after a paragraph
  // line is a paragraph continuation (a lazy line that kept its indent,
  // gen7 doc-05). In a list item this is unsafe (the lines may be fence
  // content, gen6 doc-25), so the list gate keeps the strict rule.
  innerEndsInParagraph(inner, stripR = 0, allowIndentedContinuation = false) {
    for (let k = inner.length - 1; k >= 0; k--) {
      let line = inner[k];
      if (isBlankLine(line)) return false;
      // Strip nested blockquote prefixes and list markers to reach the
      // innermost content.
      for (;;) {
        const { indent, contentStart } = lineIndent(line);
        const content = line.slice(contentStart);
        if (indent <= 3 && content.startsWith('>')) {
          const afterGt = expandLeadingTabs(content.slice(1), indent + 1);
          line = afterGt.startsWith(' ') ? afterGt.slice(1) : afterGt;
          continue;
        }
        if (indent <= 3) {
          const m = this.matchListMarker(content, false);
          if (m) {
            if (m.empty) return false; // an empty item has no paragraph
            const afterMarker = expandLeadingTabs(
              content.slice(m.markerLen),
              indent + m.markerLen
            );
            line = afterMarker.slice(m.contentIndent - m.markerLen);
            continue;
          }
        }
        break;
      }
      if (isBlankLine(line)) return false;
      // A lazy line keeps its absolute indent in itemLines; measure the
      // indent relative to the item (stripR) before the indented-code
      // check, or a lazy line at indent 4 would wrongly end the
      // paragraph (gen3 doc-17).
      const { indent, contentStart } = lineIndent(line);
      const relIndent = Math.max(0, indent - stripR);
      const content = line.slice(contentStart);
      // A line that starts a block is not a paragraph line. The
      // block-start check uses the ABSOLUTE indent: a lazy line at
      // absolute indent 7 cannot start a list even though its relative
      // indent is 0 (gen7 doc-13: the `1)` lazy line is paragraph
      // text, not a list marker).
      if (indent <= 3) {
        if (this.matchATX(content)) return false;
        if (this.matchFence(content)) return false;
        if (this.matchHR(content)) return false;
        if (this.matchListMarker(content, true)) return false;
        if (this.matchSetext(content)) return false;
        if (/^<[^>]*>/.test(content) && this.matchHtmlBlock([line], 0, 1, true)) return false;
      }
      if (relIndent >= 4) {
        // Indented code — unless (blockquote chunks only) the preceding
        // line is itself a paragraph line, making this a paragraph
        // continuation (gen7 doc-05).
        if (allowIndentedContinuation && k > 0) {
          const prev = inner[k - 1];
          if (!isBlankLine(prev)) {
            let pLine = prev;
            for (;;) {
              const { indent: pi, contentStart: pcs } = lineIndent(pLine);
              const pContent = pLine.slice(pcs);
              if (pi <= 3 && pContent.startsWith('>')) {
                const afterGt = expandLeadingTabs(pContent.slice(1), pi + 1);
                pLine = afterGt.startsWith(' ') ? afterGt.slice(1) : afterGt;
                continue;
              }
              if (pi <= 3) {
                const m = this.matchListMarker(pContent, false);
                if (m) {
                  if (m.empty) break;
                  const afterMarker = expandLeadingTabs(
                    pContent.slice(m.markerLen),
                    pi + m.markerLen
                  );
                  pLine = afterMarker.slice(m.contentIndent - m.markerLen);
                  continue;
                }
              }
              break;
            }
            if (!isBlankLine(pLine)) {
              const { indent: pi, contentStart: pcs } = lineIndent(pLine);
              const pRel = Math.max(0, pi - stripR);
              const pContent = pLine.slice(pcs);
              const pBlockStart =
                pi <= 3 &&
                (this.matchATX(pContent) ||
                  this.matchFence(pContent) ||
                  this.matchHR(pContent) ||
                  this.matchListMarker(pContent, true) ||
                  this.matchSetext(pContent));
              if (!pBlockStart && pRel < 4) return true;
            }
          }
        }
        return false;
      }
      return true;
    }
    return false;
  }

  // Does this line start a block that can interrupt a paragraph?
  // Does the previous item line break lazy continuation? Marked's list
  // tokenizer breaks a lazy line when the PREVIOUS line starts a fence,
  // heading, HTML block, or HR (fencesBeginRegex is just `^ {0,a}(?:```|~~~)`
  // — no info validation, so a fence CONTENT line like ```inner``` also
  // breaks it; probe67). `lastSeg` is the last segment of the last item
  // line (after any embedded '\n').
  prevBreaksLazy(lastSeg) {
    const { indent, contentStart } = lineIndent(lastSeg);
    if (indent > 3) return false;
    const content = lastSeg.slice(contentStart);
    // Fence begin (loose: no info validation).
    if (content.startsWith('```') || content.startsWith('~~~')) return true;
    if (this.matchATX(content)) return true;
    if (this.matchHR(content)) return true;
    if (content.startsWith('<')) {
      if (/^<(pre|script|style|textarea)[\s>]/i.test(content)) return true;
      if (content.startsWith('<!--')) return true;
      if (content.startsWith('<?')) return true;
      if (/^<![A-Z]/i.test(content)) return true;
      if (content.startsWith('<![CDATA[')) return true;
      const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(content);
      if (m && BLOCK_TAGS.has(m[1].toLowerCase())) {
        const after = content.slice(m[0].length);
        if (after === '' || after[0] === ' ' || after[0] === '/' || after[0] === '>') return true;
      }
    }
    return false;
  }

  startsInterrupt(content, indent, anyList = false) {
    if (indent > 3) return false;
    if (this.matchATX(content)) return true;
    if (this.matchFence(content)) return true;
    if (this.matchHR(content)) return true;
    if (content.startsWith('>')) return true;
    // A blockquote lazy line that starts ANY ordered list (not just
    // start 1) ends the quote (gen8 doc-24, t134); a paragraph
    // continuation only breaks on start 1.
    if (this.matchListMarker(content, !anyList)) return true;
    // HTML block types 1-6 interrupt; type 7 does not.
    if (content.startsWith('<')) {
      if (/^<(pre|script|style|textarea)[\s>]/i.test(content)) return true;
      if (content.startsWith('<!--')) return true;
      if (content.startsWith('<?')) return true;
      if (/^<![A-Z]/i.test(content)) return true;
      if (content.startsWith('<![CDATA[')) return true;
      const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(content);
      if (m && BLOCK_TAGS.has(m[1].toLowerCase())) {
        const after = content.slice(m[0].length);
        // Note: marked's interruption test uses ' +' (spaces only), not tab.
        if (after === '' || after[0] === ' ' || after[0] === '/' || after[0] === '>') return true;
      }
    }
    return false;
  }

  // Match a list marker at the start of content (after indent ≤ 3).
  // inPara=true when a paragraph is open (ordered lists then need start 1).
  // Returns { ordered, start, delim, markerLen, contentIndent, empty } or null.
  matchListMarker(content, inPara) {
    const c = content[0];
    let markerLen = 0;
    let ordered = false;
    let start = 0;
    let delim = '';
    if (c === '*' || c === '-' || c === '+') {
      markerLen = 1;
    } else if (isDigit(c)) {
      let num = '';
      while (isDigit(content[num.length])) num += content[num.length];
      if (num.length > 9) return null;
      const d = content[num.length];
      if (d !== '.' && d !== ')') return null;
      ordered = true;
      start = parseInt(num, 10);
      delim = d;
      markerLen = num.length + 1;
      if (inPara && start !== 1) return null;
    } else {
      return null;
    }
    // After the marker: spaces/tabs, then content (or end of line).
    let i = markerLen;
    let spaces = 0;
    let col = markerLen;
    while (i < content.length && (content[i] === ' ' || content[i] === '\t')) {
      if (content[i] === ' ') {
        spaces++;
        col++;
      } else {
        const next = col + (4 - (col % 4));
        spaces += next - col;
        col = next;
      }
      i++;
    }
    const empty = i >= content.length;
    let contentIndent;
    if (empty) {
      contentIndent = markerLen + 1;
    } else if (spaces >= 5) {
      contentIndent = markerLen + 1;
    } else if (spaces === 0) {
      return null; // marker must be followed by whitespace
    } else {
      contentIndent = col;
    }
    return { ordered, start, delim, markerLen, contentIndent, empty };
  }

  // Parse a list starting at line i (firstMarker already matched).
  parseList(lines, i, end, depth, firstMarker) {
    const items = [];
    let j = i;
    let marker = firstMarker;
    let loose = false;
    let prevItemEndedBlank = false;
    // The first item's bullet character (for unordered lists).
    const firstBullet = lines[i].slice(lineIndent(lines[i]).contentStart)[0];
    while (j < end) {
      const line = lines[j];
      const { indent, contentStart } = lineIndent(line);
      const content = line.slice(contentStart);
      // A thematic break ends the list (it is not a list item).
      if (indent <= 3 && this.matchHR(content)) break;
      const m = indent <= 3 ? this.matchListMarker(content, false) : null;
      // A new item must match the list type (bullet char or ordered delim).
      if (
        !m ||
        m.ordered !== marker.ordered ||
        (!m.ordered && content[0] !== firstBullet) ||
        (m.ordered && m.delim !== marker.delim)
      ) {
        break;
      }
      if (prevItemEndedBlank) loose = true;
      // The item's content indent, absolute (line indent + relative).
      const absIndent = indent + m.contentIndent;
      // Collect this item's lines.
      const itemLines = [];
      const afterMarker = expandLeadingTabs(
        content.slice(m.markerLen),
        m.markerLen
      );
      const firstContent = afterMarker.slice(m.contentIndent - m.markerLen);
      itemLines.push(firstContent);
      let k = j + 1;
      let itemBlank = false;
      let endedBlank = false;
      // True when the last line appended was a lazy line (kept at its
      // absolute indent, not stripped by R). innerEndsInParagraph must
      // strip R only for lazy lines; indented continuations are already
      // stripped, and double-stripping would misread an indented-code
      // line as a paragraph line (gen3 doc-11).
      let lastWasLazy = false;
      // True when the last line/piece appended was a code-merged line
      // (indent >= 4 in a paragraph): the next content line is preceded
      // by a blank line inside the paragraph (marked's code token text
      // ends with '\n'; probe54).
      let prevCodeMerge = false;
      while (k < end) {
        const l2 = lines[k];
        if (isBlankLine(l2)) {
          // A blank line belongs to the item if a following line is
          // indented content or a new item marker.
          let t = k + 1;
          let belongs = false;
          let nextIsItem = false;
          while (t < end) {
            if (isBlankLine(lines[t])) {
              t++;
              continue;
            }
            const li = lineIndent(lines[t]);
            const ct = lines[t].slice(li.contentStart);
            if (li.indent >= absIndent) {
              // Indented content belongs to the current item (it may
              // be a nested list), not a new outer item.
              belongs = true;
            } else {
              const nm = li.indent <= 3 ? this.matchListMarker(ct, false) : null;
              if (
                nm &&
                nm.ordered === marker.ordered &&
                (nm.ordered ? nm.delim === marker.delim : ct[0] === firstBullet) &&
                !(li.indent <= 3 && this.matchHR(ct))
              ) {
                nextIsItem = true;
                belongs = true;
              }
            }
            break;
          }
          if (nextIsItem) {
            // The blank line separates items; the item ends here.
            // Marked appends the blank line's whitespace to the item
            // text (Z.slice(R)); when the item ends in a paragraph it
            // becomes trailing paragraph content ('commit!\n ' —
            // doc-17). Only non-last items keep it (the last item's
            // text is trimEnd'd), and nextIsItem implies non-last.
            // An empty blank line leaves nothing behind.
            if (l2.length > 0 && this.innerEndsInParagraph(itemLines, lastWasLazy ? absIndent : 0)) {
              const stripped = stripIndent(expandLeadingTabs(l2, 0), absIndent);
              itemLines.push(stripped.length > 0 ? stripped : '');
            } else {
              itemLines.push('');
            }
            itemBlank = true;
            endedBlank = true;
            prevCodeMerge = false;
            k = t;
            break;
          }
          // An empty item is closed by a blank line: no content after
          // it can join the item.
          if (!itemLines.some((x) => x.trim() !== '')) break;
          if (!belongs) break;
          itemLines.push('');
          itemBlank = true;
          endedBlank = true;
          prevCodeMerge = false;
          k++;
          continue;
        }
        const li = lineIndent(l2);
        if (li.indent >= absIndent) {
          // Tabs are expanded to absolute columns before stripping
          // (marked expands via J in the list tokenizer); otherwise a
          // preserved tab would change width when re-parsed at col 0.
          // A code-merged lazy line before this continuation leaves a
          // blank line inside the paragraph: append '\n' to the last
          // item line so the paragraph join yields '\n\n'.
          if (prevCodeMerge && itemLines.length > 0) {
            itemLines[itemLines.length - 1] += '\n';
          }
          prevCodeMerge = false;
          itemLines.push(stripIndent(expandLeadingTabs(l2, 0), absIndent));
          lastWasLazy = false;
          endedBlank = false;
          k++;
          continue;
        }
        // Lazy paragraph continuation (not indented, not a new item).
        // Appended to the last item line so it can never be re-read as a
        // block start; a lazy line indented by 4+ columns loses 4 columns.
        // A lazy line that looks like a setext underline is indented by
        // 4 spaces so it stays paragraph text.
        const ct = l2.slice(li.contentStart);
        const nm = li.indent <= 3 ? this.matchListMarker(ct, false) : null;
        // A lazy line breaks when the previous item line starts a fence,
        // heading, HTML block, or HR (marked's lazy-break rule; probe67).
        const lastItemLine = itemLines[itemLines.length - 1] || '';
        const lastSeg = lastItemLine.slice(lastItemLine.lastIndexOf('\n') + 1);
        const prevBreaks = this.prevBreaksLazy(lastSeg);
        // Marked's continuation-loop break check uses the LOOSE fence
        // regex (^ {0,min(3,R-1)}(?:```|~~~), no info validation), so a
        // line like ```inner backticks``` breaks the item even though it
        // is not a valid fence (probe70). startsInterrupt uses the
        // strict matchFence, so check the loose form here too.
        const looseFence =
          li.indent <= Math.min(3, absIndent - 1) &&
          (ct.startsWith('```') || ct.startsWith('~~~'));
        if (!nm && !prevBreaks && !looseFence && !this.startsInterrupt(ct, li.indent) && this.innerEndsInParagraph(itemLines, lastWasLazy ? absIndent : 0)) {
          // A lazy line after a fence cannot continue the fence, but it
          // is still part of the item: push it as a SEPARATE line (not
          // embedded) so the item's block parse ends the blockquote at
          // it and reads it as a new paragraph (gen4 doc-10). Embedding
          // would put it inside the fence content.
          if (this.endsInFence(itemLines)) {
            itemLines.push(l2);
            lastWasLazy = true;
            prevCodeMerge = false;
            endedBlank = false;
            k++;
            continue;
          }
          // Lazy lines are pushed as SEPARATE lines (not embedded) with
          // their full indent: nested list parsing must be able to strip
          // its own content indent from each line (marked's list
          // tokenizer appends lazy lines as-is to the item text, and a
          // nested list strips R from them — gen3 doc-17: the `*` item
          // strips 2 from `    }`, giving `  }`). Embedding would hide
          // them from nested stripping, and stripping 4 here would
          // pre-empt the code-merge that parseBlocks performs (via
          // para.prevCodeMerge) when a paragraph continuation has
          // indent >= 4. A setext-looking line is still indented by 4
          // so it stays paragraph text.
          let piece;
          if (li.indent <= 3 && this.matchSetext(ct)) {
            piece = '    ' + ct;
          } else {
            piece = l2;
          }
          itemLines.push(piece);
          lastWasLazy = true;
          prevCodeMerge = false;
          endedBlank = false;
          k++;
          continue;
        }
        break;
      }
      // Trailing blank lines inside the item do not make it loose by
      // themselves (parseBlocks only sets blankBetween when a block
      // follows the blank), so they are kept: an HTML block at the end
      // of the item keeps a trailing '\n' from a following blank line
      // (marked's ge keeps <=1 trailing blank line; probe69).
      // A blank line between two top-level blocks of the item makes the
      // list loose (blank lines inside nested blocks do not count).
      const { blocks: children, blankBetween } = this.parseBlocks(itemLines, 0, itemLines.length, depth + 1, true);
      if (blankBetween) loose = true;
      items.push({ children });
      prevItemEndedBlank = endedBlank;
      j = k;
      // If the next line is a new item, continue the loop; matchListMarker
      // at the top re-validates.
      if (j < end) {
        const nl = lines[j];
        const ni = lineIndent(nl);
        const nc = nl.slice(ni.contentStart);
        if (ni.indent <= 3 && this.matchHR(nc)) break;
        const nm2 = ni.indent <= 3 ? this.matchListMarker(nc, false) : null;
        if (!nm2) break;
        // The next item must match the list type (ordered/delim/bullet).
        if (nm2.ordered !== firstMarker.ordered) break;
        if (!nm2.ordered && nc[0] !== firstBullet) break;
        if (nm2.ordered && nm2.delim !== firstMarker.delim) break;
        marker = nm2;
      }
    }
    const node = {
      type: 'list',
      ordered: firstMarker.ordered,
      start: firstMarker.ordered ? firstMarker.start : 0,
      tight: !loose,
      items,
    };
    return { node, next: j };
  }

  // Extract link reference definitions from the front of a paragraph's
  // lines. Records defs in this.refs (first wins). Returns the remaining
  // lines (after removing def lines).
  extractDefs(paraLines) {
    let text = paraLines.join('\n');
    let pos = 0;
    const n = text.length;
    for (;;) {
      const save = pos;
      // Up to 3 spaces indent.
      let indent = 0;
      while (pos < n && text[pos] === ' ' && indent < 3) {
        indent++;
        pos++;
      }
      if (pos >= n || text[pos] !== '[') {
        pos = save;
        break;
      }
      const label = this.inline.scanRefLabel(text, pos);
      if (!label || text[label.end] !== ':') {
        pos = save;
        break;
      }
      const labelText = text.slice(label.labelStart, label.labelEnd);
      if (labelText.trim() === '') {
        pos = save;
        break;
      }
      let p = label.end + 1;
      // Skip whitespace (at most one newline; no blank line).
      p = this.skipDefSpace(text, p);
      if (p === -1) {
        pos = save;
        break;
      }
      // Destination.
      let href = '';
      if (text[p] === '<') {
        let q = p + 1;
        let dest = '';
        let ok = false;
        while (q < n) {
          const ch = text[q];
          if (ch === '\n' || ch === '<') break;
          if (ch === '>') {
            ok = true;
            break;
          }
          if (ch === '\\' && q + 1 < n && ASCII_PUNCT.has(text[q + 1])) {
            dest += text[q + 1];
            q += 2;
            continue;
          }
          dest += ch;
          q++;
        }
        if (!ok) {
          pos = save;
          break;
        }
        href = dest;
        p = q + 1;
      } else {
        let q = p;
        let dest = '';
        let depth = 0;
        let ok = true;
        while (q < n) {
          const ch = text[q];
          if (ch === ' ' || ch === '\t' || ch === '\n') break;
          if (ch === '\\' && q + 1 < n && ASCII_PUNCT.has(text[q + 1])) {
            dest += text[q + 1];
            q += 2;
            continue;
          }
          if (ch === '(') {
            depth++;
            dest += ch;
            q++;
            continue;
          }
          if (ch === ')') {
            if (depth === 0) {
              ok = false;
              break;
            }
            depth--;
            dest += ch;
            q++;
            continue;
          }
          dest += ch;
          q++;
        }
        if (!ok || dest === '') {
          pos = save;
          break;
        }
        href = dest;
        p = q;
      }
      // Optional title. It must follow whitespace (a title quote glued
      // to the destination invalidates the definition). The title may be
      // on the next line. If the title parse fails (malformed title or
      // trailing junk after it), fall back to "no title": the definition
      // ends at the end of the destination's line.
      let title = null;
      let endPos = -1; // position just past the definition (at its '\n')
      const afterDest = p;
      // Where the destination's line ends (spaces/tabs, then '\n'/end).
      let lineEnd = afterDest;
      while (lineEnd < n && (text[lineEnd] === ' ' || text[lineEnd] === '\t')) lineEnd++;
      const destLineClean = lineEnd >= n || text[lineEnd] === '\n';
      // A title quote immediately after the destination (no whitespace)
      // invalidates the definition.
      if (
        afterDest < n &&
        (text[afterDest] === '"' ||
          text[afterDest] === "'" ||
          text[afterDest] === '(')
      ) {
        pos = save;
        break;
      }
      // Try to parse a title (same line, or the next line).
      let titleEnd = -1;
      let titleVal = null;
      {
        let t = afterDest;
        while (t < n && (text[t] === ' ' || text[t] === '\t')) t++;
        let qStart = -1;
        if (t < n && (text[t] === '"' || text[t] === "'" || text[t] === '(')) {
          qStart = t;
        } else if (t < n && text[t] === '\n') {
          let q = t + 1;
          while (q < n && (text[q] === ' ' || text[q] === '\t')) q++;
          if (
            q < n &&
            (text[q] === '"' || text[q] === "'" || text[q] === '(')
          ) {
            qStart = q;
          }
        }
        if (qStart !== -1) {
          const qch = text[qStart];
          const close = qch === '(' ? ')' : qch;
          let q = qStart + 1;
          let tval = '';
          let ok = false;
          while (q < n) {
            const ch = text[q];
            if (ch === '\\' && q + 1 < n && ASCII_PUNCT.has(text[q + 1])) {
              tval += text[q + 1];
              q += 2;
              continue;
            }
            if (ch === close) {
              ok = true;
              break;
            }
            if (ch === '\n') {
              let r2 = q + 1;
              while (r2 < n && (text[r2] === ' ' || text[r2] === '\t')) r2++;
              if (r2 < n && text[r2] === '\n') break;
            }
            tval += ch;
            q++;
          }
          if (ok) {
            // After the title: only spaces/tabs, then newline or end.
            let r2 = q + 1;
            while (r2 < n && (text[r2] === ' ' || text[r2] === '\t')) r2++;
            if (r2 >= n || text[r2] === '\n') {
              titleVal = tval;
              titleEnd = r2;
            }
          }
        }
      }
      if (titleVal !== null) {
        title = titleVal;
        endPos = titleEnd;
      } else if (destLineClean) {
        // No (valid) title: the definition ends at its own line.
        endPos = lineEnd;
      } else {
        pos = save;
        break;
      }
      // Consume through the newline.
      let r = endPos;
      if (r < n && text[r] === '\n') r++;
      const key = InlineParser.normLabel(labelText);
      if (!this.refs.has(key)) {
        this.refs.set(key, { href, title });
      }
      pos = r;
      // Continue: another definition may follow.
    }
    const remaining = text.slice(pos);
    if (remaining === '') return [];
    return remaining.split('\n');
  }

  // Skip spaces/tabs and at most one newline (no blank line). Returns the
  // new position, or -1 if a blank line (or end) blocks the way.
  skipDefSpace(text, p) {
    const n = text.length;
    while (p < n && (text[p] === ' ' || text[p] === '\t')) p++;
    if (p < n && text[p] === '\n') {
      p++;
      let q = p;
      while (q < n && (text[q] === ' ' || text[q] === '\t')) q++;
      if (q < n && text[q] === '\n') return -1; // blank line
      p = q;
    }
    return p;
  }

  // Finish a paragraph: extract refdefs, then try a table conversion.
  // Returns a node (paragraph/table) or null (paragraph was only defs).
  finishParagraph(para) {
    const lines = this.extractDefs(para.lines);
    if (lines.length === 0) return null;
    // Table? First line = header, second = delimiter row.
    if (lines.length >= 2) {
      const table = this.tryTable(lines);
      if (table) return table;
    }
    return { type: 'paragraph', text: lines.join('\n') };
  }

  // Split a table row on unescaped '|'. Returns cell strings, or null if
  // the row has no '|' and is a lone delimiter (handled by the caller).
  splitTableRow(line) {
    const cells = [];
    let cur = '';
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === '\\' && i + 1 < line.length && line[i + 1] === '|') {
        cur += '|';
        i += 2;
        continue;
      }
      if (c === '|') {
        cells.push(cur);
        cur = '';
        i++;
        continue;
      }
      cur += c;
      i++;
    }
    cells.push(cur);
    return cells;
  }

  // Parse a table starting at lines[i] (header) / lines[i+1]
  // (delimiter). Returns { node, next } or null. Body rows run until a
  // spaces-only line or a block start (hr/heading/blockquote/indented
  // code/fence/list/html); a tab-only line IS a body row.
  parseTable(lines, i, end) {
    if (i + 1 >= end) return null;
    const headerCells = this.splitTableRow(lines[i]);
    if (headerCells.length > 0 && headerCells[0].trim() === '') headerCells.shift();
    if (headerCells.length > 0 && headerCells[headerCells.length - 1].trim() === '') headerCells.pop();
    const nCols = headerCells.length;
    if (nCols === 0) return null;
    const delimCells = this.splitTableRow(lines[i + 1]);
    if (delimCells.length > 0 && delimCells[0].trim() === '') delimCells.shift();
    if (delimCells.length > 0 && delimCells[delimCells.length - 1].trim() === '') delimCells.pop();
    if (delimCells.length !== nCols) return null;
    const aligns = [];
    for (const cell of delimCells) {
      const t = cell.trim();
      if (!/^:?-+:?$/.test(t)) return null;
      if (t.startsWith(':') && t.endsWith(':')) aligns.push('center');
      else if (t.endsWith(':')) aligns.push('right');
      else if (t.startsWith(':')) aligns.push('left');
      else aligns.push(null);
    }
    if (lines[i + 1].indexOf(':') === -1 && lines[i + 1].indexOf('|') === -1) return null;
    const rows = [];
    let k = i + 2;
    while (k < end) {
      const line = lines[k];
      // Spaces-only (or empty) line ends the table; a tab line does not.
      if (/^ *$/.test(line)) break;
      const { indent, contentStart } = lineIndent(line);
      const content = line.slice(contentStart);
      if (indent <= 3 && this.matchHR(content)) break;
      if (indent <= 3 && this.matchATX(content)) break;
      if (indent <= 3 && content.startsWith('>')) break;
      if (indent >= 4 && content !== '') break;
      if (indent <= 3 && this.matchFence(content)) break;
      if (indent <= 3) {
        const m = this.matchListMarker(content, false);
        if (m && (!m.ordered || m.start === 1)) break;
      }
      if (indent <= 3 && this.matchHtmlBlock(lines, k, end, false, true)) break;
      const cells = this.splitTableRow(line);
      if (cells.length > 0 && cells[0].trim() === '') cells.shift();
      if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
      while (cells.length < nCols) cells.push('');
      rows.push(cells.slice(0, nCols).map((c) => c.trim()));
      k++;
    }
    return {
      node: {
        type: 'table',
        header: headerCells.map((c) => c.trim()),
        aligns,
        rows,
      },
      next: k,
    };
  }

  tryTable(lines) {
    const headerCells = this.splitTableRow(lines[0]);
    // Drop leading/trailing empty cells (outer pipes).
    if (headerCells.length > 0 && headerCells[0].trim() === '') headerCells.shift();
    if (headerCells.length > 0 && headerCells[headerCells.length - 1].trim() === '') headerCells.pop();
    const nCols = headerCells.length;
    if (nCols === 0) return null;
    const delimCells = this.splitTableRow(lines[1]);
    if (delimCells.length > 0 && delimCells[0].trim() === '') delimCells.shift();
    if (delimCells.length > 0 && delimCells[delimCells.length - 1].trim() === '') delimCells.pop();
    if (delimCells.length !== nCols) return null;
    const aligns = [];
    for (const cell of delimCells) {
      const t = cell.trim();
      if (!/^:?-+:?$/.test(t)) return null;
      if (t.startsWith(':') && t.endsWith(':')) aligns.push('center');
      else if (t.endsWith(':')) aligns.push('right');
      else if (t.startsWith(':')) aligns.push('left');
      else aligns.push(null);
    }
    // The delimiter row must contain a ':' or a '|' (else it is setext).
    if (lines[1].indexOf(':') === -1 && lines[1].indexOf('|') === -1) return null;
    const rows = [];
    for (let r = 2; r < lines.length; r++) {
      const cells = this.splitTableRow(lines[r]);
      if (cells.length > 0 && cells[0].trim() === '') cells.shift();
      if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
      while (cells.length < nCols) cells.push('');
      rows.push(cells.slice(0, nCols));
    }
    return {
      type: 'table',
      header: headerCells.map((c) => c.trim()),
      aligns,
      rows: rows.map((row) => row.map((c) => c.trim())),
    };
  }

  // Render a list of block nodes to HTML.
  renderBlocks(blocks) {
    let out = '';
    for (const b of blocks) {
      if (!b) continue;
      out += this.renderBlock(b);
    }
    return out;
  }

  renderBlock(b) {
    switch (b.type) {
      case 'paragraph': {
        return '<p>' + this.inline.render(b.text, true) + '</p>\n';
      }
      case 'heading': {
        return (
          '<h' + b.level + '>' +
          this.inline.render(b.text, true) +
          '</h' + b.level + '>\n'
        );
      }
      case 'code': {
        const cls = b.lang
          ? ' class="language-' + escapeText(b.lang) + '"'
          : '';
        return '<pre><code' + cls + '>' + escapeCode(b.text) + '</code></pre>\n';
      }
      case 'html': {
        return b.text;
      }
      case 'hr': {
        return '<hr>\n';
      }
      case 'blockquote': {
        return '<blockquote>\n' + this.renderBlocks(b.children) + '</blockquote>\n';
      }
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const start =
          b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
        let out = '<' + tag + start + '>\n';
        for (const item of b.items) {
          out += '<li>';
          out += this.renderListItem(item, b.tight);
          out += '</li>\n';
        }
        return out + '</' + tag + '>\n';
      }
      case 'table': {
        let out = '<table>\n<thead>\n<tr>\n';
        for (let c = 0; c < b.header.length; c++) {
          const align = b.aligns[c] ? ' align="' + b.aligns[c] + '"' : '';
          out +=
            '<th' + align + '>' +
            this.inline.render(b.header[c], true) +
            '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (b.rows.length > 0) {
          out += '<tbody>';
          for (const row of b.rows) {
            out += '<tr>\n';
            for (let c = 0; c < row.length; c++) {
              const align = b.aligns[c] ? ' align="' + b.aligns[c] + '"' : '';
              out +=
                '<td' + align + '>' +
                this.inline.render(row[c], true) +
                '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        return out + '</table>\n';
      }
      default:
        return '';
    }
  }

  // Render one list item's blocks. In a tight list, a lone paragraph is
  // rendered without <p> tags. Task-list checkboxes are handled here.
  renderListItem(item, tight) {
    const blocks = item.children;
    // Task list: first paragraph starting with [ ] / [x] / [X].
    let task = null;
    if (
      blocks.length > 0 &&
      blocks[0] &&
      blocks[0].type === 'paragraph'
    ) {
      const m = /^\[( |x|X)\][ \t]+/.exec(blocks[0].text);
      if (m) {
        task = m[1] !== ' ';
        blocks[0] = {
          type: 'paragraph',
          text: blocks[0].text.slice(m[0].length),
        };
      }
    }
    const checkbox =
      task === null
        ? ''
        : task
          ? '<input checked="" disabled="" type="checkbox">'
          : '<input disabled="" type="checkbox">';
    // The checkbox is followed by a single space when there is content.
    // It lives INSIDE the first paragraph (tight: bare text, loose: <p>).
    const prefix =
      checkbox !== '' &&
      blocks.length > 0 &&
      blocks[0] &&
      blocks[0].type === 'paragraph' &&
      blocks[0].text !== ''
        ? checkbox + ' '
        : checkbox;
    let out = '';
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      if (!b) continue;
      if (bi === 0 && task !== null && b.type === 'paragraph') {
        const inner = prefix + this.inline.render(b.text, true);
        if (tight) {
          out += inner;
        } else {
          out += '<p>' + inner + '</p>\n';
        }
      } else if (tight && b.type === 'paragraph') {
        out += this.inline.render(b.text, true);
      } else {
        out += this.renderBlock(b);
      }
    }
    return out;
  }
}
