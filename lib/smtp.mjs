// 发一封纯文本邮件（推送用）。不引入依赖，只实现用得到的那部分 SMTP：
// secure：tls（465，一连上就是 TLS）· starttls（587，先明文再升级）· none（只用于本机测试）；登录用 AUTH PLAIN，不支持时退到 AUTH LOGIN。
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = s => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
const encWord = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export function buildMessage({ from, to, subject, text }) {
  const list = [].concat(to);
  return [
    `From: ${from}`, `To: ${list.join(', ')}`, `Subject: ${encWord(subject)}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@mydash>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
    '', wrap76(b64(text)), '',
  ].join('\r\n');
}

export async function sendMail({ host, port, secure = 'starttls', user = '', pass = '', from, to }, { subject, text }, { timeout = 20_000 } = {}) {
  const recipients = String(to).split(/[,;\s]+/).filter(Boolean);
  if (!host || !from || !recipients.length) throw new Error('host, from and to are required');
  port = Number(port) || (secure === 'tls' ? 465 : secure === 'none' ? 25 : 587);
  let sock; let buf = ''; let waiting = null; let failed = null;
  const onData = d => { buf += d.toString('utf8'); flush(); };
  const onErr = e => { failed = e; if (waiting) { const w = waiting; waiting = null; w.reject(e); } };
  function attach(s) { sock = s; s.on('data', onData); s.on('error', onErr); s.on('close', () => onErr(new Error('connection closed'))); }
  // 一条完整的回复：最后一行是 "xyz 文字"（中间行是 "xyz-文字"）
  function flush() {
    if (!waiting) return;
    const lines = buf.split('\r\n'); const done = lines.findIndex(l => /^\d{3}(?: |$)/.test(l));
    if (done < 0) return;
    const reply = lines.slice(0, done + 1); buf = lines.slice(done + 1).join('\r\n');
    const w = waiting; waiting = null; w.resolve({ code: Number(reply[done].slice(0, 3)), text: reply.join('\n') });
  }
  const read = () => new Promise((resolve, reject) => { if (failed) return reject(failed); waiting = { resolve, reject }; flush(); });
  async function cmd(line, ok) {
    if (line != null) sock.write(line + '\r\n');
    const r = await read();
    if (!ok.includes(r.code)) throw new Error(`SMTP ${line ? line.split(' ')[0] : 'greeting'}: ${r.text.slice(0, 300)}`);
    return r;
  }
  const timer = setTimeout(() => onErr(new Error('SMTP timed out')), timeout);
  try {
    await new Promise((resolve, reject) => {
      const s = secure === 'tls' ? tls.connect({ host, port, servername: host }, resolve) : net.connect({ host, port }, resolve);
      s.once('error', reject); attach(s);
    });
    await cmd(null, [220]);
    const name = os.hostname().replace(/[^\w.-]/g, '') || 'mydash';
    let ehlo = await cmd(`EHLO ${name}`, [250]);
    if (secure === 'starttls') {
      await cmd('STARTTLS', [220]);
      sock.removeListener('data', onData);
      await new Promise((resolve, reject) => { const s = tls.connect({ socket: sock, servername: host }, resolve); s.once('error', reject); attach(s); });
      ehlo = await cmd(`EHLO ${name}`, [250]);
    }
    if (user) {
      if (/AUTH[^\n]*\bPLAIN\b/i.test(ehlo.text) || !/AUTH[^\n]*\bLOGIN\b/i.test(ehlo.text)) await cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235]);
      else { await cmd('AUTH LOGIN', [334]); await cmd(b64(user), [334]); await cmd(b64(pass), [235]); }
    }
    const addr = s => (String(s).match(/<([^>]+)>/)?.[1] || String(s)).trim();
    await cmd(`MAIL FROM:<${addr(from)}>`, [250]);
    for (const r of recipients) await cmd(`RCPT TO:<${addr(r)}>`, [250, 251]);
    await cmd('DATA', [354]);
    await cmd(buildMessage({ from, to: recipients, subject, text }) + '\r\n.', [250]);
    sock.write('QUIT\r\n');
    return { ok: true };
  } finally { clearTimeout(timer); try { sock?.end(); } catch {} }
}
