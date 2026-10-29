// 生成测试用样例文件（不依赖任何个人文件）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as XLSX from 'xlsx';

const out = process.argv[2];
fs.mkdirSync(path.join(out, 'img'), { recursive: true });
fs.mkdirSync(path.join(out, 'shots'), { recursive: true });
fs.mkdirSync(path.join(out, 'site', 'assets'), { recursive: true });

// 最小 PNG 编码器：画一块渐变
function crc32(buf) { let c, crc = 0xffffffff; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h, f) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = f(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
fs.writeFileSync(path.join(out, 'img', 'chart.png'), png(480, 270, (x, y) => [184 - (x >> 3), 58 + (y >> 2), 43 + (x >> 2)]));
fs.writeFileSync(path.join(out, 'shots', 'home.png'), png(390, 780, (x, y) => [243 - (y >> 4), 239 - (x >> 4), 229]));
fs.writeFileSync(path.join(out, 'shots', 'detail.png'), png(390, 780, (x, y) => [47 + (y >> 4), 82 + (x >> 4), 119]));

// 最小可用 PDF（两页）
function pdf(pages) {
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  const fontId = 3 + pages.length * 2;
  pages.forEach((t, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    const s = `BT /F1 28 Tf 72 760 Td (${t}) Tj ET`;
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  });
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return body;
}
fs.writeFileSync(path.join(out, 'report.pdf'), pdf(['Page one: smoke test', 'Page two: still here']));

fs.writeFileSync(path.join(out, 'plan.md'), `---
status: draft
---
# 对战分析方案

这是一份**测试方案**，用来验证渲染。见 [附件 PDF](./report.pdf) 和 [另一份说明](notes.md)。

## 背景与目标

- [x] 渲染 Markdown
- [ ] 渲染 Mermaid

| 指标 | 现状 | 目标 |
|---|---:|---:|
| 句长标准差 | 10.1 | 18.5 |
| 译名命中率 | 62% | 82% |

![渐变图](img/chart.png "图表")

## 流程

\`\`\`mermaid
graph LR
  A[生成产物] --> B[mydash publish]
  B --> C{案头}
  C --> D[手机]
  C --> E[电脑]
\`\`\`

## 代码

\`\`\`ts
export function hello(name: string): string {
  return \`你好，\${name}\`;
}
\`\`\`

> 引用：先小样，后全量。

### 细节 A & B
最后一段。
`);
fs.writeFileSync(path.join(out, 'notes.md'), '# 另一份说明\n\n从方案里链接过来的文档。\n');

fs.writeFileSync(path.join(out, 'site', 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>原型页面</title><link rel="stylesheet" href="assets/style.css"></head>
<body><h1>原型页面</h1><p id="s">脚本未运行</p><script type="module" src="assets/app.js"></script></body></html>`);
fs.writeFileSync(path.join(out, 'site', 'assets', 'style.css'), 'body{font-family:sans-serif;background:#fff8e7;padding:24px}h1{color:#b83a2b}');
fs.writeFileSync(path.join(out, 'site', 'assets', 'app.js'), "localStorage.setItem('k','v'); document.getElementById('s').textContent = '模块脚本已运行，localStorage=' + localStorage.getItem('k');");

fs.writeFileSync(path.join(out, 'data-utf8.csv'), '城市,人口,增长\n伦敦,8900000,1.2%\n曼彻斯特,"553,230",0.8%\n');

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['项目', '状态', '数量'], ['website', '进行中', 12], ['mobile-app', '完成', 3]]), '汇总');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['明细'], ['第一行']]), '明细');
fs.writeFileSync(path.join(out, 'sheet.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

fs.writeFileSync(path.join(out, 'doc.html'), '<html><head><meta charset="utf-8"></head><body><h1>Word 文档标题</h1><p>这是 Word 文档里的正文。</p></body></html>');
fs.writeFileSync(path.join(out, 'config.yaml'), 'name: mydash\nport: 4870\nlist:\n  - a\n  - b\n');
console.log('fixtures ok');
