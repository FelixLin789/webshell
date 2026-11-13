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
