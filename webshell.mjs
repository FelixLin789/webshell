#!/usr/bin/env node
// WebShell：让 AI 用命令行操控网页，只有文字，不截图。零依赖：Node 自带功能 + Chrome 的调试协议（CDP）。
// 结构：`ws <命令>` 只负责传话；真正干活的是常驻后台进程（ws serve），它一直连着浏览器。
// 这样每条命令都很快，接管你自己的 Chrome 时也只需要点一次“允许”。
// 后台进程在 daemon.mjs，两边共用的在 common.mjs 和 text.mjs。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { env, FLOW_FILE, MACROS, VAULT, NAME, VERSION, SOCK, MINE, sleep, endpoint, closeOwn } from './common.mjs';
import { PIPES, filters } from './text.mjs';
import { cmds, serve } from './daemon.mjs';
import { ask as askAccount, choose, pass, PASSWORD, remember } from './vault.mjs';

const SELF = fileURLToPath(import.meta.url);

const HELP = `WebShell —— 用命令行操控网页（只有文字，不截图）

  cd <网址|/路径|..>              打开网站；不带参数显示当前位置；back / forward 后退 / 前进
  ls [-l] [--all] [--form]        列出能点、能填的：编号 类型 文字 状态；-l 带链接；--all 逐条全列；
                                  --form 只列表单里的框和按钮，按小标题分组（长表单用它，同名的框分得清）。
                                  相同的行出现 5 次以上合成一行，第一列是全部编号（如 12,19,26），都能点。
                                  同一个网页里编号一直不变（ls 也不重新编），换了网页才从 1 编起
  cat [网址...] [--field 名字]     读页面文字；多个网址并行读；--field 只取一个字段，如 price
  cat --outline / --section 标题   正文长时先看目录，再只读需要的那段；cat --table 只读表格（Tab 分隔）
  cat [网址...] --extract '正则' --check '标记' [--expect 条数] [--follow '链接文字正则' --limit 数量]
                                  逐页校验着提取并注明来源；--follow 从列表页选出要读的链接
  click <编号|文字> [--accept]     点击；点出新标签页会跟过去；--accept：确认框点“确定”
  hover <编号|文字>                鼠标悬停（悬停才展开的菜单）
  press <键> [编号|文字]           按键，如 Enter Escape Tab Space ArrowDown，可加 Shift+ / Control+；给了元素就先把焦点放上去
  wait <文字> [秒数]               等到页面上出现这段文字（默认最多 10 秒）
  expand <编号...> [--section 标题] [--extract '正则' --check '标记']  批量展开并读详情；带提取时每个按钮一条记录，齐了就返回
  type <框> <内容> [<框> <内容>...] [--enter]  输入（"" 清空；下拉框则选中该项）；可一次填多个框，回车按在最后一个
  login                           登录：第一次弹窗请用户选方式（Google 等或账号密码），以后自动；AI 看不到密码
  scroll [屏数]                   向下滚几屏（负数向上）
  动作之后没跳到新页面时，结果里附“新出现：”的文字和“新出现的可点、可填：”（带编号，直接能用），一般不用再 cat、ls；
  被限流、网站出错、要人机验证，或 cd 时被转到登录页，结果里有“注意：”
  tab [编号|close]                列出 / 切换 / 关掉标签页
  upload <文件...> [--to 编号|文字] 上传文件
  download <编号|文字> [文件夹]    点击并下载，返回保存位置（默认“下载”文件夹）
  screenshot [文件] [--full]       截图；pdf [文件]：存成 PDF
  mobile on|off                   手机模式
  save <名字> / run <名字> [参数]   把最近一次 cd 之后的操作存成命令 / 重放（$1 $2 换成参数）
  exit                            断开（你自己的 Chrome 不会被关掉）

密码本（AI 碰不到，只能由你本人操作）：
  ws pass save <网站>              弹出窗口，存这个网站的账号（也可以不管它，等 login 时自动弹出）
  ws pass list / ws pass rm <网站>  看存了哪些网站 / 删掉一个

三种用法：
  ws <命令>     在系统终端里用，可以接管道：ws cat | grep AI
  ws shell      进入交互模式，直接敲 cd / ls / cat，自带 grep、extract、head，分号可连写多条
  ws mcp        作为 MCP 服务器给 AI 用（一个工具 ws，参数就是上面的命令，写法同交互模式）

验证码、银行卡输入框，以及授权/付款/下单的按钮不会被操作，需要本人在浏览器里完成（此时退出码为 2）。
默认用 WebShell 专用的 Chrome 窗口；想用你自己正在用的 Chrome，在它的地址栏打开 chrome://inspect/#remote-debugging 并打开开关；
想用云端浏览器，把环境变量 WS_CDP 设为它的连接地址（ws:// 或 wss://）。`;

// ================= 传话的这一头：命令行、交互模式、MCP =================
const ask = argv => new Promise((ok, fail) => {
  const sock = net.connect(SOCK);
  let buf = '';
  sock.on('connect', () => sock.write(JSON.stringify({ argv, v: VERSION, cwd: process.cwd() }) + '\n'));
  sock.on('data', d => { buf += d; });
  sock.on('end', () => { try { ok(JSON.parse(buf)); } catch { fail(new Error('后台进程没有回应')); } });
  sock.on('error', fail);
});

// 后台进程要你本人选登录方式或填账号时，窗口由这边弹（后台进程脱离了控制台，Windows 不给它弹），弄好后再执行一次
async function request(argv) {
  const res = await deliver(argv);
  if (!res.ask || env.WS_HEADLESS) return res;
  const { host, account, options } = res.ask;
  const picked = options.some(o => o !== PASSWORD) ? choose(host, options) : PASSWORD;
  if (!picked) return { out: '', err: '选择登录方式的窗口被关掉了，没有登录', code: 1 };
  if (picked === PASSWORD) askAccount(VAULT, account); else remember(VAULT, host, { sso: picked });
  return deliver(argv);
}

async function deliver(argv) {
  let res = await ask(argv).catch(() => null);
  if (res && !res.stale) return res;
  // 后台进程没在运行，或者代码更新过（旧的那个已自行退出）：启动一个新的
  if (res) await sleep(300);
  spawn(process.execPath, [SELF, 'serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  // 新的后台进程要先连上浏览器；接管自己的 Chrome 时这一步要等你点“允许”，等久了提醒一句
  const hint = env.WS_BROWSER !== 'own' && endpoint(MINE)
    && setTimeout(() => process.stderr.write('ws: 如果 Chrome 弹出了“允许远程调试”的对话框，请点“允许”……\n'), 4000);
  for (let i = 0; i < 100 && !(res = await ask(argv).catch(() => null)); i++) await sleep(100);
  clearTimeout(hint);
  if (!res) throw new Error('后台进程启动失败');
  return res;
}

// 执行一行命令，如 `click 3; cat | grep -i price | head -5`：分号隔开多条命令（一次调用做完，省来回），竖线接过滤器。
// cap：没加过滤器时每条命令最多返回多少行（防止整页内容撑爆 AI 的上下文）
async function line(text, cap) {
  const jobs = [[[]]]; // 多条命令；每条命令是用 | 隔开的几段；每段是几个词
  for (const m of text.matchAll(/"([^"]*)"|'([^']*)'|([|;])|([^\s|;]+)/g)) {
    if (m[3] === ';') jobs.push([[]]);
    else if (m[3]) jobs.at(-1).push([]);
    else jobs.at(-1).at(-1).push(m[1] ?? m[2] ?? m[4]);
  }
  const outs = [];
  for (const [argv, ...pipes] of jobs) {
    if (!argv.length || argv[0] === 'help') { outs.push(`${HELP}\n${PIPES}`); continue; }
    if (argv[0] === 'pass') throw new Error('密码本只能由用户本人操作；需要登录时直接用 login，第一次会弹窗请用户填账号');
    const res = argv[0] === 'save' ? { out: save(argv[1]) } : await request(argv);
    let lines = res.out ? res.out.split('\n') : [];
    for (const [name, ...args] of pipes) {
      if (!Object.hasOwn(filters, name ?? '')) throw new Error(`管道支持 ${Object.keys(filters).join('、')}，不认识 ${name ?? ''}`);
      lines = filters[name](lines, args);
    }
    if (cap && !pipes.length && lines.length > cap) {
      lines = [...lines.slice(0, cap), `……还有 ${lines.length - cap} 行。用 | grep 关键词 或 | head -数量 缩小范围`];
    }
    outs.push(...lines);
    if (res.err) outs.push(`ws: ${res.err}`);
    if (res.code) return { out: outs.join('\n'), code: res.code }; // 某一条失败了，后面的就不执行了
  }
  return { out: outs.join('\n') };
}

async function shell() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'ws> ' });
  let open = true;
  rl.on('close', () => { open = false; }); // 输入是文件或管道时，读完就关了，但读到的命令还要执行完
  rl.prompt();
  for await (const text of rl) {
    if (/^\s*(exit|quit)\s*$/.test(text)) break;
    const res = await line(text).catch(e => ({ out: `ws: ${e.message}` }));
    if (res.out) console.log(res.out);
    if (open) rl.prompt();
  }
}

// MCP（stdio）：一行一个 JSON-RPC 消息。只提供一个工具，说明尽量短——工具说明每次对话都要占 AI 的字数
async function mcp() {
  const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  const tool = {
    name: 'ws',
    // 去掉给人看的对齐空格：说明每次对话都要占 AI 的字数
    description: `文字命令操控浏览器，分号连写多条，例：cd github.com; ls | grep -i login\n${HELP.split('\n\n')[1].replace(/ {2,}/g, ' ')}\n${PIPES}\n参数含空格、; 或 | 时加引号；文件写完整路径。验证码、银行卡、授权和付款只能由用户本人操作。`,
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  };
  for await (const text of readline.createInterface({ input: process.stdin })) {
    let msg;
    try { msg = JSON.parse(text); } catch { continue; } // 空行或坏消息：跳过，不能让整个服务崩掉
    const { id, method, params } = msg;
    if (method === 'initialize') reply(id, { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'webshell', version: '0.3.0' } });
    else if (method === 'tools/list') reply(id, { tools: [tool] });
    else if (method === 'tools/call') {
      const command = params?.arguments?.command;
      const res = params?.name !== 'ws' || typeof command !== 'string' ? { out: 'ws: 只有一个工具 ws，参数 command 是一行文字命令', code: 1 }
        : await line(command, 200).catch(e => ({ out: `ws: ${e.message}`, code: 1 }));
      // 截图直接把图片交给 AI 看（MCP 里 AI 不一定能自己打开本机文件）
      const shot = /(^|;)\s*screenshot\b/.test(command ?? '') && res.out.split('\n').find(l => l.endsWith('.png') && fs.existsSync(l));
      const image = shot ? [{ type: 'image', data: fs.readFileSync(shot, 'base64'), mimeType: 'image/png' }] : [];
      reply(id, { content: [{ type: 'text', text: res.out || '（完成）' }, ...image], isError: !!res.code });
    } else if (id !== undefined) reply(id, {}); // ping 之类；没有 id 的是通知，不用回
  }
}

function save(name) {
  if (!NAME.test(name ?? '')) throw new Error('用法：save <名字>（只能用文字、数字、下划线、短横线）');
  if (!fs.existsSync(FLOW_FILE)) throw new Error('还没有可保存的操作：先 cd 到网站，再 click / type');
  fs.mkdirSync(MACROS, { recursive: true });
  fs.copyFileSync(FLOW_FILE, path.join(MACROS, `${name}.jsonl`));
  return `已保存，以后用：run ${name}`;
}

async function once(argv) {
  if (argv[0] === 'save') return { out: save(argv[1]) };
  if (argv[0] === 'pass') return { out: pass(VAULT, argv.slice(1)) };
  if (argv[0] === 'exit') { // 后台进程没在运行（或是旧版本、已自行退出）时，不为了退出再启动一个，直接去关专用浏览器
    const res = await ask(argv).catch(() => null);
    if (!res || res.stale) await closeOwn();
    return {};
  }
  if (!Object.hasOwn(cmds, argv[0] ?? '')) return { out: `${HELP}\n${PIPES}` };
  return request(argv);
}

const argv = process.argv.slice(2);
if (argv[0] === 'serve') serve();
else if (argv[0] === 'shell') await shell();
else if (argv[0] === 'mcp') await mcp();
else {
  const res = await once(argv).catch(e => ({ err: e.message, code: e.exit ?? 1 }));
  // 等输出写完再退出，否则接管道时内容可能被截断
  process.stderr.write(res.err ? `ws: ${res.err}\n` : '', () => process.stdout.write(res.out ? `${res.out}\n` : '', () => process.exit(res.code || 0)));
}
