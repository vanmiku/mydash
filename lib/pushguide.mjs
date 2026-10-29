// 设置页「推送到手机」里每种渠道的设置教程：选了一种以后，表单下面有一行「怎么设置」，点开是一步步的说明。
// 文字都走 t()（中文在 lib/locales/zh.mjs），按页面语言显示。按钮、输入框的名字也用 t() 取，和页面上显示的一致。
// 注意：文字里不能有「|」，t() 会把它当成单复数两种写法。
import { t } from './i18n.mjs';

const a = (href, text = href.replace(/^https:\/\//, '')) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
const ol = items => `<ol class="set-steps">${items.map(x => `<li>${x}</li>`).join('')}</ol>`;
const tip = text => `<p class="set-tip">${text}</p>`;
const sec = (title, inner) => `<details class="set-gsec"><summary>${title}</summary>${inner}</details>`;
const wrap = inner => `<details class="set-guide"><summary>${t('How to set it up, step by step')}</summary><div class="set-guide-body">${inner}</div></details>`;
// 邮箱的「填入这些设置」：把服务器、端口、加密方式填进上面的表单（static/app.js）
const fill = (host, port, secure) => `<button type="button" class="act set-fill" data-host="${host}" data-port="${port}" data-secure="${secure}">${t('Fill in these settings')} · ${host} · ${port}</button>`;

const paste = field => t('Paste it into “{field}” above.', { field });
const testThenAdd = () => t('Tap “{test}”. Once your phone gets it, tap “{add}”.', { test: t('Send a test'), add: t('Add') });

export function pushGuide(type) {
  if (type === 'bark') return wrap(ol([
    t('On your iPhone, open the App Store, search for “Bark” and install it. It is free.'),
    t('Open Bark and allow notifications when it asks.'),
    t('Its home screen shows an address that starts with https://api.day.app/ followed by your own key. Copy it.'),
    paste(t('Bark URL')),
    testThenAdd(),
  ]) + tip(t('Bark is iPhone and iPad only. Keep the address to yourself: anyone who has it can send you notifications.')));

  if (type === 'ntfy') return wrap(ol([
    t('Install the free ntfy app: App Store on iPhone, Google Play or F-Droid on Android.'),
    t('Tap “{gen}” under the box above. The last part of the address, after ntfy.sh/ (for example mydash-k3x9…), is your topic name.', { gen: t('Make a random topic') }),
    t('In the ntfy app, tap + to subscribe to a topic, type exactly the same topic name, leave “Use another server” off, and subscribe.'),
    t('Allow notifications when the app asks.'),
    testThenAdd(),
  ]) + tip(t('The topic name works like a password: anyone who knows it can read your notifications and send you some, so keep the random one. If you run your own ntfy server, use its address instead of ntfy.sh in both places.')));

  if (type === 'telegram') return wrap(ol([
    t('In Telegram, search for @BotFather (the real one has a blue tick) and open the chat.'),
    t('Send /newbot. Give the bot any name, then a username that ends in “bot”, such as my_mydash_bot.'),
    t('BotFather replies with a token like 123456789:ABC…. Copy it into “{field}” above.', { field: t('Bot token') }),
    t('Open your new bot from the link in that reply and tap Start, or send it any message.'),
    t('Come back here and tap “{find}”: it fills in “{field}”.', { find: t('Find my chat ID'), field: t('Chat ID') }),
    testThenAdd(),
  ]) + tip(t('This computer has to be able to reach Telegram (api.telegram.org). From mainland China it usually cannot.')));

  if (type === 'pushover') return wrap(ol([
    t('Sign up at {link}. The account is free.', { link: a('https://pushover.net') }),
    t('Install the Pushover app on your phone and log in with the same account. It is free to try for 30 days, then a one-off US$4.99 for each platform (iPhone, Android, desktop), with no subscription.'),
    t('On the pushover.net front page, copy “Your User Key” into “{field}” above.', { field: t('User key') }),
    t('Further down the same page, under Your Applications, choose “Create an Application/API Token”. Name it mydash, agree to the terms and create it.'),
    t('Copy the API token it shows into “{field}” above.', { field: t('App API token') }),
    testThenAdd(),
  ]));

  if (type === 'webhook') {
    const url = paste(t('Webhook URL')); const secret = t('Signing secret (optional)');
    return wrap(`<p>${t('Notifications go to a group chat through a bot you add to the group. Open the one you use:')}</p>`
      + sec(t('WeCom (WeChat Work)'), ol([
        t('Open the group in WeCom (groups with outside contacts cannot have bots). Tap ⋯ at the top right and add a group bot.'),
        t('Name it mydash and finish; copy the webhook address it shows, which starts with https://qyapi.weixin.qq.com/.'),
        `${url} ${t('No signing secret is needed.')}`,
      ]))
      + sec(t('Feishu / Lark'), ol([
        t('Open the group, tap ⋯ at the top right, then Settings → Bots → Add Bot → Custom Bot.'),
        t('Name it mydash and add it; copy the webhook address (https://open.feishu.cn/open-apis/bot/v2/hook/…).'),
        url,
        t('Optional, in its security settings: turn on signature verification and copy the secret into “{field}” above. If you choose custom keywords instead, add the keyword mydash.', { field: secret }),
      ]))
      + sec(t('DingTalk'), ol([
        t('Open the group settings, then Bots (Group Assistant) → Add Robot → Custom.'),
        t('DingTalk asks for one security setting. Either choose Additional Signature and copy the secret that starts with SEC into “{field}” above, or choose Custom Keywords and add mydash.', { field: secret }),
        t('Finish and copy the webhook address (https://oapi.dingtalk.com/robot/send?access_token=…).'),
        url,
      ]))
      + sec('Slack', ol([
        t('Go to {link}, choose Create New App → From scratch, name it mydash and pick your workspace.', { link: a('https://api.slack.com/apps') }),
        t('Open Incoming Webhooks, switch it on, then Add New Webhook to Workspace and pick the channel.'),
        t('Copy the webhook URL (https://hooks.slack.com/services/…).'),
        url,
      ]))
      + sec('Discord', ol([
        t('Open Server Settings → Integrations → Webhooks → New Webhook. You need permission to manage webhooks on the server.'),
        t('Pick the channel, name it mydash, and choose Copy Webhook URL.'),
        url,
      ]))
      + `<p class="set-gend">${t('Then tap “{test}”. Once it shows up in the group, tap “{add}”.', { test: t('Send a test'), add: t('Add') })}</p>`);
  }

  if (type === 'email') {
    const fillIn = () => t('Tap the button below. Then put your full email address in “{account}” and what you copied in the last step in “{pass}”.', { account: t('Account'), pass: t('Password') });
    const code = t('Verify with your phone as asked, then generate an authorisation code. It is shown only once, so copy it now.');
    return wrap(`<p>${t('Notifications arrive as emails sent from your own mailbox. Most mailboxes need an app password or authorisation code here, not your normal password. Open yours:')}</p>`
      + sec('Gmail', ol([
        t('Turn on 2-Step Verification for your Google account.'),
        t('Open {link}, create an app password called mydash and copy the 16 letters (without the spaces).', { link: a('https://myaccount.google.com/apppasswords', 'myaccount.google.com/apppasswords') }),
        fillIn(),
      ]) + fill('smtp.gmail.com', 465, 'tls'))
      + sec(t('QQ Mail'), ol([
        t('Sign in at mail.qq.com in a browser. Open Settings → Account and Security → Security Settings (older layout: Settings → Account) and turn on the POP3/IMAP/SMTP service.'),
        code,
        fillIn(),
      ]) + fill('smtp.qq.com', 465, 'tls'))
      + sec(t('NetEase 163 Mail'), ol([
        t('Sign in at mail.163.com, open Settings → POP3/SMTP/IMAP and turn on the SMTP service.'),
        code,
        fillIn(),
      ]) + fill('smtp.163.com', 465, 'tls'))
      + sec(t('iCloud Mail'), ol([
        t('Two-factor authentication must be on for your Apple Account.'),
        t('At {link}, open Sign-In and Security → App-Specific Passwords, create one called mydash and copy it.', { link: a('https://account.apple.com') }),
        `${fillIn()} ${t('If sending fails, try the password without the dashes.')}`,
      ]) + fill('smtp.mail.me.com', 587, 'starttls'))
      + sec('Outlook / Hotmail', `<p>${t('Microsoft no longer lets other apps send mail from Outlook.com or Hotmail with a password, so these addresses cannot be used here. Pick another mailbox.')}</p>`)
      + sec(t('Other mailboxes'), `<p>${t('Look up the SMTP server, port and encryption in your mail provider’s help pages (search for “SMTP settings”). Port 465 goes with TLS, 587 with STARTTLS. Use an app password if the provider offers one.')}</p>`)
      + `<p class="set-gend">${t('“{to}” is where the notifications arrive; it can be the same address. Tap “{test}”, and once the email arrives, tap “{add}”. On your phone, turn on notifications for your mail app.', { to: t('Send to'), test: t('Send a test'), add: t('Add') })}</p>`);
  }
  return '';
}

// 网页推送（不用装 App）的教程，放在设置页「网页推送」那一块里
export function webpushGuide() {
  return wrap(ol([
    t('This needs mydash’s HTTPS address. If the line above says HTTPS is not on: in the Tailscale admin console, open DNS and enable HTTPS Certificates. mydash notices within a minute.'),
    t('iPhone or iPad (iOS 16.4 or later): open the HTTPS address in Safari, tap Share → Add to Home Screen, and open mydash from the new home screen icon. A normal Safari tab cannot get notifications.'),
    t('Android or a computer: open the HTTPS address in Chrome, Edge, Firefox or Safari.'),
    t('Open Settings here, tap “{on}” and allow notifications when asked.', { on: t('Turn on for this device') }),
    t('Tap “{test}”. Do this once on every device that should get notifications.', { test: t('Send a test') }),
  ]));
}
