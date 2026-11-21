// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's reading of {text, header},
// {columns, rows, errors}, by the same written broken-row policy, but scans with indexOf jumps and string
// slices instead of one character at a time.
//
// The policy, as the reference reads it:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it one quote, and
//     each CRLF or lone CR inside it read as LF; what follows its closing quote, up to the next comma or line
//     break, is appended as it stands (quote_junk, when the field ends with characters appended); a quote that
//     never closes is a literal character, and the text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records after it (every
//     record when header is false), each padded with "" (short_row, with fields: its count) or cut (long_row,
//     with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every LF, CRLF and lone CR
//     inside a quoted field counted), row its record's index in rows (null for the header), in the order met.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value and how it ended.
  let fValue = '';
  let fEnded = END;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `initial` up to the next comma or line break: a CR not followed by LF is
  // dropped (stray_cr). Sets fValue and fEnded; the characters appended are fValue.length - initial.length.
  function readUnquoted(initial) {
    let pieces = null; // segments between stray CRs, once one is met: [initial, ...segments]
    let segStart = pos;
    for (;;) {
      let iC = text.indexOf(',', pos);
      if (iC < 0) iC = Infinity;
      let iN = text.indexOf('\n', pos);
      if (iN < 0) iN = Infinity;
      let iR = text.indexOf('\r', pos);
      if (iR < 0) iR = Infinity;
      const i = iC <= iN && iC <= iR ? iC : iN <= iR ? iN : iR;
      if (i === Infinity) {
        fValue = pieces ? (pieces.push(text.slice(segStart)), pieces.join('')) : initial + text.slice(segStart);
        pos = len;
        fEnded = END;
        return;
      }
      const c = text.charCodeAt(i);
      if (c === 44) {
        fValue = pieces ? (pieces.push(text.slice(segStart, i)), pieces.join('')) : initial + text.slice(segStart, i);
        pos = i + 1;
        fEnded = COMMA;
        return;
      }
      if (c === 10) {
        fValue = pieces ? (pieces.push(text.slice(segStart, i)), pieces.join('')) : initial + text.slice(segStart, i);
        pos = i + 1;
        line += 1;
        fEnded = LINE_BREAK;
        return;
      }
      // c is a CR: a CRLF ends the field, a lone CR is dropped.
      if (text.charCodeAt(i + 1) === 10) {
        fValue = pieces ? (pieces.push(text.slice(segStart, i)), pieces.join('')) : initial + text.slice(segStart, i);
        pos = i + 2;
        line += 1;
        fEnded = LINE_BREAK;
        return;
      }
      pushError('stray_cr');
      if (pieces) pieces.push(text.slice(segStart, i));
      else pieces = [initial, text.slice(segStart, i)];
      pos = i + 1;
      segStart = pos;
    }
  }

  // The text of a quoted segment text[a..b) as the reference reads it: each CR or CRLF becomes one LF, and
  // `line` advances past every LF, CRLF and lone CR in the segment.
  function quotedSegment(a, b) {
    let r = text.indexOf('\r', a);
    if (r < 0 || r >= b) {
      let n = text.indexOf('\n', a);
      while (n >= 0 && n < b) {
        line += 1;
        n = text.indexOf('\n', n + 1);
      }
      return text.slice(a, b);
    }
    const parts = [];
    let p = a;
    while (p < b) {
      let rr = text.indexOf('\r', p);
      if (rr < 0 || rr >= b) rr = Infinity;
      let nn = text.indexOf('\n', p);
      if (nn < 0 || nn >= b) nn = Infinity;
      if (rr === Infinity && nn === Infinity) {
        parts.push(text.slice(p, b));
        break;
      }
      if (nn < rr) {
        parts.push(text.slice(p, nn + 1));
        line += 1;
        p = nn + 1;
      } else {
        parts.push(text.slice(p, rr), '\n');
        line += 1;
        p = text.charCodeAt(rr + 1) === 10 ? rr + 2 : rr + 1;
      }
    }
    return parts.join('');
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue and fEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let segStart = open + 1;
    let i = segStart;
    let pieces = null; // transformed segments and unescaped quotes, once one is met
    for (;;) {
      if (i >= len) break;
      const q = text.indexOf('"', i);
      if (q < 0) break;
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote in the value, and the field goes on.
        if (pieces) pieces.push(quotedSegment(segStart, q), '"');
        else pieces = [quotedSegment(segStart, q), '"'];
        i = q + 2;
        segStart = i;
        continue;
      }
      // The closing quote is at q.
      const value = pieces ? (pieces.push(quotedSegment(segStart, q)), pieces.join('')) : quotedSegment(segStart, q);
      pos = q + 1;
      if (pos >= len) {
        fValue = value;
        fEnded = END;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value;
        fEnded = COMMA;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the next comma or line break.
      readUnquoted(value);
      if (fValue.length > value.length) pushError('quote_junk');
      return;
    }
    // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
    pos = open + 1;
    line = openLine;
    pushError('unterminated_quote');
    readUnquoted('"');
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
