// 防误发：agent 自动发布时，别把密钥、凭据发到工作台上。按文件名和内容特征拦下，确实要发加 --allow-secret。
import fs from 'node:fs';
import path from 'node:path';

const NAME_RULES = [
  [/^\.env(\.(?!example$|sample$|template$|dist$)[\w.-]+)?$/i, 'env file'],
  [/^id_(rsa|dsa|ecdsa|ed25519)$/, 'SSH private key'],
  [/\.(pem|p12|pfx|jks|keystore|kdbx|ppk)$/i, 'key or certificate store'],
  [/^(\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.dockercfg|credentials|credentials\.json|auth\.json|service-account.*\.json|secrets?\.(json|ya?ml|toml|env))$/i, 'credentials file'],
];
const DIR_RULES = [/(^|\/)\.ssh\//, /(^|\/)\.aws\//, /(^|\/)\.gnupg\//, /(^|\/)\.config\/gcloud\//, /(^|\/)\.kube\//, /(^|\/)\.docker\/config\.json$/,
  // mydash 自己的配置和状态：推送密码、远程令牌、局域网会话、网页推送私钥
  /(^|\/)\.mydash\/(config\.json$|state\/)/];
const CONTENT_RULES = [
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/, 'private key'],
  [/\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}/, 'Anthropic API key'],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b/, 'OpenAI API key'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'GitHub token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\b(?:sk|rk)_live_[0-9a-zA-Z]{24,}\b/, 'Stripe live key'],
];
const TEXTY = /\.(md|markdown|mdx|txt|log|json|jsonl|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|py|js|mjs|cjs|ts|tsx|jsx|rb|go|rs|java|kt|php|html?|xml|csv|tsv|sql|properties|tf|tfvars)$/i;

// entries: [{ src?, content?, dest }] → [{ file, reason }]
export function findSecrets(entries) {
  const hits = [];
  for (const e of entries) {
    const base = path.posix.basename(e.dest);
    // 按写的路径和真实路径都查一遍：符号链接（或链接进来的目录）指向 ~/.kube、~/.ssh 也要拦
    let real = ''; try { if (e.src) real = fs.realpathSync(e.src); } catch {}
    const wheres = [e.src || e.dest, real].filter(Boolean).map(p => p.split(path.sep).join('/'));
    const names = [base, real && path.basename(real)].filter(Boolean);
    let reason = NAME_RULES.find(([re]) => names.some(n => re.test(n)))?.[1] || (DIR_RULES.some(re => wheres.some(w => re.test(w))) ? 'file from a credentials folder' : null);
    if (!reason && (TEXTY.test(base) || !base.includes('.'))) {
      let text = '';
      try {
        if (e.content) text = e.content.subarray(0, 2 * 1024 * 1024).toString('utf8');
        else if (fs.statSync(e.src).size <= 2 * 1024 * 1024) text = fs.readFileSync(e.src, 'utf8');
      } catch {}
      reason = CONTENT_RULES.find(([re]) => re.test(text))?.[1] || null;
    }
    if (reason) hits.push({ file: e.dest, reason });
  }
  return hits;
}
