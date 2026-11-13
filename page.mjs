// 这个函数在网页里执行：webshell.mjs 把它的源码原样注入页面，所以里面只能用浏览器 API，不能引用这个文件外的任何东西
export function page() {
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[onclick],[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=switch],[role=combobox],[contenteditable=""],[contenteditable=true]';
  const junk = /[\p{Co}\p{Cf}]/gu; // 图标字体的私有字符（Co）、看不见的控制符（Cf）：对 AI 只是噪音
  const clean = s => String(s ?? '').replace(junk, '').replace(/\s+/g, ' ').trim();

  // 按显示顺序收集文字。浏览器自带的 innerText 进不了 shadow DOM 和 iframe，所以自己走一遍；
  // 顺手压掉空行、多余空白和只给读屏软件看的隐藏文字，标题前加 #，给 AI 省字数
  const text = root => {
    const out = [];
    let line = '';
    const end = () => { line = line.replace(junk, '').replace(/ +/g, ' ').trim(); if (line && !/^#+$/.test(line)) out.push(line); line = ''; }; // 空标题只剩 # 号，不要
    const walk = n => {
      if (n.nodeType === 3) { line += n.data.replace(/\s+/g, ' '); return; }
      if (n.nodeType !== 1) { n.childNodes.forEach(walk); return; } // shadow DOM 的根
      if (/^(script|style|noscript|template|title|select|textarea)$/i.test(n.tagName)) return;
      if (n.tagName === 'BR') { end(); return; }
      const cs = getComputedStyle(n);
      // 不显示的不读；1 像素大小、内容被裁掉的是只给读屏软件看的重复文字，也不读
      if ((cs.display !== 'contents' && !n.checkVisibility({ visibilityProperty: true }))
        || (cs.overflow !== 'visible' && n.offsetWidth <= 1 && n.offsetHeight <= 1)) return;
      const inline = /^(inline|contents)/.test(cs.display), cell = cs.display === 'table-cell';
      if (!inline && !cell) end();
      if (/^H[1-6]$/.test(n.tagName)) line += `${'#'.repeat(n.tagName[1])} `;
      if (cs.whiteSpace.startsWith('pre') && !inline) { out.push(...n.innerText.trimEnd().split('\n')); return; } // 代码块：原样保留缩进和换行
      if (n.tagName === 'SLOT' && n.assignedNodes().length) n.assignedNodes().forEach(walk);
      else if (n.tagName === 'IFRAME') { if (n.contentDocument?.body) walk(n.contentDocument.body); } // 同源的内嵌页面
      else (n.shadowRoot || n).childNodes.forEach(walk);
      if (cell) line += '\t'; else if (!inline) end(); else if (cs.display !== 'inline') line += ' ';
    };
    walk(root);
    end();
    return out.join('\n');
  };

  const isField = e => e.isContentEditable || /^(SELECT|TEXTAREA)$/.test(e.tagName)
    || (e.tagName === 'INPUT' && !/^(button|submit|reset|image|checkbox|radio|file)$/.test(e.type));
  const notField = e => !isField(e);
  const hint = e => { const d = e.querySelector('[title],[alt]'); return d?.title || d?.alt; }; // 只有图标的按钮：用图标自带的说明文字
  const named = e => (e.getAttribute('aria-labelledby') || '').split(/\s+/)
    .map(id => e.getRootNode().getElementById?.(id)?.innerText).filter(Boolean).join(' ');
  const labels = new WeakMap(); // 一次调用内，列元素和检查操作限制共用同一个名字。
  const label = e => {
    const cached = labels.get(e);
    if (cached !== undefined) return cached;
    const name = clean(e.getAttribute('aria-label') || named(e) || e.labels?.[0]?.innerText
      || (isField(e) ? e.placeholder || e.name || e.id : e.innerText || text(e) || e.value || e.title || hint(e))).slice(0, 80);
    labels.set(e, name);
    return name;
  };
  const kind = e => e.tagName === 'A' ? 'link'
    : notField(e) ? (/^(checkbox|radio|file)$/.test(e.type) ? e.type : 'button')
    : e.tagName === 'INPUT' ? e.type : e.tagName === 'SELECT' ? 'select' : 'text';
  const about = e => `${e.autocomplete} ${e.name} ${e.id} ${label(e)}`;
  // 密码框：AI 不能自己往里打字，只能用 login 让工具从密码本里填
  const pw = e => isField(e) && (e.type === 'password' || /password/.test(e.autocomplete || ''));
  // 银行卡框和验证码框：只能本人输入（AI 拿不到手机上的验证码，付款也必须本人来）
  const card = e => isField(e) && /\bcc-|\b(cvv|cvc)\b|card.?num|卡号|安全码/i.test(about(e));
  const otp = e => isField(e) && /one-time-code|\b(otp|2fa)\b|验证码/i.test(about(e));
  // 授权（比如“允许某应用访问你的 Google 账号”）、付款、下单的按钮只能本人点（登录可以自动）。shortcut: 靠按钮上的文字判断，会漏判也会误伤；要更稳就按网站维护名单
  const humanOnly = e => notField(e) && /\b(authori[sz]e|allow|pay|buy now|purchase|place (your )?order|submit order|confirm (order|payment|purchase))\b|授权|允许|付款|支付|下单|购买|提交订单|确认订单/i.test(label(e));
  // 所在表单（包括用 form= 关联到表单、但放在表单外面的按钮）里有没有某种框
  const form = e => e.form ?? e.closest('form');
  const inForm = (e, test) => [...(form(e)?.elements ?? [])].some(test);
  const dead = a => /^(#|javascript:)/i.test(a.getAttribute('href')); // href 只是摆设、实际靠脚本响应的链接

  // 把整棵树走一遍，穿过 shadow DOM 和同源的内嵌页面（跨站的内嵌页面由本机那边另外连接）
  const deep = (root, hit, out = []) => {
    for (const e of root.querySelectorAll('*')) {
      if (hit(e)) out.push(e);
      if (e.shadowRoot) deep(e.shadowRoot, hit, out);
      else if (e.tagName === 'IFRAME' && e.contentDocument && e.offsetWidth > 1 && e.offsetHeight > 1) deep(e.contentDocument, hit, out); // 隐藏的小框架不算
    }
    return out;
  };
  const shown = e => e.checkVisibility({ visibilityProperty: true }) && e.getClientRects().length;
  // 没有文字的按钮和链接，调用者看不出是什么，列出来只是白占字数
  const listed = e => e.matches(SEL) && shown(e) && (isField(e) || label(e));
  // 勾选、选中、展开、按下、不可用这些状态直接列出来，AI 不必点一下才知道
  const state = e => ['checked', 'selected', 'expanded', 'pressed', 'disabled']
    .filter(a => e[a] === true || e.getAttribute(`aria-${a}`) === 'true').join(' ');
  const more = e => (pw(e) ? '（用 login 填）' : card(e) || otp(e) ? '（需本人输入）'
    : humanOnly(e) || (notField(e) && inForm(e, card)) ? '（需本人点击）'
    : isField(e) ? clean(e.tagName === 'SELECT' ? e.selectedOptions[0]?.text : e.value ?? e.innerText).slice(0, 80) : state(e));
  const href = e => (e.tagName !== 'A' || dead(e) ? '' : (e.origin === location.origin ? e.pathname + e.search + e.hash : e.href).slice(0, 100));
  const at = i => {
    const e = window.__ws?.[i];
    if (!e?.isConnected) throw new Error('编号已失效，请重新运行 ls');
    return e;
  };
  const clickStop = e => (humanOnly(e) || inForm(e, card)) && `“${label(e)}”是授权/付款/下单类按钮`;
  const expansion = e => e.matches('details > summary:first-of-type')
    ? String(e.parentElement.open) : e.getAttribute('aria-expanded');
  const userLike = e => e.tagName === 'INPUT' && /^(text|email|tel)$/.test(e.type) && !card(e) && !otp(e);

  return {
    loc: () => `${document.title} — ${location.href}`,
    pageInfo: () => {
      const next = document.querySelector('a[href][rel~="next"],link[href][rel~="next"]')?.href;
      return { url: location.href, originTime: performance.timeOrigin, ready: document.readyState !== 'loading',
        next: /^https?:\/\//i.test(next ?? '') ? next : undefined };
    },
    links: pattern => {
      const re = new RegExp(pattern, 'i');
      return [...new Set(deep(document, e => e.matches('a[href]') && shown(e) && re.test(label(e))
        && /^https?:$/.test(e.protocol) && !dead(e) && !clickStop(e)).map(e => e.href))];
    },
    // 每个元素一行：[类型, 文字, 当前值或提示, 是不是输入框, 链接地址]；元素本身记在 window.__ws 里，供随后按编号操作
    scan: () => (window.__ws = deep(document, listed)).map(e => [kind(e), label(e), more(e), isField(e), href(e)]),
    cat: () => {
      const main = document.querySelectorAll('main,[role=main]'); // 有唯一的正文区就只读正文，省掉导航和页脚
      return text(main.length === 1 ? main[0] : document.body ?? document.documentElement);
    },
    all: () => text(document.body ?? document.documentElement), // 整页：弹出的对话框、提示条常在正文区外面
    field: name => {
      if (!/^[\w-]+$/.test(name)) throw new Error('--field 只能是字母、数字、下划线或短横线');
      const n = name.toLowerCase();
      const dig = o => { // 在网站自带的结构化数据（JSON-LD）里递归找同名的键
        if (!o || typeof o !== 'object') return undefined;
        for (const [k, v] of Object.entries(o)) {
          const hit = k.toLowerCase() === n && typeof v !== 'object' ? v : dig(v);
          if (hit !== undefined) return hit;
        }
        return undefined;
      };
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const hit = dig(JSON.parse(s.textContent));
          if (hit !== undefined) return clean(hit);
        } catch { /* 网站自己的 JSON 写坏了，跳过这一段 */ }
      }
      const e = document.querySelector(`[itemprop="${n}" i],meta[property*=":${n}" i],meta[name="${n}" i]`)
        || [...document.querySelectorAll(`[class*="${n}" i],[id*="${n}" i]`)].find(x => x.checkVisibility() && clean(x.innerText));
      if (e) return clean(e.getAttribute('content') || e.innerText).slice(0, 120);
      // shortcut: 最后退到“含这个词的第一行文字”，可能不准；要精确就给具体网站写提取规则
      return clean(document.body.innerText.split('\n').find(l => l.toLowerCase().includes(n))).slice(0, 120);
    },
    click: i => {
      const e = at(i);
      const stop = clickStop(e);
      if (stop) return { stop };
      if (e.target === '_blank') e.target = '_self'; // 留在当前标签页，不然“当前目录”就跟丢了
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const r = e.getBoundingClientRect();
      let x = r.left + r.width / 2, y = r.top + r.height / 2, w = e.ownerDocument.defaultView, outer = null;
      const free = (root, el) => { const hit = root.elementFromPoint?.(x, y); return hit && (hit === el || el.contains(hit)); };
      if (free(e.getRootNode(), e)) {
        for (; w.frameElement; w = w.parent) { // 同源内嵌页面里的坐标，要加上内嵌框在外层页面里的位置
          const f = w.frameElement.getBoundingClientRect();
          x += f.left + w.frameElement.clientLeft;
          y += f.top + w.frameElement.clientTop;
          outer = w.frameElement;
        }
        // 算得出整个标签页里的坐标、那里也没被挡住，就像人一样用鼠标点（有些网站只认真实的点击）
        if (w === w.top && (!outer || free(w.document, outer))) return { x, y };
      }
      e.click(); // 被弹窗、横幅挡住了，或者在跨站的内嵌页面里：退回脚本点击
      return {};
    },
    expand: (ids, verify = false) => {
      const check = e => {
        labels.delete(e); // 前一个按钮可能改了后一个的状态或文字
        const stop = clickStop(e);
        if (stop) return stop;
        if (!shown(e) || isField(e) || !e.matches('button,[role=button],details > summary:first-of-type')
          || e.closest('a[href],:disabled,[aria-disabled=true]') || (e.form && e.type === 'submit')
          || !['true', 'false'].includes(expansion(e))) {
          throw new Error(`“${label(e)}”不是可展开的按钮`);
        }
      };
      const elements = ids.map(at);
      for (const e of elements) {
        const stop = check(e);
        if (stop) return { stop };
      }
      if (verify) return { closed: elements.filter(e => expansion(e) !== 'true').map(label) };
      for (const e of elements) {
        const stop = check(e);
        if (stop) return { stop };
        if (expansion(e) === 'false') e.click();
      }
      return {};
    },
    type: (i, v, enter) => {
      const e = at(i);
      if (!isField(e)) throw new Error(`“${label(e)}”不是输入框`);
      if (pw(e)) throw new Error('密码框不能用 type 填：请用 login（密码要先由用户本人用 ws pass save 存进密码本）');
      if (card(e) || otp(e)) return { stop: `“${label(e)}”是银行卡/验证码输入框` };
      // 回车会提交整个表单，不能借此绕过付款按钮的限制
      if (enter && inForm(e, x => card(x) || humanOnly(x))) return { stop: '在这里回车会直接提交授权/付款/下单的表单' };
      if (e.tagName === 'SELECT') {
        const o = [...e.options].find(x => clean(x.text).toLowerCase() === v.toLowerCase() || x.value === v);
        if (!o) throw new Error(`下拉框里没有“${v}”，可选：${[...e.options].map(x => clean(x.text)).join(' / ')}`);
        e.value = o.value;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
        return { done: true };
      }
      e.scrollIntoView({ block: 'center' });
      e.focus();
      // 焦点没过去（比如输入框被禁用）就停下，否则字会打进原来有焦点的那个框里
      if (e.getRootNode().activeElement !== e) throw new Error(`“${label(e)}”现在不能输入（可能被禁用了）`);
      if (e.select) e.select(); else e.ownerDocument.execCommand('selectAll'); // 选中旧内容，接下来的输入会直接替换它
      return {};
    },
    // 登录框：看得见的密码框，加上它前面同一个表单里的用户名框；没有密码框时（先填邮箱的两步登录）找像用户名的那个框
    loginFields: () => {
      const seen = deep(document, x => isField(x) && shown(x));
      const pass = seen.find(pw);
      const user = pass
        ? seen.filter(x => userLike(x) && form(x) === form(pass) && x.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1)
        : seen.find(x => userLike(x) && (/username|email/.test(x.autocomplete) || x.type === 'email' || /user|mail|login|account|账号|用户|学号/i.test(about(x))));
      window.__login = [user, pass];
      const loc = (pass ?? user)?.ownerDocument.location;
      return loc && { host: loc.hostname, secure: loc.protocol === 'https:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(loc.hostname), user: !!user, pass: !!pass };
    },
    focusLogin: k => { // 把光标放进用户名框（0）或密码框（1）并选中旧内容，接下来由 login 把内容打进去
      const e = window.__login?.[k];
      if (!e?.isConnected) throw new Error('登录框已经变了，请重新运行 login');
      e.scrollIntoView({ block: 'center' });
      e.focus();
      if (e.getRootNode().activeElement !== e) throw new Error('登录框现在不能输入');
      e.select();
    },
    // 上传：编号指上传框本身，或外面那个看得见的“上传”按钮 / 标签；没给编号就用页面上唯一的上传框（很多网站把它藏起来了）
    fileInput: i => {
      const all = deep(document, x => x.matches('input[type=file]'));
      const e = i === undefined ? null : at(i);
      const f = e ? (e.matches('input[type=file]') ? e : e.querySelector('input[type=file]') ?? e.control ?? form(e)?.querySelector('input[type=file]'))
        : all.length === 1 ? all[0] : null;
      if (!f) throw new Error(e ? `“${label(e)}”不是上传框` : `页面上有 ${all.length} 个上传框，请用 --to 指定是哪一个`);
      window.__file = f;
    },
  };
}
