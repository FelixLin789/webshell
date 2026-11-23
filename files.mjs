// AI 指定的本机路径（上传、下载、截图、PDF）：网页内容可能诱导 AI 去碰敏感位置，这些地方一律拒绝——
// WebShell 自己的数据（密码本、浏览器登录资料）、点开头的配置目录（.ssh、.aws……）、浏览器资料目录、开机启动目录
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './common.mjs';

// shortcut: 按位置名拦截，拦不住所有敏感文件；要更严就改成只允许指定的文件夹
// （Windows 的开机启动在 Start Menu\…\Startup，macOS 在 LaunchAgents / LaunchDaemons，浏览器资料在 User Data / Application Support，Linux 的都在点开头的目录里）
const SENSITIVE = /^(\..+|user data|start menu|startup|launchagents|launchdaemons|application support)$/i;

export function guard(p) {
  // 还原成真实路径，防止借链接绕过：要写的文件、文件夹可能还不存在，就从最深一层已存在的文件夹算起，再接上后面的部分
  let dir = path.resolve(p);
  const rest = [];
  for (;;) {
    try { dir = fs.realpathSync(dir); break; } catch { /* 这一层还不存在：往上找 */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    rest.unshift(path.basename(dir));
    dir = up;
  }
  const real = path.join(dir, ...rest);
  const inside = (dir, f) => !path.relative(dir, f).startsWith('..') && !path.isAbsolute(path.relative(dir, f));
  if (inside(path.resolve(HOME), real) || real.split(path.sep).some(s => SENSITIVE.test(s))) {
    throw Object.assign(new Error(`为了安全，不读写这个位置：${real}`), { exit: 2 });
  }
  return real;
}

// 截图和 PDF 存成文件，返回完整路径；没给文件名就存到 ~/.webshell/shots。已有的文件不覆盖
export const store = (file, ext, base64) => {
  const out = file ? guard(file) : path.join(HOME, 'shots', `${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`);
  if (file && fs.existsSync(out)) throw new Error(`已经有这个文件了，不覆盖：${out}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(base64, 'base64'));
  return out;
};
