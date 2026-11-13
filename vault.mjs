// 密码本：网站 → 用户名 + 加密后的密码。密码只由你本人在 Windows 弹出的输入窗口里填；AI 只能让工具去填网页，看不到也拿不走。
// 加密用 Windows 自带的 DPAPI：只有当前这个 Windows 账户能解开，文件被拷到别处也没用。
// shortcut: 只支持 Windows；要在 macOS / Linux 上用，换成系统钥匙串（security / secret-tool）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 脚本里不能出现双引号：Windows 传参时会被转义坏掉
function ps(script, input = '') {
  if (process.platform !== 'win32') throw new Error('密码本目前只支持 Windows');
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { input, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('没有保存（输入窗口被取消了，或者 Windows 加密出错）');
  return r.stdout.trim();
}
const utf8 = b64 => Buffer.from(b64, 'base64').toString('utf8'); // 用 base64 传，免得中文在命令行里变乱码

export const vault = file => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});

// 解开密码：只在后台进程里用一下就填进网页，不出现在任何输出、记录和错误信息里
export const reveal = blob => utf8(ps("$s = ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Net.NetworkCredential]::new('', $s).Password))", blob));

const hostOf = site => {
  const host = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`).hostname;
  if (!/^[\w.\-[\]:]+$/.test(host)) throw new Error(`网站名不对：${site}`); // 下面要放进脚本里，只允许主机名里会有的字符
  return host;
};

// 弹出 Windows 自带的账号密码输入窗口，由你本人填。窗口是系统的，AI 既不能往里打字，也读不到里面的内容
export function ask(file, site) {
  const host = hostOf(site);
  const [user, blob] = ps(`$c = Get-Credential -Message '给 WebShell 保存 ${host} 的账号。密码会加密保存，AI 看不到。'; if (-not $c) { exit 1 }; `
    + "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($c.UserName.TrimStart('\\'))) + ' ' + (ConvertFrom-SecureString $c.Password)").split(' ');
  return remember(file, host, { user: utf8(user), pass: blob });
}

// 记下这个网站的账号，或者你选的登录方式（{ sso: 'Google' }）
export function remember(file, host, acct) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...vault(file), [host]: acct }, null, 2));
  return acct;
}

// 网页上有“用 Google / Apple 登录”这类按钮时，弹窗问你用哪种方式登录；返回选中的那项，关掉窗口就是 null。
// options 只来自 webshell.mjs 里固定的几个名字，不会把网页上的文字放进脚本
export function choose(site, options) {
  const host = hostOf(site);
  const items = options.map(o => `'${o === PASSWORD ? '用账号密码登录（第一次要填一次）' : `用 ${o} 登录`}'`).join(',');
  try {
    const i = ps('Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = ' + `'WebShell：登录 ${host}'; `
      + "$f.TopMost = $true; $f.StartPosition = 'CenterScreen'; $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false; "
      + "$f.AutoSize = $true; $f.AutoSizeMode = 'GrowAndShrink'; $p = New-Object Windows.Forms.FlowLayoutPanel; $p.FlowDirection = 'TopDown'; "
      + "$p.AutoSize = $true; $p.Padding = 16; $f.Controls.Add($p); $l = New-Object Windows.Forms.Label; $l.AutoSize = $true; "
      + `$l.Text = '这个网站可以用下面的方式登录，选一种。以后来这里会自动用同一种方式。'; $l.MaximumSize = New-Object Drawing.Size 320,0; $p.Controls.Add($l); `
      + `$i = 0; foreach ($t in @(${items})) { $b = New-Object Windows.Forms.Button; $b.Text = $t; $b.Tag = $i++; $b.Width = 320; $b.Height = 36; `
      + '$b.Add_Click({ $f.Tag = $this.Tag; $f.Close() }); $p.Controls.Add($b) }; '
      // 后台启动时 Windows 会把这个程序“第一次显示的窗口”藏起来：先显示一个用完就关的空窗口把这次用掉，真正的窗口才看得见
      + '$d = New-Object Windows.Forms.Form; $d.Show(); $d.Close(); $f.Add_Shown({ $f.Activate() }); '
      + '[void]$f.ShowDialog(); if ($null -eq $f.Tag) { exit 1 }; $f.Tag');
    return options[+i];
  } catch { return null; }
}
export const PASSWORD = '账号密码';

export function pass(file, [sub, site]) {
  const book = vault(file);
  if (sub === 'list') return Object.entries(book).map(([h, a]) => `${h}\t${a.sso ? `用 ${a.sso} 登录` : a.user}`).join('\n') || '（密码本是空的）';
  if (!/^(save|rm)$/.test(sub ?? '') || !site) throw new Error('用法：ws pass save <网站> / ws pass rm <网站> / ws pass list');
  const host = hostOf(site);
  if (sub === 'save') { ask(file, host); return `已保存 ${host}。以后在它的登录页运行 login 就会自动填好并登录`; }
  const { [host]: gone, ...rest } = book;
  if (!gone) throw new Error(`密码本里没有 ${host}`);
  fs.writeFileSync(file, JSON.stringify(rest, null, 2));
  return `已删除 ${host}`;
}
