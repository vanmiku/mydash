// Windows 用：没有 launchd / systemd，登录时由"启动"文件夹里的 .vbs 隐藏启动本脚本，
// 本脚本再拉起真正的服务，退出了就重启（短时间连续崩溃时逐步拉长间隔）。
// 用法：node supervise.mjs <名字> -- <程序> [参数...]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME } from './store.mjs';

const argv = process.argv.slice(2);
const name = argv[0]; const cmd = argv.slice(argv.indexOf('--') + 1);
if (!name || !cmd.length) { console.error('usage: supervise.mjs <name> -- <program> [args...]'); process.exit(2); }
fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true }); fs.mkdirSync(path.join(HOME, 'run'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'run', `${name}.pid`), String(process.pid));
const log = fs.openSync(path.join(HOME, 'logs', `${name}.log`), 'a');
let delay = 1000;
function start() {
  const began = Date.now();
  const child = spawn(cmd[0], cmd.slice(1), { cwd: HOME, stdio: ['ignore', log, log], windowsHide: true, env: process.env });
  child.on('exit', code => {
    delay = Date.now() - began > 60_000 ? 1000 : Math.min(delay * 2, 30_000);
    fs.writeSync(log, `${new Date().toISOString()} [supervise] exited with ${code}; restarting in ${delay} ms\n`);
    setTimeout(start, delay);
  });
}
start();
