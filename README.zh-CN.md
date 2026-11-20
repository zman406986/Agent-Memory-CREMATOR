# Agent Memory CREMATOR · 记忆焚化工

**Compaction Reinvented — Erase Meaningless Agent Token Overhead Reversibly.**（名字是这句话各词首字母的缩写）

主流压缩多半是写摘要或直接截断。CREMATOR 重新发明的是不用摘要的压缩——删除和封存。

CREMATOR 是一个 TypeScript 库，不绑死某一家 harness（承载智能体的宿主程序）——只要该 harness 具备 CREMATOR 需要的四条接缝（见后文）。CREMATOR 在内容还新鲜时处理两类内容：能证明的，和智能体自己标记忘掉的。能证明无用且不是搜索落空的，走删除；搜索落空的先追加一条负面事实（记录哪个搜索目标在哪些文件里没找到的简短文本，原文暂留），后续 prune（批量清理）再删；智能体标记忘掉的走删除。它让编码智能体的上下文保持健康，从不写摘要。

[English](README.md) · [中文](README.zh-CN.md)

---

## 问题在哪

编码智能体的上下文，很大一部分被工具输出占着，而这些输出未必还有用。智能体可能不再读第二遍却仍在使用它，所以宿主无法从对话记录判断哪些结果还需要。主流 harness 的做法大同小异：先把东西全留着，等窗口快满了再缩——要么让智能体给自己的臃肿上下文写摘要，要么不打招呼直接截掉最旧的消息。三个毛病：有损、无法审计、时机不对——总在任务中途触发。压掉的字节没有召回 id，找不到原文；哪条事实丢了，只能重新读取或重跑，再付一次 token 成本。CREMATOR 反着来：删除可逆、有账本可查、不写摘要。

## CREMATOR 做什么

CREMATOR 用删除和封存代替写摘要。确定性证明判定一部分内容已无用；其余的去留，由智能体决定。

- **候选只有工具结果，门槛分三处。** 批量询问里，达到或超过 `barBytes` 的整个工具结果作为一个单元（unit）。用户消息和智能体自己的输出从来不是单元，任何规则、任何裁决、任何询问都不能把它们当作候选——候选范围由机制固定，这不是安全保证；keepall（整条保留）之后，适配器只回退自己追加的那次询问交换。entry 询问（结果刚落地的单条询问，默认一次一条，batch 可大于 1）的候选资格是 `floorBytes`（per-model 表，默认 512 字节），低于它的结果照常落地；手动 forget 没有字节门槛，只有证据要求——请求格式正确、行范围落在同一单元内、恰好命中一个单元（多个命中按有歧义拒绝），且只接受非写入、命中该路径的结果。
- **默认路径上的确定性删除，不问智能体。** 静止期（模型调用之间运行的检查）处理两种读取证明：读取过期（后续写入让它作废）、读取已被重读取代（后来一份同字节重读取代了它）；prune 默认处理三类：落空片段、批量里的读取过期、字节完全相同的重复副本。另有两类可选证明，默认关闭：superseded-by-reread（后来的整文件读取覆盖早先读取）、call-echo（结果复述调用参数）——都不是字节比较。被删结果整条离开、追加一条回执。
- **搜索落空只追加负面事实。** 落空片段（围绕一次搜索、没找到目标的一组调用）按规则先追加一条负面事实，原文暂留；后续 prune 再把这些结果整条删除、留下回执。
- **其余单元进询问表，由智能体裁决。** 没有被删除的单元才进询问表；重复副本里保留的那一份不会仅因它是保留份被排除，其他排除规则仍适用；已由 entry 询问定论为保留的单元不再列出。
- **触发。** 上一次已计费请求的 prompt 达到 `pruneThresholdTokens` 时触发（读 harness 上报的用量，滞后一步；第一条用量行之前才退回本地估算）：首次达到就触发；之后，自上次触发以来曾低于阈值，或比基线又涨了一个 `pruneThresholdTokens`，也会触发——基线是上次 pass 开始前的用量，不是上次触发时的用量。pass（每轮处理）每完成一次（包括失败）后，latch（触发开关）用该 pass 开始前的用量重置；宿主原生压缩则清空上次触发记录，下一次达到阈值就触发。
- **表与调用。** 触发后，适配器 fork（复制）主对话的当前状态，把询问表附在副本尾部发出——主对话本身不动。每张表最多 12 个单元，尚未定论的单元多就分多张表发，表的张数随尚未定论的单元增加；每张表一次模型调用。表按发出时的状态提问：每个尚未定论的单元一行，只带路径、行数与行锚点（行数只在 nokeepall 语法下带），不带整段结果正文。询问和裁决文本不写入主对话；裁决触发的删除按后面的应用方式生效。
- **失败处理。** 被拒的行先在下一张表里重问一次；仍被拒，才进一次纠正询问——同一行最多问三次。某张表完全没有文本返回时，只停询问循环：尚未定论的单元保留到下次触发，已证明的确定性删除照常应用。
- **entry 询问走另一条通道。** entry 询问在主对话上临时追加 user/message：正常一问一答两次，纠正成功时四次，纠正失败不追加；keepall 和 forget 之后都回退这次交换。entry 询问的删除也走这里：先回退 ask 与 answer 的交换，再落地带 shape 标记的 shaped 回合，不追加 [not retained] 回执。
- **存活检查管 prune 的整条删除。** prune 里的整条删除（确定性规则和 forgetall）都过守卫（应用前检查整次应用的校验器）和存活检查（survivor gate）；内容存活规则只在同一内容有多个候选时检查：对保留份 forgetall 时，取消的是自动删除副本的那条规则，forget 本身生效。静止期的两条读取证明不经过这道检查；keeplines、forgetlines、手动 forget 与 entry 询问的回答（entry-shape 通道）由守卫校验，不走存活检查。
- **不原地修改已有节点，只做回退加追加。** 一次删除应用（例如手动 forget、一批裁决、一轮 prune 的确定性删除、一次静止期删除）把对话倒回最早被删结果之前（回退点），再追加回执：每条被删结果各一条。原结果节点（对话里的一条消息）离开；裁决保下的行在替换内容里、回执之前重新写出。发 append 之前，规划时先尝试一次整段替换；只有区间起点是工具结果、且覆盖超过一个节点时，才改走每个被删节点各一次单节点替换；以用户消息开头的跨节点区间仍是整段替换。整段替换会按原顺序重新写出区间内未被删除的节点；单节点替换不重新写出幸存节点。回退点之前的前缀仍可命中缓存，被替换的后缀失效。
- **每次删除都可逆。** 删掉的字节全进垃圾账本——只追加，按召回 id 归档；dsh 和 OpenCode 两个适配器都用持久账本，重启之后照样逐字节还原（离线示例用的是内存账本，不跨重启）；召回 id 限在同一次会话里。回执里路径和召回 id 总在，行范围与短标签可能省略。

下面是截短的示意：表只列两行；回执来自 [`examples/core-offline/`](examples/core-offline/README.md)——那里的 forget 删的是整个结果，回执因此没有行范围。

```text
1. [Read] src/needle.ts (call #1) — line 1 of 3 ends with "first line" · line 3 of 3 ends with "third line" [3 lines]
2. [Read] config.ts (call #1) — line 60 of 201 ends with "retries: 3" · line 140 of 201 ends with "exit 1" [201 lines]

[not retained] src/needle.ts — about: auth retry path · necromancy recall:sha256:…
```

## 对 harness 的要求

四条接缝，一条不能少：结果拦截、历史重写或程序化回退、能新增注册工具、静止期钩子（模型调用之间运行的钩子）。缺任何一条的 harness 都不受支持；CREMATOR 也不做 MCP 代理。没有让对话记录完全不变的模式：record-only 下 prune 和 forget 都不应用，但静止期两条读取证明所触发的删除，以及负面事实，照常应用；entry 询问若开启，其裁决照常应用。

## 安装

Node `>=22.13.0 <23.0.0 || >=23.4.0`（这些版本里 `node:sqlite` 不用加 flag）。

```sh
git clone https://github.com/zman406986/Agent-Memory-CREMATOR
cd Agent-Memory-CREMATOR
npm install
npm run build
```

第一次上手，最省事的是 [`examples/core-offline/`](examples/core-offline/README.md)——不需要 dsh 就能跑：

```sh
node --experimental-strip-types examples/core-offline/offline.ts
```

预期输出里有一行 `recalled 34 bytes byte-exact: true`。

dsh 是本项目开发时用的编码智能体 harness，不公开分发。OpenCode 用现成适配器 `cremator-opencode`（先完成上面的本地构建），具体配置全见 [packages/adapters/opencode/README.md](packages/adapters/opencode/README.md)；其他 harness 才要自己写适配器（四条接缝见前文）。

如果你有 dsh，用 dsh 适配器：把下面这段存成文件，传给 `dsh --patch`。`name` 是 file:/// URL，指向构建出来的入口：

```yaml
- insert:
    - id: cremator-mount
      name: 'file:///path/to/Agent-Memory-CREMATOR/packages/adapters/dsh/dist/plugin.js'
      config:
        barBytes: 512
        enforcement: apply
        contextWindowTokens: 400000
        pruneThresholdTokens: 60000
        entryAskTrigger: { mode: 'off' }
        pruneAskGrammar: nokeepall
        nativeCompactionBackstop: true
```

每个 `config` 键都可省略。只写 `pruneThresholdTokens`、不写 `contextWindowTokens` 会直接抛错，挂载失败；只写 `contextWindowTokens`、不写 `pruneThresholdTokens` 会走已弃用的半窗路径；两个都省略时自动 prune 不触发。示例配置用 `entryAskTrigger: { mode: 'off' }`（仅限 dsh 适配器配置）关闭 entry 询问；不写这个键，默认仍是每次结果落地问一次。这条路径保留给手动或兼容用途。config 键、存储布局和降级行为，详见 [packages/adapters/dsh/README.md](packages/adapters/dsh/README.md)。不配存储时，垃圾账本落在 `<DSH_HOME>/storages/cremator`，DSH_HOME 未设时是 `~/.dsh/storages/cremator`。把 URL 里的路径部分换成绝对路径——你本地克隆的仓库中 `packages/adapters/dsh/dist/plugin.js` 那一份；保留 `file:///` 前缀，Windows 上写成 `file:///C:/...` 这种形式。

[`examples/dsh-mount/`](examples/dsh-mount/README.md) 有完整写法，包括启动命令（从仓库根执行）`dsh --profile headless --patch examples/dsh-mount/patch.yml "your task"`；[`examples/core-offline/`](examples/core-offline/README.md) 只跑 core，不带适配器。

## 包

三个包都**没有发布到 npm**。本地构建，按各包 README 接入构建产物。

| 包 | 内容 |
| --- | --- |
| [`@cremator/core`](packages/core/README.md) | 计量器（估算 prompt 的 token 数）、片段（episode，围绕一个目标归组的对话记录段；搜索落空的片段先追加一条负面事实，原文暂留，后续 prune 再删）、规则、全有或全无守卫（应用要么整个通过、要么整个拒绝）、只追加的 SQLite 垃圾账本、回退规划器（core 算回退点与每条回执的挂点；适配器把保留行写回替换内容）、引擎（驱动以上一切的入口）。不导入任何 harness 代码。 |
| [`cremator-dsh`](packages/adapters/dsh/README.md) | dsh 适配器：接缝映射、入口、`forget` 与 `necromancy` 两个工具；`necromancy` 按召回 id 把删掉的字节还原回来。 |
| [`cremator-opencode`](packages/adapters/opencode/README.md) | OpenCode 适配器，细节见其 README。 |

## 状态

还在早期。core、dsh 适配器在真实 dsh 会话里跑过，离线示例端到端跑通。OpenCode 有现成适配器；OpenCode 的可引用证据只有假宿主功能测试，真实运行证据已撤回，真实运行前先读 [OpenCode README](packages/adapters/opencode/README.md) 的警告。局限：尚未证实 CREMATOR 会影响回答质量。

## 许可证

Apache-2.0——见 [LICENSE](LICENSE)。
