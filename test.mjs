// 自检：起一个本地小网站，用真实的 Chrome（无界面模式）把每条命令跑一遍。运行：node --test
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { newLines, onlyNames } from './text.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'webshell-test-')); // 不碰真实的 ~/.webshell
const CLI = fileURLToPath(new URL('webshell.mjs', import.meta.url));
const env = { ...process.env, WS_HOME: HOME, WS_HEADLESS: '1', WS_BROWSER: 'own' }; // 专用浏览器、无界面，不接管真实的 Chrome
const wsWith = vars => (...args) => new Promise(done => execFile(process.execPath, [CLI, ...args], { env: vars },
  (e, out, err) => done({ out: out.trim(), err: err.trim(), code: e?.code ?? 0 })));
const ws = wsWith(env);
// 给交互模式 / MCP 喂几行输入，拿回全部输出
const feed = (mode, input) => new Promise(done => {
  const p = spawn(process.execPath, [CLI, mode], { env });
  let out = '';
  p.stdout.on('data', d => { out += d; });
  p.on('close', () => done(out));
  p.stdin.end(input);
});
const mcpCall = async command => JSON.parse((await feed('mcp', `${JSON.stringify(
  { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ws', arguments: { command } } })}\n`)).trim()).result;
const TEST_PW = 'Tst-pw-12345'; // 只给本地测试网站用的假密码

const SHOP = `<title>Shop</title>
<script type="application/ld+json">{"@type":"Product","offers":{"price":"19.99"}}</script>
<main><h1>Hello WebShell</h1> <iframe src="/about"></iframe> <iframe src="/xframe"></iframe>
<iframe src="/xframe?second"></iframe>
<a href="/about" target="_blank">About us</a> <a href="/slow">Slow link</a>
<button>Status for Lesson One</button> <a href="/about">Lesson One</a> <a href="#">Hash link</a> <button></button>
<span id="term">Term</span><input aria-labelledby="term">
<button>&#xE87C; Icon button</button> <button aria-expanded="true">Menu</button> <input placeholder="Locked" disabled>
<button onclick="this.innerText='Clicked'">Press me</button>
<button onclick="if (event.isTrusted) this.innerText = 'Real click'">Trusted only</button>
<div style="position:relative;display:inline-block"><button onclick="this.innerText='Covered clicked'">Covered</button><div style="position:absolute;inset:0"></div></div>
<button onclick="window.open('/about')">Open popup</button>
<button onclick="window.open('/oauth')">Sign in popup</button>
<button onclick="if (confirm('Delete it?')) this.innerText = 'Deleted'">Delete</button>
<button onclick="if (confirm('Pay $50 now?')) this.innerText = 'Paid'">Checkout step</button>
<button onclick="fetch('/data').then(r => r.text()).then(t => { this.innerText = t; })">Load data</button>
<button onclick="alert('hi');this.innerText='Alerted'">Alert me</button>
<a href="/file.txt" download>Get file</a>
<form action="/upload" method="post" enctype="multipart/form-data"><label>Attach<input type="file" name="doc" style="display:none"></label><button>Send file</button></form>
<x-card></x-card><script>
customElements.define('x-card', class extends HTMLElement { connectedCallback() {
  const root = this.attachShadow({ mode: 'open' });
  root.innerHTML = '<p>Shadow text</p><button>Shadow button</button>';
  root.querySelector('button').onclick = e => { e.target.innerText = 'Shadow clicked'; };
} });
</script>
<form action="/search"><input name="q" placeholder="Search"><select name="color" aria-label="Color"><option>Red<option>Blue</select></form>
<form action="/search"><input name="user" placeholder="User"><input type="password" placeholder="Password"><button>Sign in</button></form>
<form action="/search"><input name="note" placeholder="Note"><button>Pay now</button></form>
<form id="pf" action="/search"><input name="memo" placeholder="Memo"></form><button form="pf">Buy now</button>
<form action="/search"><input name="cardnumber" placeholder="Card number"><button>Continue</button></form>
<div role="button" onclick="this.innerText='Logged in'">Log in</div> <button>Allow</button>
<button>Place order</button></main>
<div style="height:3000px"></div><p id="lazy"></p>
<script>addEventListener('scroll', () => { document.getElementById('lazy').textContent = 'Lazy loaded'; });</script>`;
const EMBEDDED = `<p>Embedded page</p><button onclick="this.innerText='Frame clicked'">Frame button</button><input placeholder="Frame field">`;
const LOGIN = `<title>Login</title><form action="/welcome" method="post">
<input name="user" autocomplete="username" placeholder="Email"><input type="password" name="pw" placeholder="Password"><button>Sign in</button></form>`;
// 动作之后只报告新出现的文字；同样的按钮出现 10 次以上，ls 里合成一行
const FEED = `<title>Feed</title><ul id="f"><li>Item 1</li><li>Item 2</li></ul>
<button onclick="document.getElementById('f').insertAdjacentHTML('beforeend', '<li>Item 3</li><li>Item 4</li>')">Load more</button>
<button onclick="for (let i = 0; i < 300; i++) document.getElementById('f').insertAdjacentHTML('beforeend', '<li>Row ' + i + ' of a long list</li>')">Load lots</button>
<button>Nothing</button> <a href="/about">Go about</a>
<button onclick="document.getElementById('f').insertAdjacentHTML('beforeend', '<li>Item 1</li>')">Repeat item</button>
<button onclick="document.getElementById('f').insertAdjacentHTML('beforeend', '<li>' + 'A'.repeat(3000) + '</li>')">Long line</button>
<input placeholder="City" oninput="document.getElementById('s').textContent = this.value ? 'Toronto Pearson (YYZ)' : ''"><p id="s"></p>
<input placeholder="Name"><input placeholder="Email">
<p>Fact<sup><a href="#n1">[1]</a></sup><sup><a href="#n2">[2]</a></sup> <a href="#r1">^</a> <a href="#tab2">Reviews</a> ${'<a href="/share">Share</a> '.repeat(5)}</p>
${Array.from({ length: 12 }, (_, i) => `<p>Story ${i} <button onclick="this.textContent = 'voted ${i}'">upvote</button></p>`).join('\n')}`;
// 点开的菜单、悬停才出来的菜单、按键、等内容出来、表格
const TOOLS = `<title>Tools</title><style>#sub { display: none; position: absolute } #products:hover #sub { display: block }</style>
<h1>Tools</h1><div id="products"><button>Products</button><div id="sub"><a href="/about">Hover link</a></div></div>
<button onclick="document.getElementById('menu').hidden = false">Open menu</button>
<div id="menu" hidden><a href="/about">Menu about</a> <button onclick="this.textContent = 'Menu done'">Menu action</button>
<button onclick="document.getElementById('menu').hidden = true">Hide menu</button></div>
<button onclick="this.textContent = 'After clicked'">After menu</button>
<input placeholder="Keys" onkeydown="document.getElementById('k').textContent = (event.shiftKey ? 'Shift+' : '') + event.key"><p id="k"></p>
<button onclick="setTimeout(() => { document.getElementById('later').textContent = 'Ready now'; }, 1500)">Later</button><p id="later"></p>
<table><caption>Prices</caption><tr><th>Item</th><th>Price</th></tr><tr><td>Tea</td><td>3</td></tr></table>
<div role="table" aria-label="Stock"><div role="row"><span role="columnheader">Item</span> <span role="columnheader">Left</span></div>
<div role="row"><span role="cell">Tea</span> <span role="cell">7</span></div></div>
<table><caption>Spans</caption><tr><th>OS</th><th>Version</th><th>Year</th></tr>
<tr><td rowspan="2">Linux</td><td>1.0</td><td>2020<sup class="reference">[1]</sup></td></tr><tr><td>2.0</td><td>2021</td></tr>
<tr><td colspan="2">Windows 11</td><td>2022</td></tr></table>
<table role="presentation"><tr><td>Layout</td><td>only</td></tr></table>
<ul><li role="menuitem"><a href="/about">Docs link</a></li></ul> <a href="/limited-empty">Go limited</a>
<button onclick="history.pushState({}, '', '/tools/next'); document.querySelector('h1').textContent = 'Next page'">Route</button>`;
// 付款控件放在别的网站嵌进来的页面里（Stripe、PayPal 都这样），还有认不出名字的按钮；?focus：内嵌页面自己把焦点放到付款按钮上
const PAYFRAME = q => `<title>Pay frame</title><input placeholder="Before"><x-closed></x-closed>
<input placeholder="Jumpy" onfocus="setTimeout(() => document.querySelector('iframe').focus())">
<iframe src="/xpay${q}" width="400" height="160"></iframe>
${q ? '' : '<form action="/search"><input name="gift" placeholder="Gift note"><input type="image" alt="Buy now" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></form>'}
<script>customElements.define('x-closed', class extends HTMLElement { connectedCallback() {
  this.attachShadow({ mode: 'closed' }).innerHTML = '<button onclick="document.title = \\'PAID\\'">Pay now</button>'; } });</script>`;
const PAYBOX = q => `<button onclick="this.textContent = 'Frame paid'">Pay frame</button>
<form onsubmit="event.preventDefault(); this.querySelector('p').textContent = 'Frame submitted'">
<input autocomplete="cc-number" placeholder="Frame card"><button>Frame submit</button><p></p></form>
${q ? '<script>document.querySelector("button").focus()</script>' : ''}`;
let posts = 0; // 表单被提交了几次（手机模式切换不能把它再提交一遍）
const body = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; }).on('end', () => r(b)); });
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (u.pathname === '/slow') setTimeout(() => res.end('<title>Slow</title><p>Slow page</p>'), 1500); // 验证会等页面加载完
  else if (u.pathname === '/about') res.end('<title>About</title><p>About page</p>');
  else if (u.pathname === '/candidates') res.end(`<link rel="next" href="/candidates?page=2">
    <main><a href="/deferred">Test job A</a><a href="/deferred">Test job A duplicate</a>
    <a href="/job-redirect">Test job B</a><a href="/job-blocked">Test job C</a><a href="/job-rate">Test job D</a>
    <a href="/job-hidden" hidden>Test job hidden</a><a href="/job-payment">Pay for test job</a></main>`);
  else if (u.pathname === '/job-redirect') res.writeHead(302, { location: '/job-detail' }).end();
  else if (u.pathname === '/job-detail') res.end('<main><p>Data loaded</p><a rel="next" href="/about">Next</a></main>');
  else if (u.pathname === '/job-blocked') res.writeHead(302, { location: '/authwall' }).end();
  else if (u.pathname === '/authwall') res.end('<title>Sign In</title><h1>Sign In</h1>');
  else if (u.pathname === '/job-rate') res.writeHead(429).end('<p>Too many requests</p>');
  else if (u.pathname === '/job-slow') res.write('<p>Loading</p>'); // 浏览器一直等不到文档结束
  // 像“用 Google 登录”的弹窗：点完自己关掉
  else if (u.pathname === '/oauth') res.end('<title>OAuth</title><button onclick="window.close()">Continue</button>');
  else if (u.pathname === '/article') res.end(`<title>Article</title><main><h1>Guide</h1><p>Intro</p>
    <h2>Setup</h2><p>Install it</p><h3>Windows</h3><p>Use the installer</p><h2>Usage</h2><p>Run it</p><p>Then stop</p></main>`);
  else if (u.pathname === '/data') setTimeout(() => res.end('Data loaded'), 2000); // 点按钮后要 2 秒才回来的后台请求
  else if (u.pathname === '/deferred') res.end(`<title>Deferred</title><p id="result">Loading</p>
    <script>setTimeout(() => fetch('/data').then(r => r.text()).then(text => {
      document.getElementById('result').textContent = text;
    }), 200)</script>`);
  // 一直开着的推送连接：不能让每条命令都等它
  else if (u.pathname === '/sse') res.end('<title>Live</title><p>Live page</p><script>new EventSource("/events")</script>');
  else if (u.pathname === '/poll') res.end('<title>Poll</title><p>Poll page</p><script>fetch("/events")</script>'); // 永远不回来的数据请求
  else if (u.pathname === '/events') res.writeHead(200, { 'content-type': 'text/event-stream' }).write('data: hi\n\n');
  // 同一个服务换个主机名就是“别的网站”，用来模拟跨站的内嵌页面
  else if (u.pathname === '/xframe') res.writeHead(302, { location: `http://localhost:${server.address().port}/embedded${u.search}` }).end();
  else if (u.pathname === '/embedded') res.end(u.search ? '<p>Second frame</p><button>Second frame button</button>' : EMBEDDED);
  else if (u.pathname === '/search') res.end(`<title>Results</title><p>q=${u.searchParams.get('q')} color=${u.searchParams.get('color')}</p>`);
  else if (u.pathname === '/login') res.end(LOGIN);
  else if (u.pathname === '/login-echo') res.end(LOGIN + '<p id="echo"></p><script>document.querySelector("form").onsubmit = e => { e.preventDefault(); document.getElementById("echo").textContent = e.target.elements.pw.value; };</script>');
  else if (u.pathname === '/feed') res.end(FEED);
  else if (u.pathname.startsWith('/tools')) res.end(TOOLS);
  else if (u.pathname === '/payframe') res.end(PAYFRAME(u.search));
  else if (u.pathname === '/xpay') res.writeHead(302, { location: `http://localhost:${server.address().port}/paybox${u.search}` }).end();
  else if (u.pathname === '/paybox') res.end(PAYBOX(u.search));
  else if (u.pathname === '/count-form') res.end('<title>Count</title><form method="post" action="/counted"><button>Submit</button></form>');
  else if (u.pathname === '/counted') { if (req.method === 'POST') posts++; res.end(`<title>Counted</title><p>posts=${posts}</p>`); }
  else if (u.pathname === '/wiki/CAPTCHA') res.end('<title>CAPTCHA - Wikipedia</title><p>A CAPTCHA is a test</p>'); // 只是提到 captcha 的普通页面
  else if (u.pathname === '/limited') res.writeHead(429).end('<title>Slow down</title><p>Too many requests</p>');
  else if (u.pathname === '/limited-empty') res.writeHead(429).end(); // 很多网站限流时什么也不返回
  else if (u.pathname === '/gone') res.writeHead(404).end('<title>Gone</title><p>No such page</p>');
  else if (u.pathname === '/challenge') res.end('<title>Just a moment...</title><p>Checking your browser</p>');
  else if (u.pathname === '/private') res.writeHead(302, { location: '/login' }).end();
  // 长表单：两组里都有“First name”
  else if (u.pathname === '/order') res.end(`<title>Order</title><h1>Checkout</h1><a href="/about">Help</a><form>
    <h2>Shipping address</h2><input placeholder="First name"><input placeholder="City">
    <fieldset><legend>Billing address</legend><input placeholder="First name"><select aria-label="Country"><option>Canada</option><option>USA</option></select></fieldset>
    <h2>Options</h2><label><input type="checkbox"> Gift wrap</label><button type="button">Continue</button></form>`);
  else if (u.pathname === '/expand') res.end(`<title>Expand</title><main><h2 hidden>Flights</h2>
    <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true'); setTimeout(()=>document.querySelector('h2').hidden=false,300); fetch('/data').then(r=>r.text()).then(t=>this.nextElementSibling.textContent=t)">Flight details</button><p>Loading</p>
    <details><summary>Details</summary><p>Arrives at 12:30 AM+1</p></details>
    <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');this.nextElementSibling.textContent='Ready';fetch('/events')">Open with background request</button><p></p>
    <button aria-expanded="false">Stays closed</button>
    <button aria-expanded="false" onclick="document.body.textContent='Paid'">Pay now</button>
    <a href="/about" aria-expanded="false" role="button">Link</a></main>`);
  else if (u.pathname === '/sso') res.end(`<title>SSO</title><button onclick="window.open('/oauth')">Continue with Google</button>
    <button aria-label="Sign in with Apple"></button><a href="/login">Log in with email</a>`);
  else if (u.pathname === '/welcome') { // 不把密码写回页面，只说对不对
    const f = new URLSearchParams(await body(req));
    res.end(`<title>Welcome</title><p>user=${f.get('user')} pw_ok=${f.get('pw') === TEST_PW}</p>`);
  } else if (u.pathname === '/upload') res.end(`<title>Uploaded</title><p>got=${(await body(req)).includes('hello upload')}</p>`);
  else if (u.pathname === '/file.txt') res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="file.txt"' }).end('hello file');
  else if (u.pathname === '/ua') res.end(`<title>UA</title><meta name="viewport" content="width=device-width"><p id="ua"></p><script>
    document.getElementById('ua').textContent = (/iPhone/.test(navigator.userAgent) ? 'phone ' : 'desktop ') + innerWidth</script>`);
  else res.end(SHOP);
});
let base;

before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await ws('exit');
  server.closeAllConnections(); // 推送连接一直开着，不主动断开测试就退不出
  server.close();
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); // Chrome 退出需要一点时间才放开文件
});

test('cd / ls / cat：网站即文件系统', async () => {
  assert.match((await ws('cd', base)).out, /^Shop — /);
  const ls = (await ws('ls')).out;
  assert.match(ls, /\tlink\tAbout us$/m);
  assert.match(ls, /\tbutton\tPress me$/m);
  assert.match(ls, /\tbutton\tIcon button$/m); // 图标字体的私有字符被去掉
  assert.match(ls, /\tbutton\tMenu\texpanded$/m); // 展开、勾选之类的状态直接列出
  assert.match(ls, /\tpassword\tPassword\t（用 login 填）/);
  assert.match(ls, /\ttext\tCard number\t（需本人输入）/);
  assert.match(ls, /\tbutton\tPlace order\t（需本人点击）/);
  assert.match(ls, /\tlink\tHash link$/m);
  assert.match(ls, /\ttext\tTerm$/m); // aria-labelledby 指向的文字就是名字
  assert.doesNotMatch(ls, /\tbutton$/m); // 没有文字的按钮不列出来
  assert.match((await ws('ls', '-l')).out, /\tlink\tAbout us\t\/about$/m); // -l 才带链接地址
  const cat = (await ws('cat')).out;
  assert.match(cat, /^# Hello WebShell$/m); // 标题前加 #
  assert.match(cat, /About page/); // 同源 iframe 的文字
  assert.match(cat, /Shadow text/); // shadow DOM 里的文字
  assert.match(cat, /--- 内嵌页面 http:\/\/localhost:\d+\/embedded ---\nEmbedded page/); // 跨站 iframe
  assert.match(cat, /\nSecond frame\nSecond frame button/);
  const frameButtons = ls.split('\n').filter(line => /\t(?:Frame|Second frame) button$/.test(line));
  assert.equal(frameButtons.length, 2);
  assert.equal(frameButtons[0].endsWith('\tFrame button'), cat.indexOf('Embedded page') < cat.indexOf('Second frame'));
  assert.equal((await ws('cd', 'http://127.0.0.1:1/')).code, 1); // 打不开的网址：报错，并且人还在原来的页面
  assert.match((await ws('cd')).out, /^Shop — /);
  assert.match((await ws('cd', '/slow')).out, /^Slow — /);
  assert.match((await ws('cd', '..')).out, /^Shop — /);
});

test('click / type：真实点击、弹窗、选下拉框、输入并回车提交', async () => {
  const vague = await ws('click', 'Lesson'); // 对应两个元素：不猜，列出候选
  assert.equal(vague.code, 1);
  assert.match(vague.err, /对应 2 个元素.*\n\d+\tbutton\tStatus for Lesson One\n\d+\tlink\tLesson One/);
  assert.match((await ws('click', 'Lesson One')).out, /^About — /); // 完全一致的只有链接
  await ws('cd', base);
  await ws('click', 'Load data'); // 要等点击触发的后台请求回来，下一条 ls 才看得到结果
  assert.match((await ws('ls')).out, /\tbutton\tData loaded$/m);
  await ws('cd', '/deferred');
  assert.equal((await ws('cat')).out, 'Data loaded'); // 导航加载完后才发出的短延迟请求也要等
  let started = Date.now();
  assert.match((await ws('cd', '/sse')).out, /^Live — /);
  assert.ok(Date.now() - started < 4000, '推送连接不用等');
  started = Date.now();
  assert.match((await ws('cd', '/poll')).out, /^Poll — /);
  assert.ok(Date.now() - started < 8000, '永远不回来的请求最多等 5 秒');
  await ws('cd', base);
  await ws('click', 'Press me');
  await ws('click', 'Trusted only'); // 只认真实鼠标点击的按钮
  await ws('click', 'Covered'); // 被透明层挡住：退回脚本点击
  let ls = (await ws('ls')).out;
  assert.match(ls, /\tbutton\tClicked$/m);
  assert.match(ls, /\tbutton\tReal click$/m);
  assert.match(ls, /\tbutton\tCovered clicked$/m);
  assert.match((await ws('click', 'Alert me')).err, /弹窗已取消：hi/);
  assert.match((await ws('click', 'Delete')).err, /弹窗已取消：Delete it\?（要点“确定”/);
  assert.match((await ws('click', 'Delete', '--accept')).err, /弹窗已确认：Delete it\?/);
  assert.match((await ws('click', 'Checkout step', '--accept')).err, /弹窗已取消：Pay \$50 now\?（跟付款有关/); // 付款弹窗不替你确认
  ls = (await ws('ls')).out;
  assert.match(ls, /\tbutton\tAlerted$/m);
  assert.match(ls, /\tbutton\tDeleted$/m);
  assert.match(ls, /\tbutton\tCheckout step$/m);
  await ws('type', 'Color', 'Blue');
  assert.match((await ws('type', 'Locked', 'x')).err, /不能输入/); // 焦点进不去的框不打字
  await ws('type', 'Search', 'draft');
  await ws('type', 'Search', ''); // 清空
  assert.match((await ws('ls')).out, /\ttext\tSearch$/m);
  assert.match((await ws('type', 'Search', 'hello', '--enter')).out, /^Results — /);
  assert.equal((await ws('cat')).out, 'q=hello color=Blue');
  await ws('cd', base);
  assert.match((await ws('click', 'Slow link')).out, /^Slow — /);
});

test('新标签页：点出来自动跟过去，tab 列出 / 切换 / 关闭', async () => {
  await ws('cd', base);
  assert.match((await ws('click', 'Open popup')).out, /新标签页.*\nAbout — /);
  assert.match((await ws('tab')).out, /^\d+\*\tAbout\t/m);
  assert.match((await ws('tab', 'close')).out, /已关掉/);
  assert.match((await ws('cd')).out, /^Shop — /); // 回到剩下的那个标签页
  // 弹窗做完自己关掉（第三方登录就是这样）：自动回到打开它的那个页面，不报错
  assert.match((await ws('click', 'Sign in popup')).out, /新标签页.*\nOAuth — /);
  assert.match((await ws('click', 'Continue')).out, /已关闭.*\nShop — /);
  assert.match((await ws('cd')).out, /^Shop — /);
  // 按键点出的新标签页也跟过去；切回来后，之前给出的编号照样指向原来的元素
  const pressMe = (await ws('ls')).out.match(/^(\d+)\tbutton\tPress me$/m)[1];
  assert.match((await ws('press', 'Enter', 'Open popup')).out, /新标签页.*\nAbout — /);
  await ws('tab', 'close');
  assert.match((await ws('click', pressMe)).out, new RegExp(`\\n${pressMe}\\tbutton\\tClicked$`));
});

test('expand 批量展开、等待异步内容并复用提取校验', async () => {
  await ws('cd', base + '/expand');
  const ls = (await ws('ls')).out.split('\n');
  const id = label => ls.find(row => row.split('\t')[2] === label).split('\t')[0];
  const flight = id('Flight details'), details = id('Details');
  for (const label of ['Pay now', 'Link']) {
    const blocked = await ws('expand', details, id(label));
    assert.equal(blocked.code, label === 'Pay now' ? 2 : 1);
    assert.doesNotMatch((await ws('cat')).out, /Arrives|Paid/);
  }
  const command = `expand ${flight} ${details} ${details} --section Flights --extract '^(Data loaded|Arrives at .+)$' --check '^(Data loaded|Arrives at .+)$'`;
  // 先有展开状态，正文稍后才到。已经匹配的一条也不能被当成完整结果。
  assert.equal((await mcpCall(command)).content[0].text, 'Data loaded\nArrives at 12:30 AM+1');
  assert.equal((await mcpCall(command)).content[0].text, 'Data loaded\nArrives at 12:30 AM+1');
  assert.match((await ws('expand', id('Stays closed'))).err, /未展开/);
  const started = Date.now();
  const ready = await ws('expand', id('Open with background request'), '--extract', '^Ready$', '--check', '^Ready$');
  assert.deepEqual(ready, { code: 0, out: 'Ready', err: '' });
  assert.ok(Date.now() - started < 4000, '已验证完整的结果不用等无关的后台请求');
});

test('省 token：动作之后只报告新出现的文字；同样的按钮在 ls 里合成一行，编号照样能点', async () => {
  const feed = `${base}/feed`;
  await ws('cd', feed);
  assert.equal((await ws('click', 'Load more')).out, `Feed — ${feed}\n新出现：\nItem 3\nItem 4`);
  assert.equal((await ws('click', 'Nothing')).out, `Feed — ${feed}`); // 页面没变：只报位置
  const lots = (await ws('click', 'Load lots')).out;
  assert.match(lots, /^新出现：\nRow 0 of a long list$/m);
  assert.match(lots, /\n（还有新内容：cat --outline/);
  assert.ok(lots.length < 2600, `新内容有上限，实际 ${lots.length} 字`);
  assert.match((await ws('click', 'Repeat item')).out, /\n新出现：\nItem 1$/);
  assert.match((await ws('click', 'Long line')).out, /\n新出现：\nA{2000}\n（还有新内容/);
  assert.equal((await ws('type', 'City', 'tor')).out, '新出现：\nToronto Pearson (YYZ)'); // 边打字边出的候选
  assert.equal((await ws('type', 'City', 'tors')).out, ''); // 没有新内容就什么也不说
  assert.equal((await ws('type', 'Name', 'Ann', 'Email', 'a@b.c')).out, ''); // 一次填好几个框，只在最后等一次
  assert.match((await ws('type', 'Name', 'Ann', 'Email')).err, /用法/); // 框和内容要成对
  const ls = (await ws('ls')).out;
  assert.match(ls, /\ttext\tName\tAnn$/m);
  assert.match(ls, /\ttext\tEmail\ta@b\.c$/m);
  assert.doesNotMatch(ls, /\[1\]|\t\^$/m); // 引用角标、回跳链接不列出……
  assert.match(ls, /^（另有 3 个引用角标、回跳链接没列出/m);
  assert.match(ls, /\tlink\tReviews$/m); // ……但用 #链接 做的标签页照样列出
  assert.match(ls, /^(?:\d+,){4}\d+\tlink\tShare$/m); // 出现 5 次就合并
  assert.match((await ws('ls', '--all')).out, /\tlink\t\[1\]$/m);
  const up = ls.match(/^((?:\d+,){11}\d+)\tbutton\tupvote$/m); // 12 个一样的按钮：一行，编号全在
  assert.ok(up, ls);
  assert.equal(ls.match(/upvote/g).length, 1);
  const all = (await ws('ls', '--all')).out.split('\n');
  assert.deepEqual(all.filter(l => l.endsWith('\tbutton\tupvote')).map(l => l.split('\t')[0]), up[1].split(','));
  const third = up[1].split(',')[2]; // 按合并行里的第 3 个编号点：点中的正是第 3 条，按钮上的字变了就连同编号再列一次
  assert.match((await ws('click', third)).out, new RegExp(`\\n新出现：\\nStory 2 voted 2\\n新出现的可点、可填：\\n${third}\\tbutton\\tvoted 2$`));
  assert.match((await ws('click', 'Go about')).out, /^About — [^\n]*$/); // 跳到了新页面：不附内容，要看就 cat
});

test('动作之后新出现的元素带编号；同一个网页里编号不变（ls 也不重编），旧编号不会被插进来的元素挤错位', async () => {
  await ws('cd', `${base}/tools`);
  const after = (await ws('ls')).out.match(/^(\d+)\tbutton\tAfter menu$/m)[1];
  const opened = (await ws('click', 'Open menu')).out;
  // 只列新元素：只是这些按钮上的字的那行、被菜单拆开的“Open menu After menu”那行都不算新文字
  const [, link, action, hide] = opened.match(
    /^Tools — [^\n]*\n新出现的可点、可填：\n(\d+)\tlink\tMenu about\n(\d+)\tbutton\tMenu action\n(\d+)\tbutton\tHide menu$/) ?? [];
  assert.ok(link, opened);
  assert.ok(+link > +after); // 新元素接在后面编号
  // 菜单插在它前面了，旧编号照样是它；按钮上的字变了，就连同原来的编号再列一次
  assert.match((await ws('click', after)).out, new RegExp(`^Tools — [^\\n]*\\n新出现的可点、可填：\\n${after}\\tbutton\\tAfter clicked$`));
  assert.match((await ws('click', action)).out, // 新给的编号直接能用
    new RegExp(`\\n新出现：\\nMenu about Menu done Hide menu\\n新出现的可点、可填：\\n${action}\\tbutton\\tMenu done$`));
  const again = (await ws('ls')).out; // 同一个网页里 ls 也不重新编号：之前给出的编号都还对得上
  assert.match(again, new RegExp(`^${after}\\tbutton\\tAfter clicked$`, 'm'));
  assert.match(again, new RegExp(`^${action}\\tbutton\\tMenu done$`, 'm'));
  assert.equal(again.match(/Docs link/g).length, 1); // li[role=menuitem] 包着的同名链接只列一次
  assert.equal((await ws('click', hide)).out, `Tools — ${base}/tools`); // 收起菜单后两边的字拼回一行，也不算新内容
  assert.match((await ws('hover', 'Products')).out, /^Tools — [^\n]*\n新出现的可点、可填：\n\d+\tlink\tHover link$/); // CSS 的悬停菜单
  assert.match((await ws('press', 'Shift+Tab', 'Keys')).out, /\n新出现：\nShift\+Tab$/);
  assert.match((await ws('press', 'esc', 'Keys')).out, /\n新出现：\nEscape$/);
  assert.match((await ws('press', 'Tab')).out, /\n新出现：\nTab$/); // 不给元素：按在当前焦点上
  assert.match((await ws('press', 'F13')).err, /不认识“F13”/);
  await ws('click', 'Later');
  assert.match((await ws('wait', 'ready NOW', '5')).out, /^Tools — [^\n]*\n找到：\nReady now$/);
  assert.match((await ws('wait', 'Never', '1')).err, /等了 1 秒，页面上还没有出现“Never”/);
  // 合并的格子摊到每一格、脚注角标去掉、只是排版的表不算
  const spans = '## 表格 3：Spans（4 行 × 3 列）\nOS\tVersion\tYear\nLinux\t1.0\t2020\nLinux\t2.0\t2021\nWindows 11\tWindows 11\t2022';
  assert.equal((await ws('cat', '--table')).out,
    `## 表格 1：Prices（2 行 × 2 列）\nItem\tPrice\nTea\t3\n## 表格 2：Stock（2 行 × 2 列）\nItem\tLeft\nTea\t7\n${spans}`);
  assert.equal((await ws('cat', '--table', '--outline')).out,
    '## 表格 1：Prices（2 行 × 2 列）\t(2 行)\n## 表格 2：Stock（2 行 × 2 列）\t(2 行)\n## 表格 3：Spans（4 行 × 3 列）\t(4 行)');
  assert.equal((await ws('cat', '--table', '--section', '表格 2')).out, '## 表格 2：Stock（2 行 × 2 列）\nItem\tLeft\nTea\t7');
  assert.match((await ws('cat', `${base}/about`, '--table')).out, /没有表格/);
  // 单页应用换了路径（整页内容都换了）：像跳到新网页一样只报位置
  assert.equal((await ws('click', 'Route')).out, `Tools — ${base}/tools/next`);
  // 后退 / 前进；别的网页上给的编号在这一页报失效，不会点到这一页的元素上
  await ws('cd', `${base}/order`);
  const cont = (await ws('ls')).out.match(/^(\d+)\tbutton\tContinue$/m)[1];
  assert.match((await ws('back')).out, /^Tools — /);
  assert.match((await ws('click', cont)).err, /编号已失效/);
  assert.match((await ws('forward')).out, /^Order — /);
  assert.match((await ws('forward')).err, /最新的一页/);
});

test('按键也拦得住：跨站内嵌页面里的付款按钮和银行卡框、认不出名字的按钮、焦点不在框里时', async () => {
  await ws('cd', `${base}/payframe`);
  const ls = (await ws('ls')).out;
  assert.match(ls, /\tbutton\tPay frame\t（需本人点击）$/m); // 内嵌页面里的也标出来了
  assert.match(ls, /\tbutton\tBuy now\t（需本人点击）$/m); // 图片按钮用 alt 当名字
  for (const args of [['press', 'Enter', 'Pay frame'], ['press', 'Space', 'Pay frame'], ['press', 'Enter', 'Frame card'],
    ['press', 'Control+Enter', 'Frame card'], ['press', 'ArrowDown', 'Frame card'], ['press', 'Enter', 'Gift note'],
    ['press', 'Enter', 'Jumpy'], // 得到焦点就把焦点挪进付款框的框
    ['type', 'Gift note', 'x', '--enter']]) {
    const r = await ws(...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /本人/);
  }
  await ws('press', 'Tab', 'Before'); // 焦点移到 closed shadow DOM 里的按钮上：看不到它叫什么
  assert.equal((await ws('press', 'Enter')).code, 2);
  await ws('cd', `${base}/payframe?focus`); // 内嵌页面自己把焦点放到了付款按钮上，主页面上没有别的付款按钮
  assert.equal((await ws('press', 'Enter')).code, 2);
  assert.equal((await ws('press', 'Space')).code, 2);
  assert.doesNotMatch((await ws('cat')).out, /Frame paid|Frame submitted/);
  assert.match((await ws('cd')).out, /^Pay frame — /); // closed shadow DOM 里的按钮也没被按下（按下会把标题改成 PAID）
});

test('被限流、出错、要人机验证、被转到登录页：结果最后有一行“注意：”', async () => {
  assert.match((await ws('cd', `${base}/limited`)).out, /^Slow down — [^\n]*\n注意：被限流了（HTTP 429）/);
  const empty = await ws('cd', `${base}/limited-empty`);
  assert.match(empty.out + empty.err, /被限流了/);
  assert.match((await ws('forward')).err, /打不开 .*\/limited-empty/); // 往前走到上次打不开的那一页：退回来并报错
  assert.match((await ws('cd')).out, /^Slow down — /);
  assert.match((await ws('cd', `${base}/gone`)).out, /\n注意：服务器返回 HTTP 404（页面可能不存在）$/);
  assert.doesNotMatch((await ws('press', 'Tab')).out, /注意/); // 每打开一次网页只提醒一次
  await ws('cd', `${base}/tools`);
  assert.match((await ws('click', 'Go limited')).out, /\n注意：被限流了（HTTP 429）/); // 点链接到了什么都不返回的限流页
  assert.match((await ws('cd', `${base}/challenge`)).out, /\n注意：页面可能要求人机验证/);
  assert.doesNotMatch((await ws('cd', `${base}/wiki/CAPTCHA`)).out, /注意/); // 只是标题里提到 captcha 的普通页面
  assert.match((await ws('cd', `${base}/private`)).out, /^Login — [^\n]*\n注意：跳到了登录页/);
  assert.doesNotMatch((await ws('cd', `${base}/login`)).out, /注意/); // 本来就是要去登录页
  assert.doesNotMatch((await ws('cd', `${base}/about`)).out, /注意/);
});

test('ls --form：长表单只列框和按钮，按小标题分组，同名的框分得清', async () => {
  await ws('cd', `${base}/order`);
  const form = (await ws('ls', '--form')).out;
  assert.match(form, /^## Shipping address\n\d+\ttext\tFirst name\n\d+\ttext\tCity\n## Billing address\n(\d+)\ttext\tFirst name\n\d+\tselect\tCountry\tCanada\n## Options\n\d+\tcheckbox\tGift wrap\n\d+\tbutton\tContinue$/);
  assert.doesNotMatch(form, /Help/); // 表单外面的链接不列
  const billing = form.match(/## Billing address\n(\d+)/)[1];
  await ws('type', billing, 'Ann'); // 按分组里看到的编号填，填进的正是账单地址那一个
  assert.match((await ws('ls', '--form')).out, /## Billing address\n\d+\ttext\tFirst name\tAnn/);
  await ws('cd', base);
  assert.match((await ws('ls', '--form')).out, /^## /); // 别的页面照样能用
});

test('shadow DOM 和内嵌页面里的元素也能点、能填；scroll 能触发滚动加载', async () => {
  await ws('cd', base);
  assert.match((await ws('scroll')).out, /\n新出现：[\s\S]*Lazy loaded/); // 滚动后才出现的文字直接带回来
  assert.match((await ws('cat', '--field', 'lazy')).out, /Lazy loaded/);
  await ws('scroll', '-1');
  await ws('click', 'Shadow button');
  await ws('click', 'Frame button');
  await ws('type', 'Frame field', 'hi');
  const ls = (await ws('ls')).out;
  assert.match(ls, /\tbutton\tShadow clicked$/m);
  assert.match(ls, /\tbutton\tFrame clicked$/m);
  assert.match(ls, /\ttext\tFrame field\thi$/m);
});

test('交互模式和 MCP：自带 | grep / | head，分号连写多条', async () => {
  const shell = await feed('shell', 'cat | grep -i hello\nls | grep -c button\nexit\n');
  assert.match(shell, /# Hello WebShell/);
  assert.match(shell, /^(ws> )?\d+$/m);
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ws', arguments: { command: 'ls | grep -c Icon; cat | grep Hello' } } },
  ];
  const replies = (await feed('mcp', rpc.map(m => `${JSON.stringify(m)}\n`).join(''))).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(replies[0].result.serverInfo.name, 'webshell');
  assert.equal(replies[1].result.tools[0].name, 'ws');
  assert.equal(replies[2].result.content[0].text, '1\n# Hello WebShell'); // 分号连写两条命令，一次调用拿回两个结果
  await ws('cd', '/article');
  assert.equal((await mcpCall('cat | grep -C 1 "Install it|### Windows"')).content[0].text, '## Setup\nInstall it\n### Windows\nUse the installer');
  assert.match((await mcpCall('pass list')).content[0].text, /本人/); // AI 碰不到密码本
});

test('登录可以自动，银行卡、授权和付款只能本人操作', async () => {
  await ws('cd', base);
  // 普通输入框可以填；登录表单可以回车提交、可以点登录按钮
  assert.equal((await ws('type', 'Note', 'hi')).code, 0);
  assert.equal((await ws('type', 'User', 'bob', '--enter')).code, 0);
  await ws('cd', base);
  assert.equal((await ws('click', 'Sign in')).code, 0);
  await ws('cd', base);
  assert.equal((await ws('click', 'Log in')).code, 0);
  assert.match((await ws('type', 'Password', 'secret')).err, /请用 login/); // 密码只能由 login 从密码本里填
  assert.match((await ws('press', 'Enter', 'Locked')).err, /拿不到焦点/); // 焦点进不去：不把键按到别处
  assert.match((await ws('press', 'Enter', 'Search')).out, /^Results — /); // 普通表单回车照样提交
  await ws('cd', base);
  const blocked = [['click', 'Place order'], ['type', 'Note', 'hi', '--enter'],
    ['type', 'Memo', 'x', '--enter'], // 付款按钮用 form= 关联在表单外面，回车照样会提交
    ['type', 'Card number', '4111'], ['click', 'Continue'], // 银行卡表单里的任何按钮
    ['click', 'Allow'], // 授权第三方访问账号
    ['press', 'Enter', 'Card number'], ['press', 'Enter', 'Note'], ['press', 'Space', 'Place order'], // 按键也不能绕过去
    ['press', 'Backspace', 'Password']]; // 密码框只能由 login 填，按键改它也不行
  for (const args of blocked) {
    const r = await ws(...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /本人/);
  }
});

test('密码本：login 自动填好并登录，密码不出现在任何输出和记录里', { skip: process.platform !== 'win32' && '密码本目前只支持 Windows' }, async () => {
  const blob = execFileSync('powershell', ['-NoProfile', '-Command',
    `ConvertTo-SecureString '${TEST_PW}' -AsPlainText -Force | ConvertFrom-SecureString`], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(HOME, 'vault.json'), JSON.stringify({ '127.0.0.1': { user: 'tester', pass: blob } }));
  assert.equal((await ws('pass', 'list')).out, '127.0.0.1\ttester');
  await ws('cd', `${base}/login`);
  const r = await ws('login');
  assert.match(r.out, /^已用密码本里 127\.0\.0\.1 的账号填好并提交\nWelcome — /);
  assert.equal((await ws('cat')).out, 'user=tester pw_ok=true');
  const flow = fs.readFileSync(path.join(HOME, 'flow.jsonl'), 'utf8');
  assert.ok(![r.out, r.err, flow].some(s => s.includes(TEST_PW)));
  await ws('cd', `${base}/login-echo`);
  const echo = await ws('login');
  assert.equal(echo.code, 0);
  assert.ok(![echo.out, echo.err].some(s => s.includes(TEST_PW)));
  assert.ok((await ws('cat')).out.includes(TEST_PW), '测试页确实回显了假密码');
  await ws('cd', `http://localhost:${server.address().port}/login`); // 换个网站名：密码本里没有，就不填（无界面模式下也不弹窗）
  assert.match((await ws('login')).err, /没有 localhost 的账号/);
});

test('第三方登录：记住的方式是 Google，login 就点“用 Google 登录”并跟进弹窗，弹窗关掉后回来', async () => {
  fs.writeFileSync(path.join(HOME, 'vault.json'), JSON.stringify({ '127.0.0.1': { sso: 'Google' } }));
  assert.equal((await ws('pass', 'list')).out, '127.0.0.1\t用 Google 登录');
  await ws('cd', `${base}/sso`);
  assert.match((await ws('login')).out, /^用 Google 登录：\n（打开了新标签页.*\nOAuth — /);
  assert.match((await ws('click', 'Continue')).out, /已关闭.*\nSSO — /);
  await ws('cd', `http://localhost:${server.address().port}/sso`); // 没记住过：无界面模式下没法弹窗问，就不登录
  assert.match((await ws('login')).err, /没有 localhost 的账号/);
});

test('上传、下载、截图、PDF、手机模式', async () => {
  await ws('cd', base);
  const files = fs.mkdtempSync(path.join(os.tmpdir(), 'webshell-files-')); // 普通文件夹；WebShell 自己的数据目录是不让碰的
  const up = path.join(files, 'up.txt');
  fs.writeFileSync(up, 'hello upload');
  // 敏感位置一律拒绝：WebShell 的数据目录（密码本、浏览器登录资料）、点开头的配置目录
  fs.writeFileSync(path.join(HOME, 'secret.txt'), 'x');
  fs.mkdirSync(path.join(files, '.ssh'));
  fs.writeFileSync(path.join(files, '.ssh', 'id_rsa'), 'x');
  fs.symlinkSync(HOME, path.join(files, 'link'), 'junction'); // 看着普通、其实指向 WebShell 数据目录的文件夹链接
  for (const args of [['upload', path.join(HOME, 'secret.txt')], ['upload', path.join(files, '.ssh', 'id_rsa')],
    ['download', 'Get file', path.join(files, 'link', 'new', 'sub')], // 后面两层还不存在：也要还原出真实位置
    ['download', 'Get file', path.join(HOME, 'dl')], ['screenshot', path.join(files, '.ssh', 's.png')]]) {
    const r = await ws(...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /不读写这个位置/);
  }
  assert.match((await ws('upload', up)).out, /已选好 1 个文件/); // 页面上唯一的上传框，即使它被藏起来了
  await ws('click', 'Send file');
  assert.equal((await ws('cat')).out, 'got=true');
  await ws('cd', base);
  const saved = (await ws('download', 'Get file', path.join(files, 'dl'))).out;
  assert.equal(fs.readFileSync(saved, 'utf8'), 'hello file');
  const png = (await ws('screenshot', path.join(files, 's.png'), '--full')).out;
  assert.equal(fs.readFileSync(png).subarray(1, 4).toString(), 'PNG');
  assert.match((await ws('screenshot', png)).err, /不覆盖/); // 已有的文件不覆盖
  assert.equal((await mcpCall('screenshot')).content[1].type, 'image'); // MCP 里直接把图片交给 AI
  const pdf = (await ws('pdf', path.join(files, 'p.pdf'))).out;
  assert.equal(fs.readFileSync(pdf).subarray(0, 4).toString(), '%PDF');
  fs.rmSync(files, { recursive: true, force: true });
  await ws('cd', '/ua');
  await ws('mobile', 'on');
  assert.equal((await ws('cat')).out, 'phone 390');
  await ws('mobile', 'off');
  assert.match((await ws('cat')).out, /^desktop (?!390$)\d+$/);
  // 提交表单后打开的页面：切换手机模式时不能把表单再提交一遍（比如重复下单）
  await ws('cd', '/count-form');
  await ws('click', 'Submit');
  const sent = posts;
  await ws('mobile', 'on');
  await ws('mobile', 'off');
  assert.equal(posts, sent);
});

test('cat --outline / --section 和 grep -C：只读需要的部分，内容与原文一字不差', async () => {
  await ws('cd', `${base}/article`);
  const full = (await ws('cat')).out;
  assert.equal((await ws('cat', '--outline')).out,
    '# Guide\t(1 行)\n## Setup\t(1 行)\n### Windows\t(1 行)\n## Usage\t(2 行)');
  const setup = (await ws('cat', '--section', 'setup')).out;
  assert.equal(setup, '## Setup\nInstall it\n### Windows\nUse the installer'); // 包括下一级小标题，到同级标题为止
  assert.ok(full.includes(setup)); // 原样截取
  assert.equal((await ws('cat', '--section', 'nothing')).code, 1);
  assert.equal((await mcpCall('cat | grep -C 1 Windows')).content[0].text, 'Install it\n### Windows\nUse the installer');
});

test('extract 跨行取字段，保留原值和记录顺序', async () => {
  await ws('cd', `${base}/article`);
  const command = String.raw`cat | extract '^## (.+)\n(?:Install|Run) (.+)$'`;
  assert.equal((await mcpCall(command)).content[0].text, 'Setup\tit\nUsage\tit');
  assert.equal((await mcpCall(`${command} | head -1`)).content[0].text, 'Setup\tit');
  assert.equal((await mcpCall('cat | extract "^Intro$"')).content[0].text, 'Intro');
  assert.match((await mcpCall('cat | extract "^Unknown$"')).content[0].text, /未匹配到内容/);
  assert.equal((await mcpCall('cat | extract')).isError, true);
  const check = " --check '^## .+$' | head -1";
  assert.equal((await mcpCall(command + check)).content[0].text, 'Setup\tit');
  for (const pattern of [
    '^## Setup$', // 漏掉一条，head -1 也不能把错误藏起来
    '^## Setup$|^Intro$', // 条数相等，但有匹配不属于任何记录
    String.raw`^## (.+)(?:\nInstall (.+))?`, // 记录齐全，第二条缺必填字段
  ]) {
    const result = await mcpCall("cat | extract '" + pattern + "'" + check);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /提取校验未通过/);
  }
});

test('cat 并行读多个网址，--field 取字段', async () => {
  const lines = (await ws('cat', base, `${base}/about`, '--field', 'price')).out.split('\n');
  assert.deepEqual(lines, [`${base}\t19.99`, `${base}/about\t（未找到）`]);
  assert.match((await ws('cat', base, `${base}/about`)).out, /==> .*\/about <==\nAbout page/);
});

test('cat 并行核对候选、保留来源和覆盖状态', async () => {
  await ws('cd', base);
  const command = `cat ${base}/candidates --follow 'Test job' --limit 4 --extract '^(Data loaded)$' --check '^Data loaded$' --expect 1`;
  const result = await mcpCall(command);
  assert.equal(result.isError, false);
  assert.deepEqual(result.content[0].text.split('\n'), [
    `列表 ${base}/candidates | 候选 4/4 | next=${base}/candidates?page=2`,
    `==> ${base}/deferred | ok | 1/1 | next=未知 <==`, 'Data loaded',
    `==> ${base}/job-redirect → ${base}/job-detail | ok | 1/1 | next=${base}/about <==`, 'Data loaded',
    `==> ${base}/job-blocked → ${base}/authwall | login | 0/0 | next=未知 <==`,
    `==> ${base}/job-rate | rate-limited | 0/0 | next=未知 <==`,
  ]);
  assert.match((await ws('cd')).out, /^Shop — /);
  const partial = await ws('cat', base + '/about', base + '/job-slow', '--extract', '^(Data loaded)$', '--check', '^About page$', '--expect', '1');
  assert.equal(partial.code, 0);
  assert.match(partial.out, /\/about \| incomplete \| 0\/1/);
  assert.match(partial.out, /\/job-slow \| timeout \| 0\/0/);
  assert.equal((await ws('cat', '--extract', 'x')).code, 1);
});

test('save / run：把流程存成一条命令', async () => {
  await ws('cd', base);
  assert.match((await ws('click', 'About us')).out, /^About — /); // 链接带 target=_blank，也应留在当前标签页
  assert.match((await ws('save', 'about')).out, /run about/);
  await ws('cd', `${base}/search?q=1`);
  assert.match((await ws('run', 'about')).out, /^About — /);
  assert.equal((await ws('save', '../x')).code, 1); // 流程名不能带路径
  // 名字不唯一的按钮存成编号：重放时先编一遍号，点中的还是录的时候那一个
  await ws('cd', `${base}/feed`);
  const third = (await ws('ls')).out.match(/^((?:\d+,){11}\d+)\tbutton\tupvote$/m)[1].split(',')[2];
  await ws('click', third);
  await ws('save', 'vote');
  await ws('cd', base);
  assert.match((await ws('run', 'vote')).out, /voted 2/);
  // 按键、悬停也录进去
  await ws('cd', `${base}/tools`);
  await ws('press', 'esc', 'Keys');
  await ws('save', 'keys');
  await ws('cd', base);
  assert.match((await ws('run', 'keys')).out, /\n新出现：\nEscape$/);
});

test('newLines / onlyNames：只报真正新出现的行', () => {
  assert.deepEqual(newLines(['a', 'Open menu After menu'], ['a', 'Open menu', 'Menu about', 'After menu']), ['Menu about']); // 被插进来的块拆开的行
  assert.deepEqual(newLines(['Open menu', 'x', 'After menu'], ['Open menu After menu']), []); // 收起后拼回一行
  assert.deepEqual(newLines(['1', '5'], ['15']), ['15']); // 新的数字不能算成旧的两段拼起来的
  assert.deepEqual(newLines(['Item 1'], ['Item 1', 'Item 1']), ['Item 1']); // 重复的行按次数算
  assert.ok(onlyNames('## Settings', ['Settings'])); // 标题前的 # 不算
  assert.ok(onlyNames('Save · Cancel', ['Cancel', 'Save']));
  assert.ok(!onlyNames('15', ['1', '5']));
  assert.ok(!onlyNames('Saved 3 items', ['Save']));
});

test('WS_CDP：连到别处已经开着的浏览器（比如云端浏览器），退出时不关它', async () => {
  const [port, id] = fs.readFileSync(path.join(HOME, 'profile', 'DevToolsActivePort'), 'utf8').split('\n');
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'webshell-test-'));
  const remote = wsWith({ ...env, WS_HOME: home2, WS_CDP: `ws://127.0.0.1:${port}${id.trim()}` });
  assert.match((await remote('cd', `${base}/about`)).out, /^About — /);
  // 接管别处的浏览器时不碰它原有的标签页：关掉弹出的那个，回到上一个，而不是新开空白页
  await remote('cd', base);
  assert.match((await remote('click', 'Open popup')).out, /新标签页/);
  await remote('tab', 'close');
  assert.match((await remote('cd')).out, /^Shop — /);
  await remote('exit');
  assert.match((await ws('cd')).out, / — /); // 浏览器还开着
  fs.rmSync(home2, { recursive: true, force: true });
});
