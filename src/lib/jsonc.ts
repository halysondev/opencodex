/**
 * JSONC parse used by OpenCode's launcher and Kilo's managed writer.
 *
 * Strict JSON.parse runs first and untouched — the tolerant path is only
 * attempted when that throws, keeping well-formed configs away from the stripper.
 */

/**
 * Strip `//` and block comments outside string literals. Escape-aware so a quote inside
 * an escaped sequence cannot flip string state and expose config text to the stripper.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      // Newlines are preserved so JSON.parse error positions stay meaningful.
      if (ch === "\n") out += ch;
      else if (ch === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const escaped = text[i + 1];
        if (escaped !== undefined) { out += escaped; i++; }
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; out += ch; continue; }
    if (ch === "/" && next === "/") { inLine = true; i++; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i++; continue; }
    out += ch;
  }
  return out;
}

/** Drop commas that sit directly before `}` or `]`, ignoring string contents. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const escaped = text[i + 1];
        if (escaped !== undefined) { out += escaped; i++; }
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; out += ch; continue; }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Return JSON that `JSON.parse` will accept. Strict text is returned untouched;
 * comments and trailing commas are stripped only when the strict parse throws.
 */
export function canonicalizeJsonc(text: string): string {
  try {
    JSON.parse(text);
    return text;
  } catch {
    return stripTrailingCommas(stripJsonComments(text));
  }
}

/**
 * JSON with optional comments and trailing commas. Strict JSON.parse runs first
 * and untouched — the tolerant path is only attempted when that throws.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(canonicalizeJsonc(text));
}
