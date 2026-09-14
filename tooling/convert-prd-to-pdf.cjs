const fs = require("fs");
const path = require("path");
const mammoth = require("C:/Users/dell/Desktop/shopapp/prd-tools/node_modules/mammoth");

const input = path.resolve(__dirname, "../docs/Audit_Bot_Current_State_PRD_2026-09-14.docx");
const tempDir = path.resolve(__dirname, "../tmp/pdfs");
const outputDir = path.resolve(__dirname, "../output/pdf");
fs.mkdirSync(tempDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

mammoth.convertToHtml({ path: input }).then(({ value, messages }) => {
  const css = `
    @page { size: A4; margin: 17mm 16mm 18mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #303030; font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.45; }
    h1 { color: #182a3a; font-size: 20pt; line-height: 1.2; margin: 20pt 0 9pt; break-after: avoid; }
    h2 { color: #008060; font-size: 15pt; line-height: 1.25; margin: 15pt 0 7pt; break-after: avoid; }
    h3 { color: #303030; font-size: 12.5pt; margin: 12pt 0 6pt; break-after: avoid; }
    p { margin: 0 0 7pt; }
    ul, ol { margin: 4pt 0 9pt 19pt; padding: 0; }
    li { margin: 0 0 3pt; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 8pt 0 13pt; break-inside: auto; }
    tr { break-inside: avoid; break-after: auto; }
    td, th { border: 1px solid #d2d5d8; padding: 6pt 7pt; vertical-align: top; overflow-wrap: anywhere; }
    tr:first-child td, th { background: #182a3a; color: white; font-weight: 700; }
    tr:nth-child(even) td { background: #f7f7f8; }
    table:has(tr:only-child) { width: 82%; margin-left: auto; margin-right: auto; }
    table:has(tr:only-child) td { background: #f1f7f5; color: #182a3a; text-align: center; font-weight: 600; padding: 8pt; }
    a { color: #005bd3; }
    strong { font-weight: 700; }
  `;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Audit Bot Current-State PRD</title><style>${css}</style></head><body>${value}</body></html>`;
  const htmlPath = path.join(tempDir, "Audit_Bot_Current_State_PRD_2026-09-14.html");
  fs.writeFileSync(htmlPath, html, "utf8");
  if (messages.length) console.log(messages.map((message) => message.message).join("\n"));
  console.log(htmlPath);
});
