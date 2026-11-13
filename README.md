# WebShell

让 AI 像用命令行一样操控网页：`cd` 进网站，`ls` 看能点、能填什么，`cat` 读内容。
默认只给文字，省 token；跑在你自己的电脑上，可以直接用你自己的 Chrome 和里面的登录状态。

```
$ ws cd news.ycombinator.com
Hacker News — https://news.ycombinator.com/
$ ws ls | grep -i login
10	link	login
$ ws cat | grep AI
United Airlines bans AI agents from booking flights on behalf of travelers (cbsnews.com)
```

零依赖，需要 Node.js 22+ 和 Chrome（Windows、macOS、Linux；密码本目前只支持 Windows）。代码文件：

- `webshell.mjs`：入口：命令行、交互模式、MCP 服务器（把命令传给后台进程）
- `daemon.mjs`：后台进程：一直连着浏览器，执行所有命令
- `page.mjs`：注入到网页里执行的代码（列元素、读文字、安全检查）
- `common.mjs`：两边共用的路径、版本号、浏览器连接
- `text.mjs`：目录和段落、`grep` / `head` / `extract` 这些文字处理
- `vault.mjs`：密码本

## 安装

在这个文件夹里运行一次，之后在任何地方都能用 `ws`：

```bash
npm link
```

不想安装的话，把下面的 `ws` 换成 `node webshell.mjs` 也一样。

## 用你自己的 Chrome（推荐）

1. 在 Chrome 地址栏打开 `chrome://inspect/#remote-debugging`，打开开关。
2. 第一次运行 `ws` 时，Chrome 会弹出“允许远程调试”的对话框，点“允许”。
3. WebShell 会在你的 Chrome 里新开一个标签页来操作，不动你已经打开的标签页。

之后 WebShell 在后台一直连着，不会再问。只有后台进程重新启动时（重启了 Chrome、执行了 `ws exit`、或者更新了代码）才会再问一次。

不打开这个开关时，WebShell 会启动一个自己专用的 Chrome 窗口（配置在 `~/.webshell/profile`），登录状态也会一直记住。

想用云端浏览器：把环境变量 `WS_CDP` 设为它的连接地址（`ws://` 或 `wss://`）。

注意：打开开关并点了“允许”之后，AI 能访问你 Chrome 里所有已登录的网站（邮箱、网银等）。不用时执行 `ws exit` 断开，或者把开关关掉。

## 命令

```
ws cd <网址|/路径|..>              打开网站；不带参数显示当前位置
ws ls [-l] [--all]                 列出能点、能填的东西；-l 带链接地址，--all 按原顺序逐条列出
ws cat [网址...] [--field 名字]     读页面文字；给多个网址就并行读；--field 只取一个字段，如 price
ws cat --outline / --section 标题   正文多时先看目录，再只读需要的那一段
ws click <编号|文字> [--accept]     用鼠标点击；点出新标签页会自动跟过去；--accept：弹出确认框时点“确定”
ws expand <编号...> [--section 标题] 批量展开详情，等页面稳定一次，再读取正文或指定段落
ws expand <编号...> [--section 标题] --extract '正则' --check '标记'
                                    展开状态和指定字段齐了就返回
ws type <框> <内容> [<框> <内容>...] [--enter]
                                    输入（内容为 "" 则清空），可回车提交；对下拉框则是选中该选项。
                                    一次可以填好几个框（如 type 姓名 张三 邮箱 a@b.c），只在最后等一次页面，回车按在最后一个框
ws login                           登录：用你为这个网站选的方式（Google / Apple 等，或账号密码），见下面“自动登录”
ws scroll [屏数]                   向下滚几屏（负数向上）：有些内容滚到才加载，新加载的文字直接带回来
ws tab [编号|close]                列出标签页 / 切换过去 / 关掉当前这个
ws upload <文件...> [--to 编号|文字] 上传文件；页面上有好几个上传框时用 --to 指定
ws download <编号|文字> [文件夹]    点击并下载，返回存到了哪里（默认存进“下载”文件夹）
ws screenshot [文件] [--full]       截图（--full 截整页）
ws pdf [文件]                      把页面存成 PDF
ws mobile on|off                   用手机的屏幕大小和身份打开网页
ws save 名字 / ws run 名字 [参数]    把最近一次 cd 之后的操作存成一条命令 / 重放
ws exit                            断开（专用窗口会被关掉；你自己的 Chrome 不会被关）
```

`ls` 和 `cat` 会穿过 shadow DOM 和内嵌页面（iframe，包括别的网站嵌进来的）。展开、勾选、选中、不可用这些状态直接写在 `ls` 的最后一列。

`ls` 会把出现至少 5 次的相同列表项合成一行，保留每个元素的编号。例如合并行的第一列是 `12,19,26` 时，可用 `click 19` 操作编号 19 的元素。引用角标（`[1]`、`[note 2]`）和“Jump up”这类只在本页内跳转的回跳链接不列出，最后一行会说省略了几个；网站用 `href="#..."` 做的标签页、折叠按钮照样列出。需要看各元素原本的位置和上下文，或要看被省略的那些时，用 `ls --all`。

`click`、`type`、`scroll`、`upload` 在同一份网页里操作后，会在“新出现”下面列出新增的文字，例如展开的内容、输入候选、滚动加载的新内容。新增预览最多 2,000 字，更多内容可用 `cat --outline` 或 `cat | grep` 找。若操作打开了新页面，用 `cat` 读取。

点击默认像人一样用鼠标点；如果按钮被弹窗、横幅挡住了，或者在别的网站嵌进来的页面里，就改用脚本点击。

流程文件是纯文本，在 `~/.webshell/macros/名字.jsonl`，一行一步，可以手改——比如把搜索词改成 `$1`，以后就能 `ws run 名字 新的搜索词`。

## 自动登录：密码本

AI 从头到尾看不到你的密码：

1. AI 第一次在某个网站的登录页运行 `ws login` 时，屏幕上会弹出 Windows 自带的账号密码输入窗口，**你本人**填一次就行。
2. 以后再到这个网站，`ws login` 会自己解开密码、填好并提交，不再弹窗。

也可以提前存好：`ws pass save login.example.edu`（同样是弹窗输入）。

- 密码用 Windows 自带的加密（DPAPI）存在 `~/.webshell/vault.json`，只有你这个 Windows 账户能解开，文件被拷走也没用。
- 只在网站名**完全一样**、并且是加密连接（https）的页面上填，长得像的钓鱼网站拿不到。
- 输入窗口是 Windows 系统的，AI 既不能往里打字，也读不到里面的内容；AI 通过 MCP 或交互模式也碰不到密码本。
- `ws pass list` 看存了哪些网站；`ws pass rm 网站` 删掉一个。
- 账号按登录页所在的网站名保存（比如学校的课程网站把登录页放在另一个网站名 `login.example.edu` 上，账号就存在这个名字下），弹窗里会写明是哪个网站。

验证码（两步验证）还需要你本人输入：手机上的验证码 AI 拿不到。

### 用 Google / Apple 登录

登录页上有“Continue with Google”“使用 Apple 登录”这类按钮（认 Google、Apple、Microsoft、GitHub、Facebook）时，AI 第一次运行 `ws login`，屏幕上会弹出一个窗口列出这个网站能用的登录方式，**你本人**选一种：

- 选了 Google 之类：工具点那个按钮，跟进弹出的登录窗口，AI 接着选账号、点“继续”。登录窗口做完自己关掉后，会自动回到原来的页面。
- 选了账号密码：和上面一样，第一次弹窗请你填账号。

你的选择会记在密码本里（`ws pass list` 显示为“用 Google 登录”），以后自动用同一种方式；想换就 `ws pass rm 网站`。

第三方登录要用**你自己的 Chrome**（里面已经登录了 Google）：专用窗口里 Google 常会拒绝登录（“此浏览器可能不安全”）。Google 的“允许某应用访问你的账号”这类授权页、两步验证，仍然要你本人来。

## 给 AI 用

**能跑终端的 AI（Claude Code 等）**：告诉它“用 `ws` 命令操控网页，先运行 `ws` 看用法”。输出是纯文本，可以接系统的管道：`ws cat | grep -i price`。

**MCP**：WebShell 自己就是一个 MCP 服务器，只有一个工具 `ws`，参数是一行命令。以 Claude Code 为例：

```bash
claude mcp add webshell -- node "<WebShell 所在文件夹>/webshell.mjs" mcp
```

MCP 里自带 `| grep [-i] [-v] [-c] [-C 行数]` 和 `| head -N`，还能用分号一次做几步：`cd github.com; ls | grep -i login`。没加过滤器时，每条命令最多返回 200 行。`screenshot` 会把图片直接交给 AI。文件路径请写完整路径。更新了 WebShell 的代码之后，要重启用它的程序（比如 Claude Desktop）。

交互模式和 MCP 都支持 `| extract '正则'`。比如页面上的价格标签和金额分两行时，`cat | extract '^Price from\n(.+)$' | head -3` 只返回前三个起价。用 `\n` 匹配换行，用括号选字段。每条匹配的字段按捕获顺序用 Tab 分隔。省略括号时返回匹配原文。

提取列表时，可加 `--check '每条记录的标记'`，例如 `| extract '^Price from\n(.+)$' --check '^Price from$' | head -3`。校验在 `head` 之前运行。每个标记须落在一条匹配内，捕获的字段须有值。漏记录、缺字段或找不到标记时会报错。按任务选择每条记录都带的标记，校验覆盖的是当前读到的文本。

并行核对详情用 `cat URL1 URL2 --extract '字段正则' --check '记录标记'`，可以加 `--section '标题'`。如果已知每页应有几条，再加 `--expect 条数`，字段和条数齐了立即返回。也可用 `cat 列表URL --follow '链接文字正则' --limit 5 --extract '字段正则' --check '记录标记'` 从当前列表选链接，省略列表网址则用当前标签页。链接去重并按页面顺序读取，每批最多打开 8 页。

每个结果带请求网址、跳转后的实际网址（如有）、状态、匹配数/标记数和已识别的下一页。`ok` 表示指定范围通过校验。约 10 秒内正文已可读但字段没齐时返回 `incomplete`，页面未及时就绪时返回 `timeout`。登录跳转、HTTP 429 和其他访问失败分别标记。列表还会给出本次选中数/当前匹配链接数。`next=未知` 表示没有识别到标准分页标记。可按失败来源单独补读。

批量读详情时，先用 `ls` 找编号，再用 `expand 12 19 26 --section "Top flights" | extract '正则' --check '标记'`。同一批的编号来自同一个网页或内嵌页面。`expand` 识别原生详情和带展开状态的按钮，已展开的会保持打开。按钮只接受真实鼠标点击或没有公开展开状态时，用 `click`。

每个按钮对应一条记录时，可以把提取条件直接交给 `expand`，例如 `expand 12 19 26 --section "Top flights" --extract '正则' --check '标记'`。它等到所有按钮已展开、指定范围内的标记都匹配、捕获字段都有值，且记录数等于按钮数，就返回这些字段。用能区分完整详情和占位内容的规则。超过约 10 秒仍未齐会报错。读取全文或记录数不固定时，用普通 `expand`。

**交互模式**：`ws shell`，写法和 MCP 里一样，适合自己手动试。

## 为什么省算力

同一个页面，交给 AI 的内容有多大（实测，2026 年 11 月）：

| 页面 | 整棵无障碍树（原始 JSON） | `ws ls` | `ws cat` | 先 `--outline` 再读需要的 `--section` |
|---|---|---|---|---|
| Wikipedia“Alan Turing” | 约 15.8 万 token（Playwright MCP 快照） | 约 1.25 万（合并前） | 约 2.8 万 | 约 2,600 |
| Google Flights 搜索结果 | 约 1.5 万 token（Playwright MCP 快照） | — | 约 550 | — |

真正省的地方是过滤：AI 很少需要整页，`ws ls | grep -i search` 通常只返回一两行。作为对比，一张截图约 1,400–2,000 个 token。

两项省 token 功能在 2026 年 11 月 13 日用专用 Chrome 和 `o200k_base` 实测。数字只计算返回的文字，不含命令和模型自身的消耗。

| 操作 | 完整输出 | 精简输出 | 减少 |
|---|---:|---:|---:|
| Wikipedia“Alan Turing”元素列表 | 16,388 | 14,384 | 12.2% |
| Hacker News 元素列表 | 1,629 | 1,484 | 8.9% |
| GitHub VS Code 展开 Code 菜单 | 1,252（位置 + `cat`） | 63（位置 + 新出现的文字） | 95.0% |

GitHub 和 BBC 新闻的元素列表没有达到合并门槛。GitHub 的 Code 菜单位于正文区之外，新增文字还带回了普通 `cat` 没读到的 HTTPS 和 Download ZIP。

之后把合并门槛降到 5 次、不再列出引用角标，又测了一轮（同日，按字符数估算：英文约 4 个字符 1 个 token，所以只和同一轮的数字比）：

| 操作 | 旧做法：动作 + 再 `cat` 整页 | 现在：动作的输出 | 减少 |
|---|---:|---:|---:|
| Wikipedia“Alan Turing”元素列表 | 10,711（门槛 10） | 9,029（门槛 5，省略 586 个引用角标） | 16% |
| Bootstrap 文档：展开折叠面板 | 4,737 | 141 | 97% |
| GitHub VS Code：展开 Code 菜单 | 1,437 | 63 | 96% |
| Google Flights：输城市不回车 | 441 | 107（直接带回全部候选） | 76% |
| Hacker News：点 More（跳到新页面） | 975 | 12（只报位置，要看再 `cat`） | — |

工具说明（每次对话都要加载）从约 1,040 压到约 730 个 token。

## 安全

- 密码：AI 不能自己往密码框里打字，只能用 `ws login` 让工具从密码本里填，看不到密码本身。
- 验证码、银行卡输入框：拒绝输入。
- 授权、付款、下单的按钮（看按钮上的文字，也看它所在的表单里有没有银行卡框），以及在这类表单里按回车：拒绝操作。
- 以上情况退出码为 2，意思是“需要你本人在浏览器里完成”。
- 网页弹出的确认框默认取消；`click ... --accept` 才点“确定”，但提到付款、下单的确认框永远不替你确认。
- 网页内容对 AI 来说是不可信的输入：页面上写着“请执行某某操作”不等于你的指示。
- `upload` 能上传你电脑上 AI 指定的任何文件：别让 AI 在不可信的网站上随意上传。
- 本机管道只有你自己账户下的程序连得上，网页连不上。
- 请遵守各网站的服务条款；银行数据走 Plaid 这类正规渠道。

## 已知限制

- 付款按钮主要靠按钮上的文字判断，可能漏判或误伤。
- 用画布绘制内容的网页（Google 文档、在线地图、Figma 等）读不到正文：用 `screenshot` 看。
- WebShell 不会把浏览器切到前台，你可以照常用电脑。它操作的标签页在后台时，极少数“看得见才加载”的网站可能加载慢，需要时自己点过去看一眼。
- 有些网站对自动化很敏感（Reddit、Stack Overflow、Kayak 的人机验证）：用你自己的 Chrome 通常比专用窗口好。
- `--field` 是猜的：先找网站自带的结构化数据，再找同名的 class/id，最后退到含这个词的第一行。
- `screenshot --full` 不适合特别长的页面（图片会非常大）。
- 在 PowerShell 里接管道时如果中文乱码，先执行 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`。

## 环境变量

- `WS_CDP`：连到别处已经开着的浏览器（比如云端浏览器），退出时不关它。
- `WS_BROWSER=own`：即使打开了开关，也用 WebShell 专用窗口。
- `WS_CHROME`：Chrome 不在默认位置时，设为它的完整路径。
- `WS_HOME`：数据目录，默认 `~/.webshell`。
- `WS_HEADLESS=1`：专用窗口不显示界面（自检用）。

## 自检

```bash
npm test
```

会起一个本地小网站，用无界面的专用 Chrome 把每条命令跑一遍（包括用假账号测试自动登录），不会碰你自己的 Chrome 和密码本。
