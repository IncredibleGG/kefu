/** 極簡 Markdown → HTML(僅 demo 用:粗體/斜體/行內碼/連結/換行/清單)。
 *  先做 HTML 轉義再套規則,避免 XSS。日後可換 marked + DOMPurify。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // 必須同時轉義引號:否則連結 URL 內的 " 可跳出 href 屬性注入 onmouseover 等事件處理器(XSS)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src).split(/\r?\n/);
  const html: string[] = [];
  let inList = false;
  for (const line of lines) {
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inline(li[1])}</li>`);
    } else {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      if (line.trim() === "") html.push("<br/>");
      else html.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) html.push("</ul>");
  return html.join("");
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    // URL 僅允許 http(s) 且不含空白/引號/角括號,雙重防止屬性跳脫注入。
    // 原生殼內 target=_blank 由 lib/platform 的全域連結攔截器改交系統瀏覽器開啟。
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"'<>]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
