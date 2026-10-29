// 用 pdf.js 把每一页画到 canvas 上：手机上也能看完整的多页 PDF（iOS 的内嵌 PDF 只显示第一页）
import * as pdfjs from '/vendor/pdfjs/build/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';
// 译文见 app.js 的 T()
const T = (key, vars) => {
  let s = (window.__T && window.__T[key]) || key;
  if (s.includes('|')) { const [one, other] = s.split('|'); s = vars && Number(vars.n) === 1 ? one : other; }
  return vars ? s.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all)) : s;
};

export async function mount(el) {
  const status = el.querySelector('.pdf-status');
  const doc = await pdfjs.getDocument({
    url: el.dataset.src,
    cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  }).promise;
  const first = await doc.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  status.textContent = T('{n} page|{n} pages', { n: doc.numPages });
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const box = document.createElement('div');
    box.className = 'pdf-page'; box.dataset.n = i;
    box.style.aspectRatio = `${vp1.width} / ${vp1.height}`;
    box.innerHTML = `<span class="pno">${i} / ${doc.numPages}</span>`;
    el.appendChild(box); pages.push(box);
  }
  const rendered = new Set();
  async function draw(box) {
    const n = Number(box.dataset.n); if (rendered.has(n)) return; rendered.add(n);
    const page = n === 1 ? first : await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    box.style.aspectRatio = `${base.width} / ${base.height}`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const scale = (box.clientWidth * dpr) / base.width;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    box.prepend(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  }
  const io = new IntersectionObserver(entries => {
    for (const en of entries) if (en.isIntersecting) draw(en.target).catch(err => {
      en.target.insertAdjacentHTML('afterbegin', `<p class="pdf-status">${T('This page failed to render: {msg}', { msg: String(err?.message || err).slice(0, 100).replace(/[<>&]/g, '') })}</p>`);
      window.mydashReport?.('pdf page: ' + (err?.message || err));
    });
  }, { rootMargin: '600px 0px' });
  pages.forEach(p => io.observe(p));
}
