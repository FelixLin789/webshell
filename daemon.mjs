// 后台进程（ws serve）：一直连着浏览器，执行命令。在网页里执行的代码在 page.mjs，密码本在 vault.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { env, HOME, PROFILE, TAB_FILE, FLOW_FILE, MACROS, VAULT, NAME, VERSION, SOCK, CHROMES, MINE, sleep, endpoint, connect, closeOwn } from './common.mjs';
import { outline, section, extractor } from './text.mjs';
import { page } from './page.mjs';
import { PASSWORD, reveal, vault } from './vault.mjs';

const human = what => Object.assign(new Error(`${what}，请你本人在浏览器里完成`), { exit: 2 });
const abs = u => (/^https?:\/\//i.test(u) ? u : 'https://' + u); // 只打开网页，不碰 file:// chrome:// 之类
const LIB = `(${page})()`;
const SEEN = 'innerWidth > 1 && innerHeight > 1'; // 尺寸为 0 的内嵌页面是网站后台用的隐藏框架

// ================= 后台进程：连着浏览器，执行命令 =================
let B; // 和浏览器的连接
let P; // 当前标签页 { id, sid, loading, reqs, net }
let refs = []; // 最近一次给元素编的号：refs[编号-1] = 这个元素在哪个页面（会话）里的第几个
let opened = null; // 当前页刚点出来的新标签页
let dl = null; // 正在进行的下载 { guid, name, state }
let accepting = false; // 这一次点击弹出确认框时，要不要点“确定”
let phone = false; // 手机模式
const pages = new Map(); // 已接入的标签页：会话 id → 同上
const frames = new Map(); // 已接入的跨站内嵌页面：会话 id → { parent: 上一级的会话 id }
const notes = []; // 要捎给下一条命令的提示（弹窗内容、连接情况）
const AUTO = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }; // 让浏览器把页面里的跨站 iframe 也接进来
const CHECK_WAIT = 10000;

// 内嵌页面的网络动静也算在它所在的标签页头上
const top = s => pages.get(s) ?? (frames.has(s) ? top(frames.get(s).parent) : undefined);

function onEvent({ method, params, sessionId }) {
  const p = pages.get(sessionId);
  if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') {
    frames.set(params.sessionId, { parent: sessionId });
    B.send('Target.setAutoAttach', AUTO, params.sessionId).catch(() => {}); // 内嵌页面里还可能再嵌别的；它刚好关掉了也无妨
    B.send('Network.enable', {}, params.sessionId).catch(() => {});
  } else if (method === 'Network.requestWillBeSent') {
    // 单页应用点一下之后靠 XHR / fetch 取数据，只等这两种；图片、脚本、内嵌页面、推送连接都不用等
    // （内嵌页面的加载请求从父页面发出，“加载完成”却记在内嵌页面那边，算进来就永远等不到）
    const t = top(sessionId);
    if (t && /^(XHR|Fetch)$/.test(params.type)) { t.reqs.set(params.requestId, Date.now()); t.net = Date.now(); }
  } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    const t = top(sessionId);
    if (t?.reqs.delete(params.requestId)) t.net = Date.now();
  } else if (p && method === 'Network.responseReceived' && params.type === 'Document' && params.frameId === p.id) {
    p.response = { url: params.response.url, status: params.response.status };
  } else if (method === 'Target.detachedFromTarget') {
    frames.delete(params.sessionId);
    pages.delete(params.sessionId);
    if (P?.sid === params.sessionId) { // 当前标签页被关掉了：是弹出窗口就回到打开它的页面，否则下条命令再找一个
      if (P.from) fs.writeFileSync(TAB_FILE, P.from);
      P = null;
    }
  } else if (method === 'Target.targetCreated' && params.targetInfo.type === 'page' && params.targetInfo.openerId && params.targetInfo.openerId === P?.id) {
    opened = params.targetInfo.targetId; // 当前页点出来的新标签页：click 完自动跟过去
  } else if (method === 'Browser.downloadWillBegin') {
    dl = { guid: params.guid, name: params.suggestedFilename };
  } else if (method === 'Browser.downloadProgress' && params.guid === dl?.guid && params.state !== 'inProgress') {
    dl.state = params.state;
  } else if (method === 'Page.javascriptDialogOpening') {
    // “确定离开此页吗”放行；其余弹窗默认取消。click 加了 --accept 就点“确定”，但提到付款、下单的弹窗永远不替你确认
    const leaving = params.type === 'beforeunload';
    const ok = leaving || (accepting && !/pay|purchase|order|付款|支付|下单|购买|订单/i.test(params.message));
    const why = ok ? '' : accepting ? '（跟付款有关，需本人操作）' : '（要点“确定”就在 click 后面加 --accept）';
    if (!leaving) notes.push(`页面弹窗已${ok ? '确认' : '取消'}：${params.message}${why}`);
    B.send('Page.handleJavaScriptDialog', { accept: ok }, sessionId).catch(() => {}); // 弹窗可能已被人手动关掉
  } else if (p && params?.frameId === p.id) { // 标签页的 id 就是它主页面的 frame id；iframe 的加载不算
    if (method === 'Page.frameStartedLoading') p.loading = true;
    if (method === 'Page.frameStoppedLoading') p.loading = false;
  }
}

// 浏览器：设了 WS_CDP 就连那个云端浏览器；你在 chrome://inspect/#remote-debugging 里打开了开关，就用你自己的 Chrome
// （它会弹窗让你点一次“允许”）；否则用 WebShell 专用的那个，没开就启动它
async function browser() {
  if (B) return B;
  const mine = env.WS_CDP || (env.WS_BROWSER !== 'own' && endpoint(MINE));
  const began = Date.now();
  let c = mine && await connect(mine, 60000).catch(() => null);
  const real = !!c;
  if (env.WS_CDP && !c) throw new Error('连不上 WS_CDP 指定的浏览器');
  // 立刻失败是 Chrome 没在运行（留下的旧文件），那就用专用窗口；等了一阵才失败是没点“允许”——
  // 这时不能悄悄换成专用窗口（那里没有你的登录状态，后面的命令会全部跑偏），直接报错
  if (mine && !c && Date.now() - began > 1500) {
    throw new Error('没连上你自己的 Chrome：它弹出“允许远程调试”的对话框时请点“允许”，然后重试。（想改用 WebShell 专用窗口，就在 chrome://inspect/#remote-debugging 里关掉开关）');
  }
  const own = () => { const url = endpoint(PROFILE); return url && connect(url).catch(() => null); };
  c ||= await own();
  if (!c) {
    const exe = [env.WS_CHROME, ...CHROMES].find(f => f && fs.existsSync(f));
    if (!exe) throw new Error('找不到 Chrome：请把环境变量 WS_CHROME 设为 Chrome 程序的完整路径');
    fs.mkdirSync(PROFILE, { recursive: true });
    fs.rmSync(path.join(PROFILE, 'DevToolsActivePort'), { force: true }); // 删掉上次留下的旧端口，等 Chrome 写入新的
    spawn(exe, ['--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
      ...(env.WS_HEADLESS ? ['--headless=new'] : []), 'about:blank'], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 200 && !c; i++) { await sleep(100); c = await own(); }
    if (!c) throw new Error('Chrome 启动超时');
  }
  B = Object.assign(c, { mine: real, on: onEvent });
  B.closed.then(() => process.exit(0)); // 浏览器关了，后台进程也跟着退出
  await B.send('Target.setDiscoverTargets', { discover: true }); // 这样才知道点击时有没有弹出新标签页
  return B;
}

async function attach(targetId) {
  const { sessionId: sid } = await B.send('Target.attachToTarget', { targetId, flatten: true });
  const p = { id: targetId, sid, loading: false, reqs: new Map(), net: Date.now() }; // reqs：还没回来的请求 → 发出的时间
  pages.set(sid, p);
  await B.send('Page.enable', {}, sid);
  await B.send('Network.enable', {}, sid);
  await B.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid); // 窗口在后台时也能输入
  await B.send('Target.setAutoAttach', AUTO, sid);
  return p;
}

// 手机模式：屏幕大小、触屏、iPhone 的浏览器身份；只作用于 WebShell 正在用的那个标签页
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
async function phoneOn(sid) {
  await B.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sid);
  await B.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
  await B.send('Emulation.setUserAgentOverride', { userAgent: PHONE_UA }, sid);
}

// 换到另一个标签页（新开的、点出来的、用 tab 选的）
async function use(targetId) {
  const from = P?.id === targetId ? P.from : P?.id; // 从哪个标签页换过来的：这个关掉后回那里
  if (P) await B.send('Target.detachFromTarget', { sessionId: P.sid }).catch(() => {}); // 旧的那个可能已经关了
  P = Object.assign(await attach(targetId), { from });
  if (phone) await phoneOn(P.sid);
  refs = [];
  fs.writeFileSync(TAB_FILE, targetId);
  return P;
}

const tabs = async () => (await B.send('Target.getTargets')).targetInfos
  .filter(t => t.type === 'page' && /^(https?:|about:blank)/.test(t.url)); // 浏览器自己的设置页之类不碰

// 当前标签页：上次用的那个还在就接着用；接管的是你自己的 Chrome 时，不动你已经打开的标签页，新开一个
async function current() {
  if (P) return P;
  const all = await tabs();
  const saved = fs.existsSync(TAB_FILE) && fs.readFileSync(TAB_FILE, 'utf8');
  // 新开的标签页放在后台：不抢你正在用的窗口（操作后台标签页不受影响，attach 时已打开焦点模拟）
  const t = all.find(x => x.targetId === saved) || (!B.mine && all[0]) || await B.send('Target.createTarget', { url: 'about:blank', background: true });
  return use(t.targetId);
}

async function run(sid, expression) {
  const r = await B.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) {
    const text = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
    throw new Error(text.split('\n    at ')[0].replace(/^Error: /, '')); // 去掉调用栈，只留错误信息（可能有多行）
  }
  return r.result.value;
}
const call = (sid, fn, ...args) => run(sid, `${LIB}.${fn}(${args.map(a => JSON.stringify(a)).join(',')})`);
const inner = sid => [...frames].filter(([, f]) => f.parent === sid).flatMap(([s]) => [s, ...inner(s)]);

// 给页面和它里面每个看得见的跨站内嵌页面的元素统一编号
async function snapshot(sid) {
  const groups = await Promise.all([sid, ...inner(sid)].map(async s => {
    const rows = await run(s, `${s === sid || SEEN} ? ${LIB}.scan() : []`).catch(() => []); // 正在加载或刚被关掉的内嵌页面就跳过
    return rows.map(([kind, label, more, field, href], i) => ({ s, i, kind, label, more, field, href }));
  }));
  refs = groups.flat();
  return refs;
}
const tail = (r, long) => [r.kind, r.label, (long && r.href) || r.more].join('\t').replace(/\t+$/, ''); // 一行里编号后面的部分
const row = r => `${refs.indexOf(r) + 1}\t${tail(r)}`;

async function pick(sid, t, field) {
  if (/^\d+$/.test(t)) {
    if (!refs[t - 1]) throw new Error('没有这个编号，请先运行 ls');
    return refs[t - 1];
  }
  const all = (await snapshot(sid)).filter(r => r.field === field), q = t.toLowerCase();
  const same = all.filter(r => r.label.toLowerCase() === q);
  const hits = same.length ? same : all.filter(r => r.label.toLowerCase().includes(q));
  if (!hits.length) throw new Error(`页面上找不到“${t}”，先用 ls 看看有什么`);
  // 宁可让调用者多说一句，也不替它猜（猜错会点到别的按钮）：对不上唯一的元素就列出候选，让它改用编号
  if (hits.length > 1) throw new Error(`“${t}”对应 ${hits.length} 个元素，请改用编号：\n${hits.slice(0, 10).map(r => row(r)).join('\n')}`);
  return hits[0];
}
// 存流程时优先记文字（下次来编号会变），文字不能唯一指到这个元素时才退回编号
const refOf = r => (r.label && !/^\d+$/.test(r.label)
  && refs.filter(x => x.field === r.field && x.label.toLowerCase() === r.label.toLowerCase()).length === 1 ? r.label : String(refs.indexOf(r) + 1));

async function read(sid) {
  const frames = inner(sid).map(async s => {
    const t = await run(s, `${SEEN} ? [location.href, ${LIB}.cat()] : null`).catch(() => null); // 隐藏的、正在加载的都跳过
    return t?.[1] ? `--- 内嵌页面 ${t[0].slice(0, 100)} ---\n${t[1]}` : null;
  });
  const [main, ...embedded] = await Promise.all([call(sid, 'cat'), ...frames]);
  return [main, ...embedded.filter(Boolean)].join('\n');
}

// 动作前后各读一次整页文字（连同内嵌页面）。没跳到新页面，就只把新出现的那些行告诉 AI，不用它再把整页读一遍。
// timeOrigin 是这个页面打开的时刻：变了就是跳到了新页面
async function look(sid, origin = null) {
  const expected = JSON.stringify(origin);
  const snapshot = await run(sid, `${expected} === null || performance.timeOrigin === ${expected}
    ? [performance.timeOrigin, ${LIB}.all()] : null`);
  if (!snapshot) return null;
  const [t0, top] = snapshot;
  const rest = await Promise.all(inner(sid).map(s => run(s, `${SEEN} ? ${LIB}.all() : ''`).catch(() => ''))); // 正在加载或刚关掉的内嵌页面就跳过
  return { t0, lines: [top, ...rest].flatMap(text => text.split('\n').filter(Boolean)) };
}
const before = sid => look(sid).catch(() => null); // 读不到（页面正在跳转）就不比较
const NEWS = 2000; // 新内容最多给这么多字：再多多半是整页换了内容，AI 该先 cat --outline
async function news(sid, was) {
  const now = was && await look(sid, was.t0).catch(() => null);
  if (!now) return '';
  const counts = new Map();
  for (const line of was.lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added = [];
  for (const line of now.lines) {
    const count = counts.get(line) ?? 0;
    if (count) counts.set(line, count - 1);
    else added.push(line);
  }
  if (!added.length) return '';
  const content = added.join('\n');
  const preview = content.slice(0, NEWS).toWellFormed();
  const more = content.length > NEWS ? '\n（还有新内容：cat --outline 看结构，或 cat | grep 找）' : '';
  return `\n新出现：\n${preview}${more}`;
}

// shortcut: 没有网站给出的就绪信号时，以 250ms 内文字长度和请求无变化为准；延迟更久才开始加载的详情需要用 expand --extract 校验。
async function waitForPage(p, deadline = Infinity) {
  const start = Date.now();
  let last, changed = start;
  while (pages.has(p.sid) && Date.now() < Math.min(start + 30000, deadline)) {
    if (!p.loading) {
      if (Date.now() - start >= 10000) break;
      // 只在能读到新内容时检查页面文字。超过 5 秒的请求可能是长连接。
      const now = Date.now();
      if (![...p.reqs.values()].some(t => now - t < 5000)) {
        const state = await run(p.sid, 'document.body && performance.timeOrigin + ":" + document.body.innerText.length').catch(() => null);
        const checked = Date.now();
        if (state !== last) { last = state; changed = checked; }
        if (state && !p.loading && checked - Math.max(changed, p.net) >= 250
          && ![...p.reqs.values()].some(t => checked - t < 5000)) break;
      }
    }
    await sleep(50);
  }
}

// was：动作之前 before() 读到的页面，给了就在结果后面附上新出现的文字
async function settle(p, was) {
  await waitForPage(p);
  if (pages.has(p.sid)) return (await call(p.sid, 'loc')) + await news(p.sid, was);
  // 弹出的窗口（比如“用 Google 登录”）做完会自己关掉：回到打开它的那个标签页
  if (!p.from) throw new Error('这个标签页已经被关掉了，用 tab 换一个');
  return `（弹出的窗口已关闭，已切回原来的标签页）\n${await settle(await use(p.from))}`;
}

// 点一个元素；点出了新标签页（比如“用 Google 登录”的弹窗）就跟过去，弹窗做完自己关掉时 settle 会再切回来
async function tap(p, r, done) {
  opened = null;
  const was = await before(p.sid);
  const gone = e => { if (pages.has(p.sid)) throw e; return {}; }; // 点完页面自己关掉了（登录弹窗常这样）：不算错，交给 settle 切回去
  const did = await call(r.s, 'click', r.i).catch(gone);
  if (did.stop) throw human(did.stop);
  if (did.x !== undefined) await mouse(p.sid, did.x, did.y).catch(gone); // 网页里已经确认过那个位置正是这个元素
  done();
  const loc = await settle(p, was);
  if (!opened) return loc;
  const np = Object.assign(await use(opened), { from: p.id });
  return `（打开了新标签页，已切换过去；用 tab 可以切回去）\n${await settle(np)}`;
}

// 第三方登录：按钮上写着这些名字之一，并且像是登录按钮（“Continue with Google”“使用 Apple 登录”，或只有一个名字的图标按钮）
const SSO = ['Google', 'Apple', 'Microsoft', 'GitHub', 'Facebook'];
const ssoOf = label => SSO.find(n => new RegExp(`\\b${n}\\b`, 'i').test(label)
  && (/sign|log|continue|with|登录|登入|使用|继续/i.test(label) || label.trim().toLowerCase() === n.toLowerCase()));

async function goto(p, url, settlePage = true) {
  p.response = null;
  const r = await B.send('Page.navigate', { url }, p.sid);
  if (!r.errorText && !r.isDownload) return settlePage ? settle(p) : undefined;
  if (r.isDownload) throw new Error('这个网址返回了下载文件');
  // 打不开时浏览器会停在错误页上：退回原来的页面，就像 cd 到不存在的目录后人还在原地
  await sleep(300);
  const stuck = await run(p.sid, 'location.href').then(u => u.startsWith('chrome-error:'), () => false);
  const h = await B.send('Page.getNavigationHistory', {}, p.sid);
  if (stuck && h.currentIndex > 0) await B.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id }, p.sid);
  throw new Error(`打不开 ${url}：${r.errorText}`);
}

function pageStatus(p, url) {
  const http = p.response?.url.split('#')[0] === url.split('#')[0] ? p.response.status : 0;
  const pathname = new URL(url).pathname;
  if (http === 429) return 'rate-limited';
  if (http === 401 || /(?:^|\/)(?:authwall|login|log-in|signin|sign-in|checkpoint)(?:\/|$)/i.test(pathname)) return 'login';
  if (http >= 400) return `http-${http}`;
}

async function readChecked(p, extract, sec, expected, deadline) {
  // 未指定条数时，先等页面稳定，再核对当时可见的全部标记。
  if (!expected) await waitForPage(p, deadline);
  let info, result, status = 'timeout';
  while (pages.has(p.sid)) {
    info = await call(p.sid, 'pageInfo').catch(() => null);
    if (info?.url && info.url !== 'about:blank') {
      const blocked = pageStatus(p, info.url);
      if (blocked) { status = blocked; break; }
      if (info.ready) {
        const full = await read(p.sid).catch(() => null);
        const scoped = full === null || !sec ? full : section(full, sec, true);
        result = scoped === null ? null : extract(scoped);
        if (result?.lines) {
          const after = await call(p.sid, 'pageInfo').catch(() => null);
          if (after?.url === info.url && after.originTime === info.originTime && after.ready) {
            return { ...after, status: 'ok', ...result };
          }
        }
      }
    }
    if (Date.now() >= deadline) {
      if (info?.ready && !p.loading && ![...p.reqs.values()].some(t => Date.now() - t < 5000)) status = 'incomplete';
      break;
    }
    await sleep(50);
  }
  return { ...info, status, count: result?.count ?? 0, markers: result?.markers ?? 0,
    ...(status === 'incomplete' && sec && !result ? { message: `没有找到段落“${sec}”` } : {}) };
}

function checkedOutput(pages, listing) {
  const output = pages.map(({ requested, url, status, count = 0, markers = 0, next, lines, message }) => {
    const source = url && url !== 'about:blank' && url !== requested ? `${requested} → ${url}` : requested;
    return [`==> ${source} | ${status} | ${count}/${markers} | next=${next ?? '未知'} <==`, message, ...(lines ?? [])]
      .filter(Boolean).join('\n');
  });
  return [...listing, ...output].join('\n');
}

const press = async (sid, key, code, text) => {
  await B.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code, text }, sid);
  await B.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code }, sid);
};
// 像人一样移过去、按下、松开鼠标左键（坐标是整个标签页里的位置）
const mouse = async (sid, x, y) => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await B.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 }, sid);
  }
};
const record = (argv, fresh) => fs[fresh ? 'writeFileSync' : 'appendFileSync'](FLOW_FILE, JSON.stringify(argv) + '\n');
// 截图和 PDF 存成文件，返回完整路径；没给文件名就存到 ~/.webshell/shots
// AI 指定的本机路径（上传、下载、截图）：网页内容可能诱导 AI 去碰敏感位置，这些地方一律拒绝——
// WebShell 自己的数据（密码本、浏览器登录资料）、点开头的配置目录（.ssh、.aws……）、浏览器资料目录、开机启动目录
// shortcut: 按位置名拦截，拦不住所有敏感文件；要更严就改成只允许指定的文件夹
// （Windows 的开机启动在 Start Menu\…\Startup，macOS 在 LaunchAgents / LaunchDaemons，浏览器资料在 User Data / Application Support，Linux 的都在点开头的目录里）
const SENSITIVE = /^(\..+|user data|start menu|startup|launchagents|launchdaemons|application support)$/i;
function guard(p) {
  let real = path.resolve(p);
  try { real = fs.realpathSync(real); } catch { // 还不存在的文件（要写的截图）：还原它所在文件夹的真实路径，防止借链接绕过
    try { real = path.join(fs.realpathSync(path.dirname(real)), path.basename(real)); } catch { /* 文件夹也还不存在：按字面路径判断 */ }
  }
  const inside = (dir, f) => !path.relative(dir, f).startsWith('..') && !path.isAbsolute(path.relative(dir, f));
  if (inside(path.resolve(HOME), real) || real.split(path.sep).some(s => SENSITIVE.test(s))) {
    throw Object.assign(new Error(`为了安全，不读写这个位置：${real}`), { exit: 2 });
  }
  return real;
}
const store = (file, ext, base64) => {
  const out = file ? guard(file) : path.join(HOME, 'shots', `${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`);
  if (file && fs.existsSync(out)) throw new Error(`已经有这个文件了，不覆盖：${out}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(base64, 'base64'));
  return out;
};

export const cmds = {
  async cd(p, [arg]) {
    if (!arg) return call(p.sid, 'loc');
    // Git Bash 会把以 / 开头的参数改写成 Windows 路径（/a/b 变成 C:/Program Files/Git/a/b），用它自带的 cygpath 还原
    const to = /^[a-z]:[\\/]/i.test(arg) ? spawnSync('cygpath', ['-u', arg], { encoding: 'utf8' }).stdout?.trim() || arg : arg;
    let url = abs(to);
    if (/^(\/|\.\.?(\/|$))/.test(to)) {
      const here = await run(p.sid, 'location.href');
      if (!/^https?:/.test(here)) throw new Error('还没打开任何网站：先 cd 到一个网址，才能用 cd /路径 或 cd ..');
      url = new URL(to, here).href;
    }
    const loc = await goto(p, url);
    record(['cd', url], true);
    return loc;
  },

  async ls(p, args) {
    const rows = await snapshot(p.sid), lines = rows.map(r => tail(r, args.includes('-l')));
    if (args.includes('--all')) return lines.map((line, i) => `${i + 1}\t${line}`).join('\n');
    // 引用角标（[1]、[note 2]）和“Jump up”这类回跳链接只在本页内跳转，几乎用不着点，维基百科上却有好几百个：不列出
    // （只认这几种写法：网站用 href="#..." 做的标签页、折叠按钮照样列出）
    const keep = rows.flatMap((r, i) => (r.kind === 'link' && !r.href && /^(\[[^\]]{1,20}\]|\^|↑|jump up.*)$/i.test(r.label) ? [] : [i + 1]));
    // 一模一样的行出现 5 次以上（每条新闻都有的“upvote”）合成一行：编号用逗号全列在第一列，照样能按编号点
    const nums = Map.groupBy(keep, n => lines[n - 1]);
    const out = keep.flatMap(n => {
      const g = nums.get(lines[n - 1]);
      return g.length < 5 ? [`${n}\t${lines[n - 1]}`] : g[0] === n ? [`${g.join(',')}\t${lines[n - 1]}`] : [];
    });
    if (keep.length < lines.length) out.push(`（另有 ${lines.length - keep.length} 个引用角标、回跳链接没列出：ls --all 看全部）`);
    return out.join('\n');
  },

  async cat(p, args) {
    const take = (flag, hasValue) => { // 从参数里取出一个选项
      const k = args.indexOf(flag);
      if (k < 0) return null;
      const [, v = ''] = args.splice(k, hasValue ? 2 : 1);
      if (hasValue && !v) throw new Error(`用法：cat [网址...] ${flag} <名字>`);
      return hasValue ? v : true;
    };
    const field = take('--field', true), sec = take('--section', true), toc = take('--outline', false);
    const pattern = take('--extract', true), marker = take('--check', true), size = take('--expect', true);
    const follow = take('--follow', true), limit = take('--limit', true);
    if (((marker || size || follow || limit) && !pattern) || (pattern && (!marker || field || toc))
      || (follow && args.length > 1) || (limit && !follow)
      || [size, limit].some(n => n && (!/^[1-9]\d*$/.test(n) || !Number.isSafeInteger(+n)))) {
      throw new Error("用法：cat [网址...] [--section 标题] --extract '正则' --check '标记' [--expect 条数] [--follow '链接文字正则' --limit 数量]");
    }
    const extract = pattern && extractor([pattern, '--check', marker], size ? +size : undefined);
    const shape = text => (toc ? outline(text) : sec ? section(text, sec) : text);
    const get = async sid => (field ? await call(sid, 'field', field) || '（未找到）' : shape(await read(sid)));
    const withPage = async (u, fn, settlePage = true) => {
      const { targetId } = await B.send('Target.createTarget', { url: 'about:blank', background: true });
      let timer;
      try {
        const t = await attach(targetId);
        const visit = async deadline => {
          await goto(t, abs(u), settlePage);
          return fn(t, deadline);
        };
        if (settlePage) return await visit();
        return await Promise.race([
          visit(Date.now() + CHECK_WAIT),
          new Promise(resolve => { timer = setTimeout(resolve, CHECK_WAIT + 500, { requested: u, status: 'timeout' }); }),
        ]);
      } finally {
        clearTimeout(timer);
        await B.send('Target.closeTarget', { targetId }).catch(() => {}); // 可能已经被关掉了
      }
    };
    let listing = [];
    if (follow) {
      new RegExp(follow, 'i'); // 网址打开前先验证规则
      const discover = async t => {
        const info = await call(t.sid, 'pageInfo');
        const status = pageStatus(t, info.url);
        const groups = status ? [] : await Promise.all([call(t.sid, 'links', follow), ...inner(t.sid).map(s =>
          run(s, `${SEEN} ? ${LIB}.links(${JSON.stringify(follow)}) : []`).catch(() => []))]);
        const links = [...new Set(groups.flat())];
        return { ...info, links, status };
      };
      const { url, next, links, status } = args.length ? await withPage(args[0], discover) : await discover(p);
      if (status) return checkedOutput([{ requested: args[0] ?? url, url, next, status }], []);
      args = links.slice(0, limit ? +limit : 8);
      listing = [`列表 ${url} | 候选 ${args.length}/${links.length} | next=${next ?? '未知'}`];
      if (!args.length) return listing.join('\n');
    }
    const check = async (u, t, deadline = Date.now() + CHECK_WAIT) =>
      ({ requested: u, ...await readChecked(t, extract, sec, size, deadline) });
    if (!args.length) return extract ? checkedOutput([await check(await run(p.sid, 'location.href'), p)], []) : get(p.sid);
    const out = [];
    for (let k = 0; k < args.length; k += 8) { // 每批最多 8 个标签页，别压垮自己的电脑和对方网站
      out.push(...await Promise.all(args.slice(k, k + 8).map(u => extract
        ? withPage(u, (t, deadline) => check(u, t, deadline), false).catch(e => ({ requested: u, status: 'error', message: e.message }))
        : withPage(u, t => get(t.sid)).catch(e => `（失败：${e.message}）`))));
    }
    if (extract) return checkedOutput(out, listing);
    return args.map((u, k) => (field ? `${u}\t${out[k]}` : `==> ${u} <==\n${out[k]}`)).join('\n');
  },

  async click(p, args) {
    const [t] = args.filter(a => a !== '--accept');
    if (!t) throw new Error('用法：click <编号|文字> [--accept]');
    const r = await pick(p.sid, t, false);
    accepting = args.includes('--accept');
    try {
      return await tap(p, r, () => record(['click', refOf(r), ...(accepting ? ['--accept'] : [])]));
    } finally {
      accepting = false;
    }
  },

  async expand(p, args) {
    const extractAt = args.indexOf('--extract');
    const rule = extractAt < 0 ? null : args.splice(extractAt).slice(1);
    const k = args.indexOf('--section');
    const catArgs = k < 0 ? [] : args.splice(k);
    if (!args.length || args.some(id => !/^[1-9]\d*$/.test(id))
      || (catArgs.length && (catArgs.length !== 2 || !catArgs[1] || catArgs[1].startsWith('--')))
      || (rule && (rule.length !== 3 || rule[1] !== '--check'))) {
      throw new Error("用法：expand <编号...> [--section 标题] [--extract '正则' --check '标记']");
    }
    const targets = [...new Set(args)].map(id => refs[id - 1]);
    if (targets.some(r => !r || top(r.s) !== p)) throw new Error('编号已失效，请先运行 ls');
    const { s } = targets[0];
    if (targets.some(r => r.s !== s)) throw new Error('一次只能展开同一个网页或内嵌页面的按钮');
    const ids = targets.map(r => r.i);
    const extract = rule && extractor(rule, ids.length);
    opened = null;
    const { stop } = await call(s, 'expand', ids);
    if (stop) throw human(stop);
    if (!extract) await waitForPage(p);
    const deadline = Date.now() + CHECK_WAIT;
    let error;
    do {
      if (opened || !pages.has(p.sid)) throw new Error('展开操作打开或关闭了标签页，请用 tab 查看');
      const checked = await call(s, 'expand', ids, true);
      if (checked.stop) throw human(checked.stop);
      if (checked.closed.length) error = `未展开：${checked.closed.join('、')}。请用 click 重试`;
      else {
        const full = await read(p.sid);
        const text = catArgs.length ? section(full, catArgs[1], !!extract) : full;
        if (!extract) return text;
        const result = text === null
          ? { error: `没有叫“${catArgs[1]}”的段落，先用 cat --outline 看目录` }
          : extract(text);
        if (!result.error) return result.lines.join('\n');
        error = result.error;
      }
      if (!extract) break;
      await sleep(50);
    } while (Date.now() < deadline);
    throw new Error(error);
  },

  // 一次可以填好几个框：type 姓名 张三 邮箱 a@b.c。网页只有一个输入焦点，所以还是一个个填，但只在最后等一次页面
  async type(p, args) {
    const enter = args.includes('--enter');
    const pairs = args.filter(a => a !== '--enter');
    if (!pairs.length || pairs.length % 2) throw new Error('用法：type <编号|文字> <内容> [<编号|文字> <内容> ...] [--enter]');
    const was = await before(p.sid);
    let r;
    for (let k = 0; k < pairs.length; k += 2) {
      const v = pairs[k + 1], last = k + 2 === pairs.length;
      r = await pick(p.sid, pairs[k], true);
      const did = await call(r.s, 'type', r.i, v, enter && last); // 回车只按在最后一个框上
      if (did.stop) throw human(did.stop);
      // 旧内容已被选中：有新内容就直接覆盖，没有就按一下退格删掉
      if (!did.done) await (v ? B.send('Input.insertText', { text: v }, r.s) : press(r.s, 'Backspace', 8));
      record(['type', refOf(r), v, ...(enter && last ? ['--enter'] : [])]);
    }
    if (enter) {
      await press(r.s, 'Enter', 13, '\r');
      return settle(p, was);
    }
    await settle(p); // 等一下：边打字边出的候选（比如城市名）要等后台请求回来；没有新内容就什么也不说
    return (await news(p.sid, was)).slice(1);
  },

  // 登录：用密码本里这个网站的账号填好用户名和密码并提交。密码只在这里解开一下就打进网页，不出现在任何输出、记录和错误信息里
  async login(p) {
    const book = vault(VAULT);
    const host = new URL(await run(p.sid, 'location.href')).hostname;
    const sso = new Map(); // 页面上的“用 Google / Apple 登录”按钮，每种取第一个
    for (const r of await snapshot(p.sid)) { const n = !r.field && ssoOf(r.label); if (n && !sso.has(n)) sso.set(n, r); }
    let f = null, s = null;
    for (const x of [p.sid, ...inner(p.sid)]) {
      f = await run(x, `${x === p.sid || SEEN} ? ${LIB}.loginFields() : null`).catch(() => null);
      if (f) { s = x; break; }
    }
    let acct = f && book[f.host]?.pass ? book[f.host] : null, way = acct ? null : book[host]?.sso;
    if (!acct && !way) {
      const options = [...sso.keys(), ...(f ? [PASSWORD] : [])];
      if (!options.length) throw new Error('这个页面上找不到登录框，也没有“用 Google / Apple 登录”这类按钮');
      // 第一次来这个网站：要请你本人选登录方式 / 填账号。窗口交给前台的 ws 去弹再重试：
      // 后台进程脱离了控制台，Windows 不给它弹出账号窗口（实测窗口根本不出现，login 就一直干等）
      if (sso.size || f.secure) throw Object.assign(new Error(`密码本里没有 ${f?.host ?? host} 的账号`), { ask: { host, account: f?.host, options } });
    }
    if (way) {
      const r = sso.get(way);
      if (!r) throw new Error(`这个页面上没有“用 ${way} 登录”的按钮（${host} 记住的登录方式是它；想换方式就 ws pass rm ${host}）`);
      return `用 ${way} 登录：\n${await tap(p, r, () => record(['login']))}`;
    }
    // 只认完全相同的网站名，并且必须是加密连接：长得像的钓鱼网站、明文传输的页面都拿不到密码
    if (!f.secure) throw new Error(`${f.host} 不是加密连接（https），不在这里填密码`);
    const values = [f.user ? acct.user : '', f.pass ? reveal(acct.pass) : ''];
    for (const k of [0, 1]) {
      if (!values[k]) continue;
      await call(s, 'focusLogin', k);
      await B.send('Input.insertText', { text: values[k] }, s);
    }
    await press(s, 'Enter', 13, '\r');
    record(['login']);
    // 密码提交后的网页可能回显凭据，只返回页面位置。
    return `已用密码本里 ${f.host} 的账号填好并提交\n${await settle(p)}`;
  },

  async scroll(p, [n = '1']) {
    if (Number.isNaN(+n)) throw new Error('用法：scroll [屏数]（负数向上）');
    // 像人滚滚轮一样，滚的是视野正中的那一块：很多网站滚动的不是整个页面，而是里面的一栏
    const [w, h] = await run(p.sid, '[innerWidth, innerHeight]');
    const was = await before(p.sid);
    await B.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: w / 2, y: h / 2, deltaX: 0, deltaY: h * 0.9 * n }, p.sid);
    return settle(p, was);
  },

  async tab(p, [n]) {
    const all = await tabs();
    if (!n) return all.map((t, i) => `${i + 1}${t.targetId === p.id ? '*' : ''}\t${t.title.slice(0, 60)}\t${t.url.slice(0, 100)}`).join('\n');
    if (n === 'close') {
      await B.send('Target.closeTarget', { targetId: p.id });
      if (p.from) fs.writeFileSync(TAB_FILE, p.from); // 回到上一个标签页（接管你自己的 Chrome 时不碰你的其他标签页，否则只能新开一个空白页）
      P = null;
      return '已关掉当前标签页；下一条命令会用剩下的标签页';
    }
    const t = all[n - 1];
    if (!t) throw new Error('没有这个标签页，先运行 tab 看列表');
    return call((await use(t.targetId)).sid, 'loc');
  },

  async upload(p, args) {
    const k = args.indexOf('--to'), to = k < 0 ? null : args.splice(k, 2)[1];
    if (!args.length || (k >= 0 && !to)) throw new Error('用法：upload <文件...> [--to 编号|文字]');
    const missing = args.map(f => path.resolve(f)).find(f => !fs.statSync(f, { throwIfNoEntry: false })?.isFile());
    if (missing) throw new Error(`找不到文件：${missing}`);
    const files = args.map(guard);
    const r = to ? await pick(p.sid, to, false) : { s: p.sid };
    await call(r.s, 'fileInput', r.i);
    const { result } = await B.send('Runtime.evaluate', { expression: 'window.__file' }, r.s);
    const was = await before(p.sid);
    await B.send('DOM.setFileInputFiles', { files, objectId: result.objectId }, r.s);
    return `已选好 ${files.length} 个文件\n${await settle(p, was)}`;
  },

  async download(p, [t, dir]) {
    if (!t) throw new Error('用法：download <编号|文字> [文件夹]');
    const folder = guard(dir ?? path.join(os.homedir(), 'Downloads'));
    fs.mkdirSync(folder, { recursive: true });
    await B.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: folder, eventsEnabled: true });
    try {
      dl = null;
      await cmds.click(p, [t]);
      for (let i = 0; i < 600 && !dl?.state; i++) await sleep(100); // 最多等 60 秒
      if (!dl) throw new Error('点了之后没有开始下载');
      if (dl.state !== 'completed') throw new Error(dl.state === 'canceled' ? '下载被取消了' : '下载超过 60 秒还没完成');
      return path.join(folder, dl.name);
    } finally {
      await B.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {}); // 还原成浏览器原来的下载设置
    }
  },

  async screenshot(p, args) {
    const full = args.includes('--full'), [file] = args.filter(a => a !== '--full');
    const s = full && (await B.send('Page.getLayoutMetrics', {}, p.sid)).cssContentSize;
    const clip = full ? { x: 0, y: 0, width: s.width, height: s.height, scale: 1 } : undefined;
    return store(file, 'png', (await B.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: full }, p.sid)).data);
  },

  async pdf(p, [file]) {
    return store(file, 'pdf', (await B.send('Page.printToPDF', { printBackground: true }, p.sid)).data);
  },

  async mobile(p, [mode]) {
    if (!/^(on|off)$/.test(mode ?? '')) throw new Error('用法：mobile on|off');
    phone = mode === 'on';
    // 关掉时重新接入这个标签页：模拟设置跟着旧连接一起作废，比一项项改回去简单
    const np = phone ? (await phoneOn(p.sid), p) : await use(p.id);
    await B.send('Page.reload', {}, np.sid);
    return settle(np);
  },

  async run(p, [name, ...params]) {
    const file = path.join(MACROS, `${name}.jsonl`);
    if (!NAME.test(name ?? '') || !fs.existsSync(file)) throw new Error(`没有叫“${name ?? ''}”的流程（流程文件都在 ${MACROS}）`);
    let out;
    for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
      const [cmd, ...args] = JSON.parse(line).map(a => a.replace(/\$(\d)/g, (m, n) => params[n - 1] ?? m));
      if (!['cd', 'click', 'type', 'login'].includes(cmd)) throw new Error(`流程文件里有不认识的命令：${cmd}`);
      out = await cmds[cmd](P ?? p, args); // 中途点出了新标签页时，后面的步骤在新标签页上做
    }
    return out;
  },
};

async function dispatch([cmd, ...args]) {
  if (cmd === 'exit') { // 只关 WebShell 自己的浏览器；接管的是你自己的 Chrome 时，退出后台进程就等于断开
    if (!B) await closeOwn(); else if (!B.mine) await Promise.race([B.send('Browser.close'), B.closed]);
    return '';
  }
  if (!Object.hasOwn(cmds, cmd)) throw new Error(`没有 ${cmd} 这个命令，运行 help 看用法`);
  await browser();
  let timer;
  const stuck = new Promise((_, fail) => { timer = setTimeout(fail, 120000, new Error('超过 2 分钟没有完成，页面可能卡住了')); });
  return Promise.race([cmds[cmd](await current(), args), stuck]).finally(() => clearTimeout(timer));
}

export function serve() {
  fs.mkdirSync(HOME, { recursive: true });
  // shortcut: macOS/Linux 上两条命令恰好同时启动后台进程时，后一个会顶掉前一个（前一个留到浏览器关闭）；真遇到再改成先试连
  if (process.platform !== 'win32') fs.rmSync(SOCK, { force: true }); // 上次留下的旧文件
  let queue = Promise.resolve(); // 命令排队，一条一条执行
  net.createServer(sock => {
    let buf = '';
    sock.on('error', () => {}); // 传话的那头提前断开，不影响后台进程
    sock.on('data', d => {
      buf += d;
      if (!buf.endsWith('\n')) return;
      let msg;
      try { msg = JSON.parse(buf); } catch { sock.destroy(); return; } // 不是自己的客户端发来的就不理，也不能因此崩掉
      const { argv, v, cwd } = msg;
      queue = queue.then(async () => {
        try { process.chdir(cwd); } catch { /* 文件路径按传话那一头的当前文件夹算；那个文件夹不在了就留在原处 */ }
        const res = v > VERSION ? { stale: true } // 传话的是新版代码：旧的后台进程让位
          : v < VERSION ? { out: '', err: 'WebShell 已更新：请重新启动正在用它的程序（比如 Claude Desktop）后再试', code: 1 }
          : await dispatch(argv).then(out => ({ out: out || '', code: 0 }), e => ({ out: '', err: e.message, code: e.exit ?? 1, ask: e.ask }));
        res.err = [...notes.splice(0), res.err].filter(Boolean).join('\n');
        sock.end(JSON.stringify(res), () => { if (res.stale || argv[0] === 'exit') process.exit(0); });
      });
    });
  }).on('error', () => process.exit(1)).listen(SOCK); // 监听失败 = 已经有一个后台进程了
}
