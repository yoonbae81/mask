function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(text: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

export interface InstructionDocument {
  title: string;
  html: string;
}

export function renderInstructionDocument(md: string): InstructionDocument {
  const lines = md.split("\n");
  const out: string[] = [];
  let list: "ol" | "ul" | null = null;
  let title = "";
  let titleTaken = false;

  function closeList(): void {
    if (list) {
      out.push(list === "ol" ? "</ol>" : "</ul>");
      list = null;
    }
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!titleTaken) {
      titleTaken = true;
      if (line.startsWith("# ")) {
        title = line.slice(2).replace(/<[^>]*>/g, "").replace(/[<>\r\n]/g, "").trim().slice(0, 100);
        continue;
      }
    }
    if (line.startsWith("# ")) {
      closeList();
      out.push(`<h1>${renderInline(line.slice(2).trim())}</h1>`);
    } else if (line.startsWith("## ")) {
      closeList();
      out.push(`<h2>${renderInline(line.slice(3).trim())}</h2>`);
    } else if (/^\d+\.\s/.test(line)) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${renderInline(line.replace(/^\d+\.\s/, ""))}</li>`);
    } else if (line.startsWith("- ")) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${renderInline(line.slice(2).trim())}</li>`);
    } else if (line.length === 0) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${renderInline(line)}</p>`);
    }
  }
  closeList();
  return { title, html: out.join("\n") };
}
