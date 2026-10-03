# known_manage — 从对话里把有用的那几句挑出来，挂成你自己的知识树

跟 agent 聊一下午，真正学到的可能就三五句，混在几百句里，过几天就找不到了。这个工具做的事：

1. **拆**：对话、文章拆成一句一句。公式、代码、表格、图整块保留，不拆碎。
2. **挑**：你一句句往下看，`Y` 留、`X` 扔。拆错了 `M` 合并、`E` 改。
3. **入库**：留下的做成知识卡片。每张卡记得来自原文哪句，点一下跳回去。
4. **检查**：LLM 说的不一定对。每张卡标「对 / 改正过 / 存疑 / 错」，写上依据。
5. **归纳**：你自己把卡挂进层级树，再连上别的关系（前提、例子、细化、矛盾、相关）。
6. **看**：层级图像 mermaid 那样从上往下画，能展开、折叠；也能在白板上自己摆位置。

为什么结构要你自己挂、不让 AI 自动挂：AI 画的结构图更整齐，但人记不住；自己挂的更乱，记得反而牢。挂的这一下就是学习。

完整需求和完成情况见 [REQUIREMENTS.md](REQUIREMENTS.md)。

## 两种用法

### 在 dsh 里用（推荐）

```bash
./setup.sh          # 建 Python 环境，装 FastNode 和读 PDF/Word 的库
./dsh-install.sh    # 把插件装进 ~/.dsh/profiles/web（会先备份 package.json）
# 重启 dsh
```

装好后 dsh 里多了三样东西：

- **左下角「知识库」**：打开 / 收起右侧的知识库侧边栏。侧边栏能「加宽」（换成完整布局，看层级图、白板）、「新窗口」打开。
- **每条回答下面「⊕ 入库」**：把这一轮（你的问题 + 这段回答）放进当前仓库，侧边栏自动打开到这份资料，接着挑句子。
- **会话顶部「⊕ 整段入库」**：整段会话一次放进去。

入库读的是 dsh 存在磁盘上的原始 Markdown（`~/.dsh/sessions/…/session.jsonl.zstd`），所以公式是 `$…$` 原样、代码块带着语言标记进来，不经过页面渲染。dsh 自己塞进会话的系统提示、技能清单、运行上下文都会去掉，只留你打的字和它的回答（思考过程、工具调用也不要）。

插件会自己用 `.venv` 里的 Python 起知识库服务（默认 8795 端口，被占就往上找），dsh 关它也关。卸载：`./dsh-install.sh remove`。

### 单独用

```bash
.venv/bin/python -m km --open          # http://127.0.0.1:8790/
```

`--db 某个.db` 直接打开某个仓库，`--repos 文件夹` 换新仓库存放位置，`--port` 换端口。只监听本机。

## 仓库

一个仓库 = 一个 FastNode 数据库文件，一个仓库一棵知识树。顶部的仓库菜单里可以：

- **新建**：起个名字，建在 `data/repos/` 下，马上切过去；
- **打开**：填任意位置的 `.db`。不是 FastNode 库的文件会被拒绝，不会往里面写东西；
- **切换**：列表里点一下。下次启动自动打开上次用的。

## 能导入什么

| 来源 | 怎么导入 |
|---|---|
| 粘贴文字、Markdown、网页内容 | 「导入 → 粘贴」 |
| 一个文件夹 / 代码仓库里的所有文档 | 「导入 → 文件夹」，填路径（在 dsh 里默认是当前会话的工作目录）。导 md/txt/tex/rst/html/pdf/docx/ipynb，跳过 .git、node_modules、.venv、build 等 |
| 单个文件 | 「导入 → 文件」，可多选：.md .txt .tex .rst .html .pdf .docx .ipynb |
| ChatGPT / Claude.ai 导出的 json | 「导入 → 文件」 |
| Claude Code 会话 | 「导入 → Claude Code 会话」，列出 `~/.claude/projects` 下最近的会话 |
| dsh 会话 | dsh 里点「⊕ 入库」/「⊕ 整段入库」 |

网页里 KaTeX、MathJax 渲染过的公式会还原成 TeX；Jupyter 的 markdown 单元原样、代码单元带语言标记。

## 能显示什么

- 公式：`$…$`、`$$…$$`、`\(…\)`、`\[…\]`、`\begin{align}…`、矩阵、```` ```math ````、化学式 `\ce{H2O}`
- 代码高亮、表格、引用、列表、图片、链接、mermaid 流程图
- `$5 和 $10`、`$HOME/bin:$PATH` 这种不会被误当成公式

显示用的库（KaTeX、markdown-it、highlight.js、mermaid、DOMPurify）都在 `km/web/vendor/`，断网也能用。

## 四个页面

| 页面 | 干什么 | 快捷键 |
|---|---|---|
| ① 拆分与筛选 | 一句句看，留 / 扔 / 改 / 合并；留下的勾几句合成一张卡 | `J/K` 上下，`Y` 留，`X` 扔，`E` 改，`M` 合并到上一句，`C` 做卡 |
| ② 卡片与链接 | 左：层级树（拖到卡上 = 挂到它下面，拖到两张之间 = 调顺序）；中：卡片，原地编辑；右：核对 + 关系 | `E` 编辑，`⌘↵` 保存，`Esc` 取消 |
| ③ 层级图 | 严格树从上往下画；`+/−` 展开下一级，`▾` 展开内容；所有关系都画、每种能单独开关；右边显示 level/parent/order/path；导出 JSON | 拖空白处平移，滚轮缩放，双击打开 |
| ④ 摆放 | 白板，自己拖位置，位置会存 | 同上 |

### 卡片之间的关系

| 关系 | 读法 | 画法 |
|---|---|---|
| 属于 | A 属于 B（B 是 A 的上一级）。**每张卡只有一个上级**，组成层级树 | 灰色树线 |
| 前提是 | 先懂 B 才能懂 A | 橙 |
| 是…的例子 | A 是 B 的例子 | 绿 |
| 细化了 | A 把 B 讲细了 | 紫 |
| 矛盾 | A 和 B 说的对不上（比如 LLM 前后说法不一） | 红 |
| 相关 | 有关系但说不清是哪种 | 灰点线 |
| 正文提到 | 卡片正文里写了 `[[B 的标题]]`，自动生成 | 灰虚线 |

`[[标题]]` 输入 `[[` 会自动补全；B 改名，A 里的引用跟着改；先写了 `[[还没有的卡]]`，等那张卡建好会自动连上。

### 层级规则（严格树）

- 每个仓库一个根节点，所有卡都在它下面，没有游离的卡；
- 每张卡有且只有一个上级，不许转圈；
- 同一级的顺序永远是 0, 1, 2…；
- 删掉一张卡，它的下级按原来的顺序接到它的上级下面；
- 「导出 JSON」得到 `{nodes, structure: {root, entries: {level, parent, order, path}}, refs}`，`knowledge_tree_viewer.html` 能直接加载（它会校验，这里导出的通过）。

## 数据怎么存的

底层是 [FastNode](../Node)（同级目录 `Node`），SQLite 上的节点库：

```text
source  导入的一份资料
unit    拆出来的一句 / 一块              unit -in_source-> source
card    一张知识卡片                    card -from_unit-> unit          （出处）
                                        card -belongs_to-> card        （层级）
                                        card -<其他关系>-> card
                                        card -mentions-> card          （正文 [[ ]]）
```

用 FastNode 自己的命令行也能读：`../Node/target/release/fastnode data/repos/我的知识库.db stats`。

## 测试

```bash
.venv/bin/python -m unittest discover -s tests -v                 # 知识库：拆句、导入、存储、层级、接口
node --test dsh-plugin-known-manage/test/host.test.js             # dsh 插件：读会话、去掉系统注入、公式原样
```

## 文件

```text
km/split.py        拆句子 / 块
km/importers.py    各种格式 → Markdown
km/store.py        卡片、关系、严格层级（FastNode）
km/repos.py        多仓库
km/server.py       本机 HTTP 接口
km/web/            页面（app.js 交互，render.js 公式和 Markdown）
dsh-plugin-known-manage/   dsh 插件（host.js 起服务、读会话、入库；client.js 侧边栏和按钮）
dsh-install.sh     装 / 卸 dsh 插件
REQUIREMENTS.md    需求清单和完成情况
```
