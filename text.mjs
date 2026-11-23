// 纯文字处理：目录和段落、管道里的 grep / head / extract。后台进程和传话的这一头都用

// 正文多的页面先看目录、再只读需要的那一段，不用整页送给 AI。都是从原文里原样截取，不改写，所以不会失真
export const heading = l => l.match(/^(#+) /)?.[1].length;
export const outline = text => {
  const ls = text.split('\n'), at = ls.flatMap((l, i) => (heading(l) ? [i] : []));
  if (!at.length) return '（这个页面没有标题，用 cat | grep 关键词 或 cat | head 代替）';
  return at.map((i, k) => `${ls[i]}\t(${(at[k + 1] ?? ls.length) - i - 1} 行)`).join('\n');
};
export function section(text, name, waitForHeading = false) {
  const ls = text.split('\n'), q = name.toLowerCase(), title = l => l.replace(/^#+ /, '').toLowerCase();
  const all = ls.flatMap((l, i) => (heading(l) ? [i] : []));
  const same = all.filter(i => title(ls[i]) === q);
  const hits = same.length ? same : all.filter(i => title(ls[i]).includes(q));
  if (!hits.length && waitForHeading) return null;
  if (!hits.length) throw new Error(`没有叫“${name}”的段落，先用 cat --outline 看目录`);
  if (hits.length > 1) throw new Error(`“${name}”对应 ${hits.length} 个段落，请写得更完整：\n${hits.slice(0, 10).map(i => ls[i]).join('\n')}`);
  const end = ls.findIndex((l, i) => i > hits[0] && heading(l) <= heading(ls[hits[0]])); // 到下一个同级或更高级的标题为止
  return ls.slice(hits[0], end < 0 ? undefined : end).join('\n');
}

// 动作前后的整页文字比一比，找出新出现的行（重复的行按次数算）。插进来或收起一块（两个按钮中间展开了菜单、
// 关掉了弹窗）会把原来的一行字拆开或拼起来：这样拆出来、拼起来的行不是新内容
const GAP = /[\s·•|,，、/]+/g; // 同一行里各段之间的空白和分隔符
export function newLines(before, after) {
  const counts = new Map();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added = [];
  for (const line of after) {
    const count = counts.get(line) ?? 0;
    if (count) counts.set(line, count - 1);
    else added.push(line);
  }
  const removed = [...counts].flatMap(([line, n]) => Array(n).fill(line));
  // 两边的行都很多（整页换了内容）就不比拆行、拼行：太慢，这时也不缺这点省下的字
  if (removed.length * added.length > 250000) return added;
  const split = new Set(removed.flatMap(line => pieces(line, added)));
  return added.filter((line, k) => !split.has(k) && !pieces(line, removed).length);
}
// 拿掉各段之后只剩空白、分隔符，并且每两段之间都隔着它们（新的“15”不能算成旧的“1”和“5”拼起来的）
const leftover = rest => !rest.includes('\n\n') && !rest.replace(GAP, '');
// line 恰好由 parts 里的两段以上拼成时，返回用到的那几段的下标
function pieces(line, parts) {
  let rest = line;
  const used = [];
  for (const k of parts.map((_, k) => k).filter(k => line.includes(parts[k])).sort((a, b) => parts[b].length - parts[a].length)) {
    if (rest.includes(parts[k])) { rest = rest.replace(parts[k], '\n'); used.push(k); }
  }
  return used.length > 1 && leftover(rest) ? used : [];
}
// 只是这些名字（比如新按钮上的字）拼成的行；标题前的 # 不算
export const onlyNames = (line, names) => leftover(names.toSorted((a, b) => b.length - a.length)
  .reduce((rest, n) => rest.split(n).join('\n'), line.replace(/^#+ /, '')));

// cat --extract 逐页核对的结果：每页一个标题行（来源 | 状态 | 条数/标记数 | 下一页），下面是提取到的记录
export function checkedOutput(pages, listing) {
  const output = pages.map(({ requested, url, status, count = 0, markers = 0, next, lines, message }) => {
    const source = url && url !== 'about:blank' && url !== requested ? `${requested} → ${url}` : requested;
    return [`==> ${source} | ${status} | ${count}/${markers} | next=${next ?? '未知'} <==`, message, ...(lines ?? [])]
      .filter(Boolean).join('\n');
  });
  return [...listing, ...output].join('\n');
}

// press 认的键：名字 → [键码, 打出的字]；前面可加 Shift+ Control+ Alt+ Meta+（CDP 的修饰键位：Alt 1、Ctrl 2、Meta 4、Shift 8）
const KEYS = { Enter: [13, '\r'], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], Space: [32, ' '], Home: [36], End: [35],
  PageUp: [33], PageDown: [34], ArrowLeft: [37], ArrowUp: [38], ArrowRight: [39], ArrowDown: [40] };
const MODS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 };
export function keyOf(spec) {
  const parts = spec.split('+'), name = parts.pop().toLowerCase().replace(/^esc$/, 'escape').replace(/^(up|down|left|right)$/, 'arrow$1');
  const named = Object.keys(KEYS).find(k => k.toLowerCase() === name);
  if (!named || parts.some(m => !Object.hasOwn(MODS, m.toLowerCase()))) {
    throw new Error(`不认识“${spec}”。能按的键：${Object.keys(KEYS).join(' ')}，前面可加 Shift+ / Control+ / Alt+ / Meta+`);
  }
  const [vk, text] = KEYS[named];
  return { key: named === 'Space' ? ' ' : named, code: named, vk, text, mods: parts.reduce((m, x) => m | MODS[x.toLowerCase()], 0) };
}

// 第三方登录：按钮上写着这些名字之一，并且像是登录按钮（“Continue with Google”“使用 Apple 登录”，或只有一个名字的图标按钮）
const SSO = ['Google', 'Apple', 'Microsoft', 'GitHub', 'Facebook'];
export const ssoOf = label => SSO.find(n => new RegExp(`\\b${n}\\b`, 'i').test(label)
  && (/sign|log|continue|with|登录|登入|使用|继续/i.test(label) || label.trim().toLowerCase() === n.toLowerCase()));

export const PIPES = String.raw`管道：| grep [-i] [-v] [-c] [-C 行数] 模式 · | head -N · | extract '正则' [--check '每条记录的标记']：可用 \n 跨行，返回捕获组（Tab 分隔，没有括号就返回原文）；--check 要求每条匹配恰好对应一个标记且一个不漏。`;
export function extractor(args, expected) {
  const [pattern, flag, marker] = args;
  if (!pattern || (args.length !== 1 && (args.length !== 3 || flag !== '--check' || !marker))) {
    throw new Error("用法：| extract '正则' [--check '每条记录的标记']");
  }
  const re = new RegExp(pattern, 'gm'), anchor = marker && new RegExp(marker, 'gm');
  return text => {
    const matches = [...text.matchAll(re)];
    if (!matches.length && !anchor) return { lines: ['（未匹配到内容，可用 cat | grep -C 查看原文）'] };
    if (anchor) {
      const anchors = [...text.matchAll(anchor)];
      if (!anchors.length || matches.length !== anchors.length || (expected !== undefined && matches.length !== expected)
        || matches.some((match, i) =>
          anchors[i].index < match.index || anchors[i].index + anchors[i][0].length > match.index + match[0].length
          || match.slice(1).some(group => !group?.trim()))) {
        const count = expected === undefined ? '' : `，需要 ${expected} 条`;
        return { count: matches.length, markers: anchors.length,
          error: `提取校验未通过（${anchors.length} 个记录标记，${matches.length} 条匹配${count}）。用 cat | grep -C 查看原文` };
      }
    }
    return { count: matches.length, markers: matches.length,
      lines: matches.map(([match, ...groups]) => groups.length ? groups.join('\t') : match) };
  };
}
export const filters = {
  grep(lines, args) {
    let flags = '', around = 0, pattern = '';
    for (let k = 0; k < args.length; k++) {
      if (/^-C\d*$/.test(args[k])) around = +(args[k].slice(2) || args[++k]) || 0; // -C 2：把前后各 2 行一起带出来
      else if (/^-[ivc]+$/.test(args[k])) flags += args[k];
      else pattern = args[k];
    }
    const re = new RegExp(pattern, flags.includes('i') ? 'i' : '');
    const invert = flags.includes('v');
    const hit = lines.map(l => re.test(l) !== invert);
    if (flags.includes('c')) return [String(hit.filter(Boolean).length)];
    if (!around) return lines.filter((_, i) => hit[i]);
    if (!Number.isSafeInteger(around) || around < 0) throw new Error('grep -C 需要非负整数');
    let next = 0;
    return lines.filter((_, i) => {
      while (next < hit.length && (!hit[next] || next < i - around)) next++;
      return next < hit.length && next <= i + around;
    });
  },
  extract(lines, args) {
    const result = extractor(args)(lines.join('\n'));
    if (result.error) throw new Error(result.error);
    return result.lines;
  },
  head: (lines, args) => lines.slice(0, +(args.join('').match(/\d+/)?.[0] ?? 10)),
};
