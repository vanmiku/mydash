#!/bin/bash
# Inside the office image: publish a Chinese .docx and check the PDF preview has the Chinese text.
set -u
cd "$(dirname "$0")/../.."
export MYDASH_HOME=/tmp/oh MYDASH_LANG=zh; mkdir -p /tmp/oh /tmp/doc
# 挂载进来的中文 docx（在 macOS 上用 LibreOffice 生成）：docker run -v <dir>:/in
cp /in/*.docx /tmp/doc/r.docx
ls -la /tmp/doc/r.docx | awk '{print "docx bytes:", $5}'
node bin/mydash.mjs publish /tmp/doc/r.docx -p office -s word --json > /tmp/w.json 2>/tmp/w.err; node -e "const j=require('/tmp/w.json');console.log('publish ok', j.ok, 'office previews', j.office, 'pdf pages', j.pdfPages, 'notes', JSON.stringify(j.notes))"; cat /tmp/w.err
PDF=$(ls /tmp/oh/data/office/word/v1/_preview/*.pdf 2>/dev/null | head -1); echo "preview: $PDF"
pdftotext "$PDF" - | head -5
pdffonts "$PDF" | tail -n +3 | awk '{print "font:", $1}'
