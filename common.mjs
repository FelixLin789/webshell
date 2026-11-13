// 后台进程（daemon.mjs）和传话的这一头（webshell.mjs）都要用的：数据放在哪、版本号、怎么连浏览器
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const env = process.env;
export const HOME = env.WS_HOME || path.join(os.homedir(), '.webshell');
export const PROFILE = path.join(HOME, 'profile'); // 专用浏览器的配置目录：在这里登录的账号和日常 Chrome 互不影响
export const TAB_FILE = path.join(HOME, 'tab'); // “当前目录”就是这个标签页
export const FLOW_FILE = path.join(HOME, 'flow.jsonl'); // 最近一次 cd 之后做过的操作
export const MACROS = path.join(HOME, 'macros');
export const VAULT = path.join(HOME, 'vault.json');
export const NAME = /^[\p{L}\p{N}_-]+$/u; // 流程名会变成文件名，不允许出现路径符号
// 所有代码文件里最新的修改时间：代码改过之后，旧的后台进程会让位给新的
export const VERSION = Math.max(...['webshell.mjs', 'daemon.mjs', 'common.mjs', 'text.mjs', 'page.mjs', 'vault.mjs'].map(f => fs.statSync(fileURLToPath(new URL(f, import.meta.url))).mtimeMs));
// 后台进程监听的本机管道。网页连不到管道（不像 HTTP 端口），所以不需要口令
export const SOCK = process.platform === 'win32'
  ? `\\\\.\\pipe\\webshell-${createHash('md5').update(HOME).digest('hex')}` : path.join(HOME, 'sock');
// 各系统上 Chrome 程序的位置，以及“你自己的 Chrome”的配置目录
export const [CHROMES, MINE] = {
  win32: [['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'].map(k => path.join(env[k] || '', 'Google/Chrome/Application/chrome.exe')),
    path.join(env.LOCALAPPDATA || '', 'Google/Chrome/User Data')],
  darwin: [['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'], path.join(os.homedir(), 'Library/Application Support/Google/Chrome')],
}[process.platform] ?? [['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(n => `/usr/bin/${n}`),
  path.join(os.homedir(), '.config/google-chrome')];

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Chrome 开着调试时会在配置目录里写一个 DevToolsActivePort 文件：第一行端口，第二行连接路径
export const endpoint = dir => {
  try {
    const [port, id] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n');
    return `ws://127.0.0.1:${port}${id.trim()}`;
  } catch {
    return null; // 没有这个文件 = 没开调试
  }
};

export async function connect(url, wait = 3000) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => { ws.close(); fail(new Error('连不上浏览器（超时）')); }, wait);
    ws.onopen = () => { clearTimeout(timer); ok(); };
    ws.onerror = () => { clearTimeout(timer); fail(new Error('连不上浏览器')); };
  });
  let id = 0;
  const waiting = new Map();
  const c = {
    on: () => {}, // 浏览器主动发来的事件交给它
    closed: new Promise(ok => { ws.onclose = ok; }),
    send: (method, params = {}, sessionId) => new Promise((ok, fail) => {
      waiting.set(++id, { ok, fail, sessionId });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    }),
  };
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    const w = waiting.get(m.id);
    if (m.method === 'Target.detachedFromTarget') { // 标签页关掉了：发给它、还没回音的命令永远等不到回音，直接算失败
      for (const [k, x] of waiting) if (x.sessionId === m.params.sessionId) { waiting.delete(k); x.fail(new Error('标签页已经关掉了')); }
    }
    if (!w) { c.on(m); return; }
    waiting.delete(m.id);
    if (m.error) w.fail(new Error(m.error.message)); else w.ok(m.result);
  };
  return c;
}

export const closeOwn = async () => {
  const url = endpoint(PROFILE), c = url && await connect(url).catch(() => null);
  if (c) await Promise.race([c.send('Browser.close'), c.closed]);
};
