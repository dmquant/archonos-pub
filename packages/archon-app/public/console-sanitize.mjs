// Console-side sanitisation for text that originates outside the operator:
// assistant output, workspace-file previews and mesh peer messages.
//
// `marked` passes raw HTML through by default, so the previous approach (strip
// <script> plus double-quoted on* handlers) could be bypassed with
// `<img src=x onerror=alert(1)>` or a single-quoted handler. This module is
// dependency-free and unit-tested; keep it that way so it can run both in the
// browser and under `node --test`.

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Single quotes matter: ~99 generated on* handlers interpolate values into
    // single-quoted JS arguments, where `&quot;` provides no protection.
    .replace(/'/g, '&#39;');
}

const EVENT_HANDLER_ATTR = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const SRCDOC_ATTR = /\ssrcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const URL_ATTR = /\b(href|src|action|formaction|xlink:href)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi;
const EXECUTABLE_TAG_BLOCK = /<\s*(script|iframe|object|embed|applet|style|template)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const EXECUTABLE_TAG = /<\s*\/?\s*(script|iframe|object|embed|applet|base|meta|link|style|template)\b[^>]*>/gi;
const HTML_BLOCK_COMMENT = /<!--[\s\S]*?-->/g;

function decodeForUrlCheck(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&colon;?/gi, ':')
    .replace(/&tab;?/gi, '\t')
    .replace(/&newline;?/gi, '\n')
    // Browsers ignore tabs/newlines inside a URL scheme.
    .replace(/[\u0000-\u0020\u007f]/g, '')
    .toLowerCase();
}

function isDangerousUrl(value) {
  const decoded = decodeForUrlCheck(value);
  return (
    decoded.startsWith('javascript:') ||
    decoded.startsWith('vbscript:') ||
    decoded.startsWith('data:text/html')
  );
}

export function sanitizeMarkdownHtml(html) {
  return String(html ?? '')
    .replace(HTML_BLOCK_COMMENT, '')
    .replace(EVENT_HANDLER_ATTR, '')
    .replace(SRCDOC_ATTR, '')
    .replace(URL_ATTR, (match, attr, eq, quoted) => {
      const inner = quoted.startsWith('"') || quoted.startsWith("'") ? quoted.slice(1, -1) : quoted;
      return isDangerousUrl(inner) ? `${attr}${eq}"#"` : match;
    })
    .replace(EXECUTABLE_TAG_BLOCK, '')
    .replace(EXECUTABLE_TAG, '');
}
