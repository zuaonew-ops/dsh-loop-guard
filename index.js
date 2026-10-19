/**
 * dsh-loop-guard —— 宿主半区。
 *
 * ## 为什么存在
 *
 * 用户报的现象：「对话无限重复、卡会话、一个子会话运行时间过长」。
 *
 * 从会话日志里查到的真相（`_repeat-probe.mjs` / `_repeat-timing.mjs` / `_session-scan.mjs`）：
 * 模型会陷入**推理循环** —— 流里源源不断地产出 `reasoning-delta`，一个文本分片都不出，
 * 然后流以错误收场。DSH 把这种「同一次确定性失败」按默认重试策略重试 5 次，
 * 而每次尝试本身要跑 1–5 分钟，于是：
 *
 * - 子会话 `aa01cb95`：同一步 5 次尝试分别产出 20,704 / 16,902 / 3,163 / 21,103 / 11,827 个
 *   推理分片、**文本分片 0 个**，整步 18.4 分钟 —— 正好撞上子会话 18.4 分钟的硬顶被杀，零产出。
 * - 主会话 `session-c502a332`：turn 45 / step 11 耗时 **3.48 小时**，同样是 5 次重试。
 *   这一条形态不同：6 次尝试里 5 次推理分片为 0，时间戳之间是 1.95 小时 + 1.5 小时的
 *   **零分片空档** —— 是「卡住不动」，不是「分片洪水」。规则 B 就是为它加的。
 * - 全量扫描 333 个会话：**38 个** depth=1 / turn=1 的失败子会话总时长**恰好 18.4 分钟**。
 *
 * 也就是说：**重试把一次本来只要几秒就能判定的失败，放大成了几十分钟到几小时的卡死。**
 *
 * ## 做什么
 *
 * 三道防线，都在 DSH 已公开的事件上，不碰任何内部实现：
 *
 * 1. `llm/stream`（waterfall）—— 包住上游流，逐块统计。一旦判定为推理循环，
 *    **停止向上游取值**并直接吐一个终结块 `{type:'finish', reason:{kind:'error',
 *    failure:{code:'LOOP_GUARD', …}}}`，把这次尝试提前掐断。触发前的每个块**原样透传**。
 * 2. `agent/request-error`（waterfall）—— 只认自己产的 `LOOP_GUARD`。允许
 *    `maxGuardedRetries` 次纠正重试，之后**返回 undefined 让失败终结**，不再把
 *    同一次循环重试 5 遍。其它任何失败码一律 `next()` 委托，绝不干预。
 * 3. `agent/request`（waterfall）—— 最近刚循环过的 agent，下一次请求把
 *    `reasoningEffort` 降一档（`max → high → low → off`），给它一条真正能走通的路。
 *
 * ## 判定条件（`detectTrip`，纯函数，可单测）
 *
 * 观测到的坏形态有**三种**，所以有四条规则：
 *
 * - A 洪水：推理分片数 ≥ `reasoningChunkLimit` **且** 产出分片（text / tool-call）为 0
 * - B 沉默：**连续 `stallTimeoutMs` 毫秒一个分片都没收到**（首块之前也算）
 * - C 渗流：已耗时 ≥ `noOutputMs` **且** 产出分片为 0（分片在慢慢来，但一直不出东西）
 * - D 绝对上限：已耗时 ≥ `attemptBudgetMs`（不看产出，任何单次尝试都不该跑这么久）
 *
 * A、C 都带「产出为 0」这个必要条件：**只要模型真的在出文本或调工具，它们绝不插手**，
 * 这是防误杀的关键。B 是「沉默」—— 沉默就是沉默，有没有出过文本都拦。D 是兜底天花板。
 *
 * ### 为什么规则集是这四条（v0.3 改动，来自对抗式验证的实测）
 *
 * v0.1 有 `time` 规则（「已耗时 ≥ 240 秒且产出为 0」），被证伪并删除：
 * `productiveDeltas` 不含推理分片，所以「先长时间思考、再开始作答」的正常请求
 * 可能在 4 分钟处被误杀。它要抓的东西已被 A（洪水）和 B（沉默）覆盖 —— 但**没有完全覆盖**。
 *
 * v0.2 只有 A/B/D 三条时，独立验证者用真实语料找出了**决定性反例**：
 * 真机上真实发生过的那次循环是 5,450 个推理分片、**耗时 256 秒**（≈47 毫秒一片，
 * 全程**没有任何 ≥ 180 秒的空档**）、产出 0、已 260 秒 ——
 * A 要 ≥ 20000 片（不够）、B 要 ≥ 180 秒空档（没有）→ **三条规则一条都不命中**，
 * 只能等 D 的 30 分钟。这就是「慢速渗流循环」，所以 v0.3 补回一条中间档 C（`noOutputMs`）。
 *
 * C 与 v0.1 被删的 `time` 规则形状相同，但默认值从 240 秒放宽到 **600 秒**（2.5 倍）：
 * 验证者在 109 次含分片的真实尝试里没找到「产出为 0 且合法地超过 10 分钟」的用例。
 * 这条规则是四条里**最可能误杀**的一条，README §7 有独立条目说明怎么调。
 *
 * D 从 v0.1 的「预算 × 3 = 12 分钟」改成独立的 30 分钟，因为实测一条**一直在正常出文本**
 * 的流会在 12 分钟被无条件切断。
 *
 * ### 为什么规则集是这五条（v0.4 新增 `repeat`，来自实测的退化重复）
 *
 * 上面 A–D 覆盖不了**第四种坏形态：退化重复**（用户报「这个工作区有一个会话出现了无限重复的问题」，
 * 并指明「问题在思考里面」）。实测会话
 * `session-b0a019e8-b1a5-4822-ae06-b1491997d29e`（provider `pi` / model `tier-std`
 * → `responseModel: deepseek-v4.1-flash`）：
 *
 * | turn/step | 字符数 | 非空行 | 唯一行占比 | 最高频行 | 次数 | stopReason |
 * |---|---|---|---|---|---|---|
 * | 23/12 | 102,796 | 6,603 | 3.8% | `Let me go.` | 3,052 | length |
 * | 25/1  |  97,614 | 7,074 | 1.2% | `Let me go.` | 3,332 | length |
 * | 26/1  |  91,542 | 6,623 | 0.5% | `Let me go.` | 3,302 | toolUse |
 * | 26/3  |  85,705 | 5,947 | 1.5% | `Let me go.` | 2,931 | （被用户中止） |
 *
 * 形态是**短句循环**（周期 2–3 个短语、块间夹空行）：`Let me go.` / `Let me write.` /
 * `Let me do it.` 反复数千次，单块 85K–102K 字符。四条旧规则**一条都不命中**：
 * 分片一直在来（`stall` 不触发）、推理分片数远未到 20000（`chunk` 不触发）、
 * 产出分片 > 0（`noOutput` 不触发）、耗时未到 30 分钟（`absolute` 不触发）。
 * 模型自己不停，只能跑到 max-tokens（`stopReason: "length"`）或被用户手动中止。
 *
 * 所以 v0.4 补第五条 E（`repeat`）：只看**最近 `repeatWindowChars` 个字符**的窗口，
 * 把窗口按行（trim 后去掉空行）统计 —— 行数 ≥ `repeatMinLines`、
 * 唯一行占比 ≤ `repeatUniqueRatio`、且最高频那一行出现次数 ≥ `repeatCycles`
 * （即同一行确实重复了至少这么多轮）就判死。窗口只吃 reasoning-delta 与 text-delta
 * （tool-call 分片不参与）。它与 A/C 的「产出为 0」必要条件**无关** ——
 * 它拦的正是「一直在出东西、但出的是同一小段」，这是 A/B/C/D 全都不看的一个维度。
 *
 * 优先级排在 `noOutput` 之后、`absolute` 之前：真的在重复就先报 `repeat`；
 * 而「零产出且已超 `noOutputMs`」仍优先报 `noOutput`（那条更保守）。
 *
 * #### E 的第二档：单行/少行退化由 k-gram 兜底（契约修订 3）
 *
 * 上面那条「按行统计」的判据有个**结构性缺口**：**单行块的唯一行占比恒等于 1.0**，
 * 所以 `lines < repeatMinLines` 的块无论重复得多厉害都命中不了。全语料实测
 * （338 会话 / 19,624 块 / 40,340,284 字符）：满窗且 `lines < 30` 的 414 块里，
 * 真退化 2 块 —— `c502a332 75/85 text` 9,351 字符 1 行（尾部 `" Emmettled Emmettled …"`）
 * 与 `b0a019e8 25/1 text` 6,570 字符 1 行（尾部 `"rite .write .write …"`）。
 *
 * 所以同一分支里再加一档 `gramTrip`：窗口**仍必须满**，只在 `lines < repeatMinLines`
 * 这一档上，用**不重叠的 `REPEAT_GRAM_CHARS`(8) 字符片段唯一率 ≤ `repeatGramRatio`(0.10)**
 * 兜底。实测这两个块的 k8 = 0.0067 / 0.0093，而其余 412 块 **k8 ≥ 0.88**（断层 95 倍）。
 * 阈值本身在契约修订 4 里从 0.35 收到 0.10：0.35 会误杀中文长单行自然语言
 * （自然散文 0.3613 只剩 3% 余量，编号列表/模板句/技术句/中英混排代码 0.1760–0.2733 全被误杀）。
 * 两档判据互斥
 * （`lines >= repeatMinLines` 与 `lines < repeatMinLines`），`lineTrip` 的文案一个字未改。
 *
 * **已知限制（v0.4 当时不做，已被修订 5 取代 —— 见下一节）**：块长 < `repeatWindowChars`
 * 的**短块缺口**在 v0.4 里不处理。语料里有 7 个真退化短块（2,029–4,521 字符，
 * k8 0.2554–0.3497），v0.4 全部漏检。下面第三档把这条缺口补掉了。
 *
 * #### E 的第三档：分段化 + 最低字符门槛（契约修订 5，v0.5）
 *
 * 上面两档都建立在**单个尾部窗口**上，于是留下两个**结构性**缺口：
 *
 * - **短块缺口**：前置「窗口必须满 `repeatWindowChars`(6000)」使块长 < 6000 的块永不判定。
 *   全语料有 7 个真退化短块（2,029–4,521 字符），形态与长块完全一样（`Let me go.` / `Emit.` 循环）。
 *   它们抓不到**不是阈值问题**：k8 = 0.2554–0.3497，而中文长单行自然散文是 0.3613 —— 只差 1.03×，
 *   k-gram 口径下没有可用分界。但它们的**行**指标极干净（`19/8`：2,029 字符 / 179 行 /
 *   唯一行占比 0.0782 / `Emit.` ×80），所以正解是**降低字符门槛让行判据看得到它们**。
 * - **稀释边界**：两条判据都是**窗口级**指标，退化段只占窗口一部分时被前面正常内容稀释。
 *   验证者构造用例：3,000 正常 + 3,010 重复 → 整窗 k8 **0.5080，完全不触发**；
 *   前置 400 高熵 + 5,600 重复 → 0.0907（仅比阈值低 1.10×）。
 *
 * 改法两处（`repeatMinChars` 默认 1000）：
 *
 * 1. 前置从「窗口必须满 `repeatWindowChars`」换成「至少 `repeatMinChars`」。
 * 2. 指标从「整窗」换成「**多尺度子窗最坏值**」：在窗口上枚举尺度
 *    `S = repeatMinChars × 2^k`（再加窗口本身），步长 `floor(S/2)`，取长度 S 的所有**后缀**子窗，
 *    然后取最坏的那个指标。k8 在**空白压缩后**的文本上算 —— 否则深缩进代码会产生大量
 *    相同的 8 空格片段，在 1000 字符的小子窗上足以把唯一率压到阈值以下（那是排版重复）。
 *
 * 全语料实测（340 会话 / 7,982 个 ≥1000 字符的块）：分段行判据(0.2) 命中 **216**、
 * 分段 k-gram(0.10) 命中 **18**、并集 **218**，**非退化会话命中 0**；v0.4 的 26 个旧命中
 * 一个不丢，7 个短块全部命中。首个误杀出现在阈值 0.30（`top="```"` 的 markdown 围栏块，
 * ratio 0.2574），所以 0.2 对最近的误杀有 **1.29×** 余量。
 * 契约与完整测量见仓库根目录 `_repeat-fix-contract-v2.md`。
 *
 * ## 设计约束（照 dsh-bug-reporter 的既有做法）
 *
 * - **不 import 任何 `@deepseek-ai/*` 值**：只用 `node:*`。宿主服务一律走
 *   `ctx.inject([...], scoped => ...)` 软依赖 —— `webServer` 缺了不影响加载，只是没有设置页。
 * - 透传路径**不改写、不丢弃、不重排**任何上游块；上游 iterator 的 `return()` 一定被调用。
 * - 统计只放内存，不写盘；只有界面能改的那几个设置才持久化。
 *
 * @module dsh-loop-guard
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** HTTP 路由前缀。浏览器半区按它取数，不做成可配置项。 */
const ROUTE_PREFIX = '/loop-guard'

/** 默认设置文件名，落在 `$DSH_HOME` 下。 */
const SETTINGS_FILE = 'loop-guard-settings.json'

/** 请求体上限：64 KiB（设置就几个数，用不到 1 MiB）。 */
const MAX_BODY = 64 * 1024

/**
 * 守卫自己产的失败码。用自定义字符串而不是复用 `TRANSPORT` / `EMPTY_RESPONSE`：
 * `LlmFailure.code` 是普通 string，自定义码不会被默认重试策略命中，
 * 也让 `agent/request-error` 能**只认自己**、绝不误伤真实网络故障。
 */
const LOOP_GUARD_CODE = 'LOOP_GUARD'

/**
 * 判定规则名。`stall`（沉默）是 v0.2 新增的，`noOutput`（渗流）是 v0.3 新增的 ——
 * 见文件头「为什么规则集是这四条」。
 */
const RULE_CHUNK = 'chunk'
const RULE_STALL = 'stall'
const RULE_NO_OUTPUT = 'noOutput'
const RULE_ABSOLUTE = 'absolute'

/** 判定规则名。`repeat`（输出退化重复）是 v0.4 新增的 —— 见文件头「为什么规则集是这五条」。 */
const RULE_REPEAT = 'repeat'

const MIN_REPEAT_WINDOW_CHARS = 1000
const MAX_REPEAT_WINDOW_CHARS = 200000
/**
 * `repeatMinChars` 的下限（字符）。**契约修订 5 新增**。
 *
 * 这是判据的**最低字符门槛**，取代 v0.4「窗口必须满 `repeatWindowChars`」这个前置 ——
 * 那个前置让块长 < `repeatWindowChars` 的块结构上永不判定（短块缺口）。
 * 取 500 而不是更小：500 字符的子窗只有 62 个 8 字符片段，样本太小，唯一率方差会变大。
 */
const REPEAT_SEG_MIN_CHARS = 500
const MIN_REPEAT_MIN_LINES = 5
const MAX_REPEAT_MIN_LINES = 5000
const MIN_REPEAT_CYCLES = 2
const MAX_REPEAT_CYCLES = 100
const MIN_REPEAT_UNIQUE_RATIO = 0.01
const MAX_REPEAT_UNIQUE_RATIO = 0.9

/** k-gram 兜底的片段长度（字符）。不开放成配置项。 */
const REPEAT_GRAM_CHARS = 8
const MIN_REPEAT_GRAM_RATIO = 0.01
const MAX_REPEAT_GRAM_RATIO = 0.9

/**
 * 推理档位阶梯，**来源**：`@deepseek-ai/dsh-llm` 的 `lib/types/model-info.js`
 * 里 `REASONING_EFFORTS` 的数组顺序 —— `off → low → high → max`。
 *
 * 只在「当前档位正好是这四档之一」时才降档；`pi/tier-std` 目前不广告任何档位
 * （`list_subagent_models` 返回 `(no advertised reasoning efforts)`），所以这个特性
 * 对它是空操作 —— 这是有意的：宁可不动，也不要瞎猜档位名。
 */
const EFFORT_LADDER = ['off', 'low', 'high', 'max']

/** 循环判定后，多久之内到达的下一次请求算「纠正重试」并降档。 */
const EFFORT_WINDOW_MS = 120000

const DEFAULTS = {
  /** 总开关。false 则三个监听全部不装，完全不干预。 */
  enabled: true,
  /** 推理分片数上限（配合「产出为 0」）。默认 20000：实测循环在 20,704 分片附近。 */
  reasoningChunkLimit: 20000,
  /**
   * **绝对**时间上限（毫秒，≥ 10000）。默认 1800000 = 30 分钟，**不看产出**。
   *
   * 这是最后兜底，不是主要防线：主要防线是 `stallTimeoutMs`。
   * v0.1 这里是 240000（4 分钟）且另有「预算 × 3」的派生上限，实测会切断
   * 一条一直在正常出文本的长流，所以 v0.2 把它提到 30 分钟并取消派生。
   */
  attemptBudgetMs: 1800000,
  /**
   * **零分片沉默**上限（毫秒，≥ 10000）。默认 180000 = 3 分钟。
   *
   * 连续这么久一个分片都没收到就判定卡死 —— 首块之前（TTFT 卡住）也算。
   * 这是针对实测最坏用例（3.48 小时卡死里有 1.95h + 1.5h 的零分片空档）加的规则。
   */
  stallTimeoutMs: 180000,
  /**
   * **零产出渗流**上限（毫秒，≥ 10000）。默认 600000 = 10 分钟。
   *
   * 分片在慢慢来（所以 `stall` 不触发），但一直是推理、**产出分片始终为 0**，
   * 累计到这么久就判死。这是 v0.3 补的中间档，专门覆盖实测的那条真实循环：
   * 5,450 个推理分片 / 256 秒（≈47 毫秒一片，全程没有 ≥180 秒空档）/ 产出 0 ——
   * 洪水档要 ≥20000 片（不够）、沉默档要 ≥180 秒空档（没有），只有这一档能及时命中。
   *
   * **这是四条规则里最可能误杀的一条**：一次合法的「长时间思考、还没开始作答」
   * 也会满足「产出为 0」。默认取 600 秒（比 v0.1 被删的 240 秒 `time` 规则宽松 2.5 倍）；
   * 独立验证在 109 次含分片的真实尝试里没找到「产出为 0 且合法超过 10 分钟」的用例。
   * 如果你确实有超长思考的正常请求，把它调大（或调到极大等于关掉这一档）。
   */
  noOutputMs: 600000,
  /**
   * `repeat`（输出退化重复）的观测窗口长度（字符，整数）。默认 6000。
   *
   * 实测退化块里最高频一行出现 2,931–3,332 次、唯一行占比 0.5%–3.8% ——
   * 6000 字符的窗口足够看出「同一小段在循环」，又不会把正常散文卷进来。
   */
  repeatWindowChars: 6000,
  /**
   * `repeat` 两条判据的**最低字符门槛**（整数，`REPEAT_SEG_MIN_CHARS`(500) .. `repeatWindowChars`）。
   * 默认 1000。**契约修订 5 新增**。
   *
   * v0.4 的前置是「窗口必须满 `repeatWindowChars`(6000)」，于是**块长 < 6000 的块永不判定**。
   * 全语料实测这构成真实缺口：7 个真退化短块（2,029–4,521 字符，同一个 `Let me go.` /
   * `Emit.` 形态）一个都抓不到。把前置换成这个门槛后，全语料命中从 24 涨到 216，
   * 且**误杀仍为 0**（216 个命中全部落在两个已知退化会话里）。
   *
   * 为什么不能只调阈值解决短块：那 7 个短块的 k8 是 0.2554–0.3497，而中文长单行自然散文
   * 是 0.3613 —— 只差 1.03×，k-gram 口径下**没有可用的分界**。它们的行指标却极干净
   * （如 `19/8`：2,029 字符 / 179 行 / 唯一行占比 0.0782 / `Emit.` ×80），
   * 所以真正管用的是**降低字符门槛让行判据看得到它们**，不是放松 k-gram 阈值。
   */
  repeatMinChars: 1000,
  /** 窗口内至少要有这么多**非空行**才判 `repeat`。默认 30（防短输出误杀）。 */
  repeatMinLines: 30,
  /**
   * 窗口内**最高频那一行**至少要出现这么多次，即同一行至少重复了这么多轮。默认 6。
   *
   * 契约修订 2 前是「行数 ≥ `repeatCycles` × 唯一行数」，实测会漏检 turn 24/1
   * （末窗口 312 行 / 60 唯一：312 < 6×60 = 360，但 `Let me go.` 已重复 233 次）。
   */

  repeatCycles: 6,
  /** 窗口内唯一行占比的上限（≤ 它就判 `repeat`）。默认 0.2。 */
  repeatUniqueRatio: 0.2,
  /**
   * k-gram 兜底的 8 字符片段唯一率上限（≤ 它就判 `repeat`）。默认 **0.10**。
   *
   * 只覆盖「行数不足」的单行/少行退化 —— 单行块的唯一行占比恒等于 1.0，
   * `repeatUniqueRatio` 判据结构上不可能命中。全语料实测：满窗且 `lines < 30` 的
   * 414 块里真退化 2 块（k8 = 0.0067 / 0.0093），其余 412 块 k8 ≥ 0.88（断层 95 倍）。
   *
   * **契约修订 4（0.35 → 0.10）**：0.35 对**中文长单行自然语言**会误杀 ——
   * 实测（6000 字符满窗、1 行）中文自然散文 0.3613（只剩 3% 余量）、中文编号列表 0.2733、
   * 中文模板句 0.2293、中文技术句 0.1920、中英混排代码 0.1760。取 0.10 后这些全部不触发，
   * 而两个真退化仍有 10.7× / 14.9× 余量（对最低的非退化样本 0.1760 有 1.76× 余量）。
   * **调高它会让长单行自然语言更容易被误杀**（用户仍可在 0.01–0.9 之间自行调整）。
   */
  repeatGramRatio: 0.1,
  /** 允许的纠正重试次数（0–5）。默认 1。 */
  maxGuardedRetries: 1,
  /** 纠正重试时是否把 reasoningEffort 降一档。 */
  lowerEffortOnRetry: true,
  /** 设置文件路径；留空用 `$DSH_HOME/loop-guard-settings.json`。 */
  settingsPath: '',
  /** 最近触发记录条数上限（1–500）。 */
  maxRecent: 50,
  /** 调试日志。 */
  debug: false,
}

const BOOLEAN_KEYS = new Set(['enabled', 'lowerEffortOnRetry', 'debug'])
const NUMBER_KEYS = new Set([
  'reasoningChunkLimit',
  'attemptBudgetMs',
  'stallTimeoutMs',
  'noOutputMs',
  'repeatWindowChars',
  'repeatMinChars',
  'repeatMinLines',
  'repeatCycles',
  'repeatUniqueRatio',
  'repeatGramRatio',
  'maxGuardedRetries',
  'maxRecent',
])
/** 界面能改的键 —— 只有这些会被持久化。 */
const PERSISTED_KEYS = new Set([
  'enabled',
  'reasoningChunkLimit',
  'attemptBudgetMs',
  'stallTimeoutMs',
  'noOutputMs',
  'repeatWindowChars',
  'repeatMinChars',
  'repeatMinLines',
  'repeatCycles',
  'repeatUniqueRatio',
  'repeatGramRatio',
  'maxGuardedRetries',
  'lowerEffortOnRetry',
])

const MIN_CHUNK_LIMIT = 100
const MIN_ATTEMPT_BUDGET_MS = 10000
const MIN_STALL_TIMEOUT_MS = 10000
const MIN_NO_OUTPUT_MS = 10000
const MAX_GUARDED_RETRIES = 5
const MIN_RECENT = 1
const MAX_RECENT = 500

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 配置默认值的浅拷贝。 */
function defaultsCopy() {
  return { ...DEFAULTS }
}

/**
 * 校验并归一化插件配置。未知键直接抛错并点名 —— 不静默兜底。
 *
 * @param {unknown} raw
 * @returns {typeof DEFAULTS}
 */
function resolveConfig(raw) {
  if (raw === undefined || raw === null) return defaultsCopy()
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-loop-guard: config 必须是一个映射（mapping）')
  }
  const resolved = defaultsCopy()
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      throw new Error(
        `dsh-loop-guard: 未知的 config 键 "${key}"（可用：${Object.keys(DEFAULTS).join(', ')}）`,
      )
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') throw new Error(`dsh-loop-guard: config.${key} 必须是 boolean`)
    } else if (NUMBER_KEYS.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`dsh-loop-guard: config.${key} 必须是有限数字`)
      }
      if (key === 'reasoningChunkLimit' && value < MIN_CHUNK_LIMIT) {
        throw new Error(`dsh-loop-guard: config.reasoningChunkLimit 必须 >= ${MIN_CHUNK_LIMIT}`)
      }
      if (key === 'attemptBudgetMs' && value < MIN_ATTEMPT_BUDGET_MS) {
        throw new Error(`dsh-loop-guard: config.attemptBudgetMs 必须 >= ${MIN_ATTEMPT_BUDGET_MS}`)
      }
      if (key === 'stallTimeoutMs' && value < MIN_STALL_TIMEOUT_MS) {
        throw new Error(`dsh-loop-guard: config.stallTimeoutMs 必须 >= ${MIN_STALL_TIMEOUT_MS}`)
      }
      if (key === 'noOutputMs' && value < MIN_NO_OUTPUT_MS) {
        throw new Error(`dsh-loop-guard: config.noOutputMs 必须 >= ${MIN_NO_OUTPUT_MS}`)
      }
      if (
        key === 'repeatWindowChars' &&
        (!Number.isInteger(value) || value < MIN_REPEAT_WINDOW_CHARS || value > MAX_REPEAT_WINDOW_CHARS)
      ) {
        throw new Error(
          `dsh-loop-guard: config.repeatWindowChars 必须是 ${MIN_REPEAT_WINDOW_CHARS}..${MAX_REPEAT_WINDOW_CHARS} 的整数`,
        )
      }
      if (
        key === 'repeatMinChars' &&
        (!Number.isInteger(value) || value < REPEAT_SEG_MIN_CHARS || value > MAX_REPEAT_WINDOW_CHARS)
      ) {
        throw new Error(
          `dsh-loop-guard: config.repeatMinChars 必须是 ${REPEAT_SEG_MIN_CHARS}..${MAX_REPEAT_WINDOW_CHARS} 的整数`,
        )
      }
      if (
        key === 'repeatMinLines' &&
        (!Number.isInteger(value) || value < MIN_REPEAT_MIN_LINES || value > MAX_REPEAT_MIN_LINES)
      ) {
        throw new Error(
          `dsh-loop-guard: config.repeatMinLines 必须是 ${MIN_REPEAT_MIN_LINES}..${MAX_REPEAT_MIN_LINES} 的整数`,
        )
      }
      if (
        key === 'repeatCycles' &&
        (!Number.isInteger(value) || value < MIN_REPEAT_CYCLES || value > MAX_REPEAT_CYCLES)
      ) {
        throw new Error(
          `dsh-loop-guard: config.repeatCycles 必须是 ${MIN_REPEAT_CYCLES}..${MAX_REPEAT_CYCLES} 的整数`,
        )
      }
      if (key === 'repeatUniqueRatio' && (value < MIN_REPEAT_UNIQUE_RATIO || value > MAX_REPEAT_UNIQUE_RATIO)) {
        throw new Error(
          `dsh-loop-guard: config.repeatUniqueRatio 必须是 ${MIN_REPEAT_UNIQUE_RATIO}..${MAX_REPEAT_UNIQUE_RATIO} 的数字`,
        )
      }
      if (key === 'repeatGramRatio' && (value < MIN_REPEAT_GRAM_RATIO || value > MAX_REPEAT_GRAM_RATIO)) {
        throw new Error(
          `dsh-loop-guard: config.repeatGramRatio 必须是 ${MIN_REPEAT_GRAM_RATIO}..${MAX_REPEAT_GRAM_RATIO} 的数字`,
        )
      }
      if (key === 'maxGuardedRetries' && (value < 0 || value > MAX_GUARDED_RETRIES || !Number.isInteger(value))) {
        throw new Error(
          `dsh-loop-guard: config.maxGuardedRetries 必须是 0..${MAX_GUARDED_RETRIES} 的整数`,
        )
      }
      if (key === 'maxRecent' && (value < MIN_RECENT || value > MAX_RECENT || !Number.isInteger(value))) {
        throw new Error(`dsh-loop-guard: config.maxRecent 必须是 ${MIN_RECENT}..${MAX_RECENT} 的整数`)
      }
    } else if (typeof value !== 'string') {
      throw new Error(`dsh-loop-guard: config.${key} 必须是 string`)
    }
    resolved[key] = value
  }
  // 跨字段检查放在循环**之后**：`repeatMinChars` 的上限是 `repeatWindowChars`，
  // 而两者的书写顺序不保证，循环内比较会读到还没解析的窗口值。
  if (resolved.repeatMinChars > resolved.repeatWindowChars) {
    throw new Error(
      `dsh-loop-guard: config.repeatMinChars (${resolved.repeatMinChars}) 不能大于 config.repeatWindowChars (${resolved.repeatWindowChars})`,
    )
  }
  return resolved
}

/** 设置文件的绝对路径：显式 `settingsPath` 优先，否则 `$DSH_HOME/loop-guard-settings.json`。 */
function resolveSettingsPath(config) {
  if (config.settingsPath) return resolve(config.settingsPath)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, SETTINGS_FILE)
}

/** 原子写：先写同目录 tmp 再 rename，避免半截文件。 */
function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** 要落盘的设置：只写 `PERSISTED_KEYS` 里的键。 */
function persistedShape(settings) {
  const out = {}
  for (const key of PERSISTED_KEYS) out[key] = settings[key]
  return out
}

/** 把当前设置原子写盘。写失败只 warn，不影响主流程。 */
function saveSettings(ctx, settings) {
  try {
    atomicWrite(resolveSettingsPath(settings), `${JSON.stringify(persistedShape(settings), null, 2)}\n`)
  } catch (error) {
    warn(ctx, error)
  }
}

/**
 * 读持久化的设置。**文件优先于 yml**。
 *
 * 容错四条：文件不存在静默；坏 JSON / 非对象不崩、退回 config；未知键丢弃
 * （必须在这里丢 —— `resolveConfig` 对未知键抛错，漏过去会让整行挂载失败）；
 * 键合法但类型不对的值也丢弃（持久化文件是外部输入）。
 *
 * @returns {Record<string, unknown>}
 */
function loadPersistedSettings(ctx, config) {
  const file = resolveSettingsPath(config)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error === null || error === undefined || error.code !== 'ENOENT') warn(ctx, error)
    return {}
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    warn(ctx, new Error(`dsh-loop-guard: 设置文件 ${file} 不是合法 JSON，已忽略：${error.message}`))
    return {}
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(ctx, new Error(`dsh-loop-guard: 设置文件 ${file} 的内容不是对象，已忽略`))
    return {}
  }
  const kept = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!PERSISTED_KEYS.has(key)) continue
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value === 'boolean') kept[key] = value
      continue
    }
    if (NUMBER_KEYS.has(key)) {
      if (typeof value === 'number' && Number.isFinite(value)) kept[key] = value
    }
  }
  return kept
}

/** 只 warn，不抛 —— 插件的任何内部异常都不该把宿主拖下水。 */
function warn(ctx, error) {
  let message = error instanceof Error ? error.message : String(error)
  // 有些消息（`resolveConfig` 抛的、本文件里手写的）**自带**前缀，直接再拼一次会变成
  // `dsh-loop-guard: dsh-loop-guard: …`。这里先剥掉自带的前缀，只留最外层一个。
  while (message.startsWith('dsh-loop-guard: ')) message = message.slice('dsh-loop-guard: '.length)
  try {
    if (ctx !== null && ctx !== undefined && typeof ctx.logger === 'object' && ctx.logger !== null) {
      if (typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`dsh-loop-guard: ${message}`)
        return
      }
    }
  } catch {
    /* logger 本身炸了就退到 console */
  }
  // eslint-disable-next-line no-console
  console.warn(`dsh-loop-guard: ${message}`)
}

// ---------------------------------------------------------------------------
// 判定（纯函数，单测入口）
// ---------------------------------------------------------------------------

/**
 * 累计一次尝试的观测量。
 *
 * @typedef {object} AttemptState
 * @property {number} reasoningDeltas 推理分片数
 * @property {number} reasoningChars 推理字符数
 * @property {number} textDeltas 文本分片数
 * @property {number} toolCallDeltas 工具调用分片数
 * @property {RepeatState} repeat 退化重复的观测窗口（v0.4）
 */

/**
 * `repeat`（退化重复）的观测窗口。
 *
 * @typedef {object} RepeatState
 * @property {string} window 最近 `repeatWindowChars` 个字符（只吃推理 / 文本分片）
 * @property {number} chars 累计追加过的字符数（只增不减，用来做重算节流）
 * @property {string[]} lines 窗口按行 trim 去空后的行
 * @property {number} unique 唯一行数
 * @property {string} topLine 出现最多的那一行
 * @property {number} topCount 它出现的次数
 * @property {number} ratio 唯一行占比（没有行时为 1）
 * @property {number} checkedAt 上次重算指标时的 `chars`
 * @property {number} gramCount 窗口内不重叠的 `REPEAT_GRAM_CHARS` 字符片段个数（v0.4 修订 3）
 * @property {number} gramRatio 这些片段的唯一率（没有片段时为 1）
 * @property {number} segRatio **分段**口径的最坏唯一行占比（v0.5 修订 5）；没有合格子窗时为 1
 * @property {number} segLines 取到 `segRatio` 的那个子窗的非空行数
 * @property {number} segUnique 那个子窗的唯一行数
 * @property {string} segTopLine 那个子窗里出现最多的行
 * @property {number} segTopCount 它出现的次数
 * @property {number} segScale 那个子窗的尺度（字符）
 * @property {number} segGramRatio **分段**口径的最坏片段唯一率（v0.5 修订 5）
 * @property {number} segGramCount 取到 `segGramRatio` 的那个子窗的**片段总数**
 * @property {number} segGramUnique 同一个子窗里**不重复**的片段个数（`segGramCount` 的子集）
 * @property {number} segGramScale 那个子窗的尺度（字符）
 */

/** 新的观测状态。 */
function createAttemptState() {
  return {
    reasoningDeltas: 0,
    reasoningChars: 0,
    textDeltas: 0,
    toolCallDeltas: 0,
    repeat: {
      window: '',
      chars: 0,
      lines: [],
      unique: 0,
      topLine: '',
      topCount: 0,
      ratio: 1,
      checkedAt: 0,
      gramCount: 0,
      gramRatio: 1,
      segRatio: 1,
      segLines: 0,
      segUnique: 0,
      segTopLine: '',
      segTopCount: 0,
      segScale: 0,
      segGramRatio: 1,
      segGramCount: 0,
      segGramUnique: 0,
      segGramScale: 0,
    },
  }
}

/** 产出分片数 = 文本 + 工具调用。推理分片**不算**产出。 */
function productiveDeltasOf(state) {
  return state.textDeltas + state.toolCallDeltas
}

/** `repeat` 指标重算的节流粒度（字符）。这是**默认窗口下的**间隔，大窗口下按比例放宽。 */
const REPEAT_RECHECK_CHARS = 256

/**
 * 重算节流间隔（字符）。
 *
 * 默认窗口下**恒等于** `REPEAT_RECHECK_CHARS`(256) —— 即 v0.4/v0.5 初版的行为一字不变。
 * 只有把 `repeatWindowChars` 调得很大时才放宽：单次重算要扫 O(窗口 × 尺度数) 个字符，
 * 而窗口越大、每 256 字符带来的新信息占比越小，固定 256 等于白烧 CPU。
 * 验证者实测（`_verify-repeat-report-v3.md` §6⑥）：窗口 200000（UI 允许的上限）时
 * 单次重算 **78.6 ms**、每 1000 字符输出 **307 ms** CPU，即 O(W²)，会卡住事件循环。
 *
 * 取 `max(256, floor(windowChars / 32))`：6000 → **256（不变）**；20000 → 625；60000 → 1875；
 * 200000 → 6250。代价是大窗口下的判定延迟变大（最多多等一个间隔）—— 但那是用户自己把窗口
 * 调到那么大的显式选择，而默认配置的行为与检测时延完全不受影响。
 */
function repeatRecheckCharsOf(windowChars) {
  const w =
    Number.isFinite(windowChars) && windowChars > 0 ? Math.floor(windowChars) : DEFAULTS.repeatWindowChars
  return Math.max(REPEAT_RECHECK_CHARS, Math.floor(w / 32))
}

/** 取 `repeat` 窗口长度：配置里没有这个键（例如只关心旧规则的调用）就退回默认值。 */
function repeatWindowCharsOf(config) {
  if (
    config !== null &&
    typeof config === 'object' &&
    typeof config.repeatWindowChars === 'number' &&
    Number.isFinite(config.repeatWindowChars)
  ) {
    return config.repeatWindowChars
  }
  return DEFAULTS.repeatWindowChars
}

/** 取 `repeat` 判据的最低字符门槛：配置里没有这个键就退回默认值。 */
function repeatMinCharsOf(config) {
  if (
    config !== null &&
    typeof config === 'object' &&
    typeof config.repeatMinChars === 'number' &&
    Number.isFinite(config.repeatMinChars)
  ) {
    return config.repeatMinChars
  }
  return DEFAULTS.repeatMinChars
}

/** 取配置里的数字键：不是有限数字就退回默认值（`repeat` 的阈值键共用这个兜底）。 */
function numberOr(config, key, fallback) {
  if (config !== null && typeof config === 'object') {
    const value = config[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return fallback
}

/**
 * 枚举 `repeat` 窗口上的**多尺度子窗**。**契约修订 5 的核心。**
 *
 * v0.4 的两条判据都只看**整个尾部窗口**，所以是「窗口级」指标 ——
 * 退化段只占窗口一部分时会被前面的正常内容**稀释**。验证者构造的用例：
 * 前置 400 字符高熵 + 5,600 字符 `.write ` 重复 → 整窗 k8 只有 0.0907（仅比阈值低 1.10×）；
 * 前置 3,000 + 重复 3,010（各占一半）→ 整窗 k8 **0.5080，完全不触发**。
 *
 * 解法是把指标从「窗口级」换成「**最坏子窗级**」：在窗口上枚举尺度
 * `S = repeatMinChars × 2^k`（只取 `S <= window.length` 的），步长 `floor(S/2)`，
 * 取窗口的每个长度 S 的**后缀**子窗，然后取所有子窗里最坏的那个指标。
 * 这样「退化只发生在后半段」会由恰好落在退化段里的子窗抓到。
 *
 * 为什么是后缀而不是任意起点：窗口本身就是「最近 N 个字符」，
 * 流式语义下我们只关心**当前尾部**是否已经退化；枚举全部起点会让
 * 早已过去的历史内容反复参与判定，白白扩大误杀面。
 *
 * **纯函数**，不碰 state，方便单测直接喂字符串。
 *
 * @param {string} window 尾部窗口内容
 * @param {{repeatMinChars?:number, repeatWindowChars?:number}} [config]
 * @returns {Array<{scale:number, start:number, end:number, text:string}>} 子窗列表（按尺度升序、同尺度按结束位置升序）
 */
function segWindows(window, config) {
  const out = []
  if (typeof window !== 'string' || window.length === 0) return out
  const minChars = repeatMinCharsOf(config)
  const maxChars = repeatWindowCharsOf(config)
  // 尺度 = 门槛 × 2^k（严格小于窗口），**再加上窗口本身**。
  // 翻倍是刻意的：相邻尺度只差 2×，退化段只要长过最小尺度就一定会被某个尺度完整罩住。
  // 补上 `maxChars` 是因为 6000 不是 1000 的 2 的幂次倍 —— 少了它，
  // 「整窗退化」这个 v0.4 唯一覆盖到的形态反而不在分段集合里了。
  const scales = []
  for (let scale = minChars; scale < maxChars; scale *= 2) scales.push(scale)
  if (maxChars >= minChars) scales.push(maxChars)
  for (const scale of scales) {
    if (scale > window.length) continue
    const stride = Math.max(1, Math.floor(scale / 2))
    for (let end = scale; end <= window.length; end += stride) {
      out.push({ scale, start: end - scale, end, text: window.slice(end - scale, end) })
    }
  }
  return out
}

/**
 * 非重叠 `REPEAT_GRAM_CHARS` 字符片段的唯一率。**先做空白压缩**再切片。
 *
 * 为什么压缩空白：不压缩时「深缩进代码」会产生大量完全相同的 8 空格片段
 * （`"        "`），在 1000 字符的小子窗上足以把唯一率压到阈值以下 ——
 * 那是排版重复，不是输出退化。压缩后空格串塌成单个空格，这类假重复消失。
 *
 * @param {string} text
 * @returns {{count:number, ratio:number}} `count` 为片段个数；不足一个片段时 ratio 记 1（不可判）
 */
function gramRatioOf(text) {
  const collapsed = typeof text === 'string' ? text.replace(/\s+/g, ' ') : ''
  const n = Math.floor(collapsed.length / REPEAT_GRAM_CHARS)
  if (n === 0) return { count: 0, unique: 0, ratio: 1 }
  const seen = new Set()
  for (let i = 0; i < n; i++) seen.add(collapsed.slice(i * REPEAT_GRAM_CHARS, (i + 1) * REPEAT_GRAM_CHARS))
  // `count` 是**片段总数**，`unique` 是其中不重复的个数，`ratio = unique / count`。
  // 消息文案必须把两个数都报出来 —— v0.4 起只报了 `count`，读起来像「只有 count 个不重复」，
  // 语义是错的（验证者 F3：实测 count=750 / unique=7 / ratio=0.00933）。
  return { count: n, unique: seen.size, ratio: seen.size / n }
}

/**
 * 重算 `repeat` 的窗口指标。**不抛异常**：`window` 不是字符串时按空串算。
 *
 * @param {AttemptState} state
 */
function recomputeRepeat(state, config) {
  const rep = state.repeat
  const window = typeof rep.window === 'string' ? rep.window : ''
  const lines = window
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const counts = new Map()
  let topLine = ''
  let topCount = 0
  for (const line of lines) {
    const next = (counts.get(line) ?? 0) + 1
    counts.set(line, next)
    if (next > topCount) {
      topCount = next
      topLine = line
    }
  }
  rep.lines = lines
  rep.unique = counts.size
  rep.topLine = topLine
  rep.topCount = topCount
  rep.ratio = lines.length > 0 ? counts.size / lines.length : 1
  rep.checkedAt = rep.chars

  // 整窗 k-gram（v0.4 语义保留）：同一次节流重算里一并算，不另开遍历。
  const whole = gramRatioOf(window)
  rep.gramCount = whole.count
  rep.gramRatio = whole.ratio

  // 分段口径（契约修订 5）：窗口上枚举多尺度子窗，取**最坏值**。
  // 行口径只在「行数够、且最高频行重复够多」的子窗里比唯一行占比 ——
  // 否则会取到一个恰好行数很少的子窗，把 ratio 压到没有意义的低位。
  const minLines = numberOr(config, 'repeatMinLines', DEFAULTS.repeatMinLines)
  const cycles = numberOr(config, 'repeatCycles', DEFAULTS.repeatCycles)
  let segRatio = 1
  let segLines = 0
  let segUnique = 0
  let segTopLine = ''
  let segTopCount = 0
  let segScale = 0
  let segGramRatio = 1
  let segGramCount = 0
  let segGramUnique = 0
  let segGramScale = 0
  // 这里**不做**「`lines.length >= minLines` 时跳过子窗 k8」的优化（验证者建议过，实测能省 43–49%）。
  // 原因：那会让缓存下来的 `segGramRatio` 依赖**重算时**的 `repeatMinLines`，而 `detectTrip` 可能
  // 拿**另一份** config 来判（单测的边界用例就是这么做的）。作者单测 13.4e 立刻抓到了这个耦合。
  // 真正的 O(W²) 瓶颈由 `repeatRecheckCharsOf` 按窗口放大节流间隔解决（见该函数注释）。
  for (const seg of segWindows(window, config)) {
    const segLineList = seg.text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    if (segLineList.length >= minLines) {
      const segCounts = new Map()
      let segTop = ''
      let segTopN = 0
      for (const line of segLineList) {
        const next = (segCounts.get(line) ?? 0) + 1
        segCounts.set(line, next)
        if (next > segTopN) {
          segTopN = next
          segTop = line
        }
      }
      const ratio = segCounts.size / segLineList.length
      if (segTopN >= cycles && ratio < segRatio) {
        segRatio = ratio
        segLines = segLineList.length
        segUnique = segCounts.size
        segTopLine = segTop
        segTopCount = segTopN
        segScale = seg.scale
      }
    }
    const gram = gramRatioOf(seg.text)
    if (gram.ratio < segGramRatio) {
      segGramRatio = gram.ratio
      segGramCount = gram.count
      segGramUnique = gram.unique
      segGramScale = seg.scale
    }
  }
  rep.segRatio = segRatio
  rep.segLines = segLines
  rep.segUnique = segUnique
  rep.segTopLine = segTopLine
  rep.segTopCount = segTopCount
  rep.segScale = segScale
  rep.segGramRatio = segGramRatio
  rep.segGramCount = segGramCount
  rep.segGramUnique = segGramUnique
  rep.segGramScale = segGramScale
}

/**
 * 把一段文本追加进 `repeat` 窗口：截断到 `repeatWindowChars`，并按契约节流重算指标。
 *
 * @param {AttemptState} state
 * @param {string} text
 * @param {object|undefined} config
 */
function appendRepeatWindow(state, text, config) {
  const rep = state.repeat
  if (rep === null || rep === undefined) return
  if (typeof rep.window !== 'string') rep.window = ''
  const windowChars = repeatWindowCharsOf(config)
  rep.window += text
  rep.chars += text.length
  if (rep.window.length > windowChars) rep.window = rep.window.slice(rep.window.length - windowChars)
  // 节流**主要按已消费字符数**判定，外加一条**一次性**的「窗口刚满补算」。
  //
  // v0.4 起这里挂的是 `|| rep.window.length >= windowChars`，本意就是「窗口刚填满时补算一次」，
  // 但写成条件后**窗口满之后每个分片都会重算** —— 真实流的分片长度中位数是 **2 字符**，
  // 默认配置下每 1000 字符要重算约 500 次、烧掉约 **106 ms** CPU
  // （验证者 task-32 §F8 实测；大窗口长流下 **1,296 ms / 1000 字符**）。
  //
  // 但**不能直接删掉它**（验证者 task-32 复验，8 条断言转红）：删掉之后最后一次重算永远停在
  // 节流边界（默认 5888 = 256 的倍数），于是**满窗那一刻从来没被求值过**。而 `segWindows`
  // 取的是**最差子窗**，它依赖「求值那一刻的窗口长度」——E 样本在窗口 5760/5888 时
  // `segGramRatio = 0.1040`（不触发），在 6000 时才 `0.0540`（触发）。
  // 影响面：① 用户把 `repeatMinChars` 设成等于 `repeatWindowChars`（契约里那个「退回 v0.4 语义」
  // 的可选配置）时必须求值到满窗才可能命中，否则整次漏判；② 阈值附近的形状会因相位翻转。
  //
  // 所以改成**一次性**补算：`rep.checkedAt` 是每次重算时的 `rep.chars`，一旦它 ≥ `windowChars`
  // 就说明「满窗之后已经重算过」，第二分支永久关闭 → 每次 attempt 只多算**一次**，
  // 性能收益基本不变，而判定时机与 v0.4 一致。
  const fullNotYetChecked = rep.window.length >= windowChars && rep.checkedAt < windowChars
  if (rep.chars - rep.checkedAt >= repeatRecheckCharsOf(windowChars) || fullNotYetChecked) recomputeRepeat(state, config)
}

/**
 * 把一块流分片计入观测状态。**只读，不改分片本身。**
 *
 * `repeat` 窗口只吃 `reasoning-delta` 与 `text-delta`（契约 §3）—— 工具调用分片不参与。
 *
 * @param {AttemptState} state
 * @param {unknown} chunk
 * @param {{repeatWindowChars:number}} [config] 省略时 `repeat` 窗口用 `DEFAULTS.repeatWindowChars`
 */
function countChunk(state, chunk, config) {
  if (chunk === null || typeof chunk !== 'object') return
  const type = chunk.type
  if (type === 'reasoning-delta') {
    state.reasoningDeltas += 1
    if (typeof chunk.text === 'string') {
      state.reasoningChars += chunk.text.length
      appendRepeatWindow(state, chunk.text, config)
    }
  } else if (type === 'text-delta') {
    state.textDeltas += 1
    if (typeof chunk.text === 'string') appendRepeatWindow(state, chunk.text, config)
  } else if (type === 'tool-call-delta') {
    state.toolCallDeltas += 1
  }
}

/**
 * 判定这次尝试是否已经陷入推理循环。**纯函数**，不碰时间也不碰 IO ——
 * `elapsedMs` 由调用方传入，方便单测直接构造。
 *
 * 五条触发条件（任一命中即触发）：
 * - `chunk`    推理分片 ≥ `reasoningChunkLimit` 且产出为 0
 * - `stall`    距上一个分片（或起始）已过 `stallTimeoutMs`，**一个分片都没来**
 * - `noOutput` 已耗时 ≥ `noOutputMs` 且产出为 0（分片在慢慢来，但一直不出东西）
 * - `repeat`   窗口已满、行数够、唯一行占比够低、且最高频行重复 ≥ `repeatCycles` 次（v0.4）
 * - `absolute` 已耗时 ≥ `attemptBudgetMs`（不看产出）
 *
 * 优先级按上面的顺序：先报最能说明问题的那条。
 *
 * @param {AttemptState} state
 * @param {number} elapsedMs 本次尝试已耗时
 * @param {number} sinceLastChunkMs 距上一个分片（或起始时刻）的毫秒数
 * @param {{reasoningChunkLimit:number, attemptBudgetMs:number, stallTimeoutMs:number, noOutputMs:number,
 *   repeatWindowChars:number, repeatMinLines:number, repeatCycles:number, repeatUniqueRatio:number}} config
 * @returns {{rule:string, message:string, elapsedMs?:number, budgetMs?:number}|null}
 */
function detectTrip(state, elapsedMs, sinceLastChunkMs, config) {
  const productive = productiveDeltasOf(state)
  const limit = config.reasoningChunkLimit
  const stall = config.stallTimeoutMs
  const noOutput = config.noOutputMs
  const budget = config.attemptBudgetMs

  if (state.reasoningDeltas >= limit && productive === 0) {
    return {
      rule: RULE_CHUNK,
      message:
        `检测到推理循环：本次尝试已产出 ${state.reasoningDeltas} 个推理分片（上限 ${limit}）` +
        `、${state.reasoningChars} 字符，但文本/工具调用分片为 0。已中止本次尝试。`,
    }
  }

  if (sinceLastChunkMs >= stall) {
    return {
      rule: RULE_STALL,
      message:
        `检测到流卡死：已连续 ${Math.round(sinceLastChunkMs / 1000)} 秒没有收到任何分片` +
        `（沉默上限 ${Math.round(stall / 1000)} 秒；本次尝试累计 ${Math.round(elapsedMs / 1000)} 秒，` +
        `期间收到 ${state.reasoningDeltas} 个推理分片、${productive} 个产出分片）。已中止本次尝试。`,
    }
  }

  // 渗流：分片一直在慢慢来（所以上面那条不触发），但一直是推理、产出始终为 0。
  if (elapsedMs >= noOutput && productive === 0) {
    return {
      rule: RULE_NO_OUTPUT,
      message:
        `检测到零产出渗流：本次尝试已耗时 ${Math.round(elapsedMs / 1000)} 秒` +
        `（零产出上限 ${Math.round(noOutput / 1000)} 秒），期间收到 ${state.reasoningDeltas} 个推理分片` +
        `（${state.reasoningChars} 字符），但文本/工具调用分片始终为 0。已中止本次尝试。`,
    }
  }

  // 退化重复（v0.4 起）：分片一直在来、也确实在出东西，但出的是同一小段 ——
  // 这是 A/B/C/D 全都不看的一个维度，所以单独一条。
  //
  // 最后一条判据是 `topCount >= repeatCycles`（最高频那一行至少重复了 repeatCycles 次）。
  // 契约修订 2 把它从「行数 ≥ 轮数 × 唯一行数」改过来：后者真漏检 turn 24/1
  // （12,201 字符 / 376 行 / 唯一行占比 32.4% / `Let me go.` × 233）—— 默认配置下
  // 末窗口 312 行 / 60 唯一 / ratio=0.1923 已满足，只有 `312 < 6×60=360` 不满足。
  //
  // **契约修订 5** 把指标从「整窗口径」换成「**多尺度子窗最坏值**」（`seg*`），
  // 并把前置从「窗口必须满 `repeatWindowChars`」换成「至少 `repeatMinChars`」：
  //
  // - **短块缺口**：块长 < 6000 时窗口永远填不满 → 结构上不判。全语料有 7 个真退化短块
  //   （2,029–4,521 字符，同一个 `Let me go.` / `Emit.` 形态）。它们的 k8 是 0.2554–0.3497，
  //   而中文长单行自然散文是 0.3613 —— 只差 1.03×，k-gram 口径下**没有可用分界**；
  //   但它们的行指标极干净（如 `19/8`：2,029 字符 / 179 行 / 唯一行占比 0.0782 / `Emit.` ×80），
  //   所以正解是降低字符门槛让**行判据**看得到它们，不是放松 k-gram 阈值。
  // - **稀释边界**：整窗指标会被前面的正常内容稀释。验证者用例：3,000 正常 + 3,010 重复
  //   → 整窗 k8 0.5080 **完全不触发**；前置 400 高熵 + 5,600 重复 → 0.0907（仅比阈值低 1.10×）。
  //   分段后由恰好落在退化段里的子窗抓到。
  //
  // 全语料实测（340 会话 / 7,982 个 ≥1000 字符的块）：分段行判据(0.2) 命中 216、
  // 分段 k-gram(0.10) 命中 18、并集 **218**，**非退化会话命中 0**；v0.4 的 26 个旧命中
  // 一个不丢。首个误杀出现在阈值 0.30（`top="```"` 的 markdown 围栏块，ratio 0.2574），
  // 所以 0.2 对最近的误杀有 **1.29×** 余量。
  const rep =
    state.repeat === undefined || state.repeat === null
      ? {
          window: '',
          lines: [],
          unique: 0,
          ratio: 1,
          topLine: '',
          topCount: 0,
          gramCount: 0,
          gramRatio: 1,
          segRatio: 1,
          segLines: 0,
          segUnique: 0,
          segTopLine: '',
          segTopCount: 0,
          segGramRatio: 1,
          segGramCount: 0,
          segGramUnique: 0,
        }
      : state.repeat
  // 手工构造的 state（单测常见）可能只带 v0.4 的整窗字段 —— 缺失的分段字段退回整窗值，
  // 这样「老 state」的判定结果与 v0.4 完全一致，不会因为多了一层分段而静默不判。
  const minChars = repeatMinCharsOf(config)
  const segRatio = numberOr(rep, 'segRatio', rep.ratio)
  const segLines = numberOr(rep, 'segLines', Array.isArray(rep.lines) ? rep.lines.length : 0)
  const segUnique = numberOr(rep, 'segUnique', rep.unique)
  const segTopLine = typeof rep.segTopLine === 'string' ? rep.segTopLine : rep.topLine
  const segTopCount = numberOr(rep, 'segTopCount', rep.topCount)
  const segGramRatio = numberOr(rep, 'segGramRatio', rep.gramRatio)
  const segGramCount = numberOr(rep, 'segGramCount', rep.gramCount)
  // 老 state 没有 `segGramUnique`：退回「按唯一率反推」——`round(count × ratio)`，
  // 与真值最多差 1，消息里不会出现比 `segGramCount` 还大的荒谬数字。
  const segGramUnique = numberOr(rep, 'segGramUnique', Math.round(segGramCount * segGramRatio))
  // F7（验证者 task-32）：消息里「最近 W 字符里 N 个片段」两个数**口径不同** ——
  // N/唯一率/unique 都取自**最差子窗**，而 W 是整窗长度（如 1024 窗口里报 125 个片段，
  // 而 125×8=1000 是那个子窗的长度）。这里把 W 换成真正产出这组数字的**子窗尺度**，
  // 三个数字口径就一致了；老 state 没有 `segGramScale` 就退回整窗长度（= v0.4 行为）。
  const segGramScale = numberOr(rep, 'segGramScale', rep.window.length)
  // 行判据（分段口径）：门槛够 + 行数够 + 唯一行占比够低 + 最高频行重复够多。
  const lineTrip =
    rep.window.length >= minChars &&
    segLines >= config.repeatMinLines &&
    segRatio <= config.repeatUniqueRatio &&
    segTopCount >= config.repeatCycles
  // k-gram 兜底（契约修订 3 + 5）：只覆盖「行数不足」的单行/少行退化 ——
  // 单行块的唯一行占比恒等于 1.0，上面那条判据结构上不可能命中（是缺口，不是阈值问题）。
  // 行数判据这里用的仍是**整窗** `lines`：这一档的定位就是「整块几乎只有一行」。
  const gramTrip =
    rep.window.length >= minChars &&
    rep.lines.length < config.repeatMinLines &&
    segGramRatio <= config.repeatGramRatio
  if (lineTrip) {
    return {
      rule: RULE_REPEAT,
      message:
        `检测到输出退化重复：最近 ${rep.window.length} 字符里 ${segLines} 行中只有 ${segUnique} 行不重复` +
        `（唯一行占比 ${(segRatio * 100).toFixed(1)}%，上限 ${(config.repeatUniqueRatio * 100).toFixed(1)}%；` +
        `最高频一行出现 ${segTopCount} 次：${JSON.stringify(segTopLine.slice(0, 40))}）。已中止本次尝试。`,
      elapsedMs,
      budgetMs: budget,
    }
  }
  if (gramTrip) {
    return {
      rule: RULE_REPEAT,
      message:
        `检测到输出退化重复：最近 ${segGramScale} 字符里 ${segGramCount} 个 ${REPEAT_GRAM_CHARS} 字符片段不重复的只有 ${segGramUnique} 个` +
        `（唯一率 ${(segGramRatio * 100).toFixed(1)}%，上限 ${(config.repeatGramRatio * 100).toFixed(1)}%；` +
        `非空行仅 ${rep.lines.length} 行）。已中止本次尝试。`,
      elapsedMs,
      budgetMs: budget,
    }
  }

  if (elapsedMs >= budget) {
    return {
      rule: RULE_ABSOLUTE,
      message:
        `单次尝试已达绝对上限 ${Math.round(budget / 1000)} 秒（已耗时 ${Math.round(elapsedMs / 1000)} 秒），` +
        '无论产出如何都中止。',
    }
  }

  return null
}

/**
 * 降一档推理档位。当前档位不在 `EFFORT_LADDER` 里就返回 null（宁可不降，也不瞎猜）。
 *
 * @param {unknown} current
 * @returns {string|null}
 */
function lowerEffort(current) {
  if (typeof current !== 'string') return null
  const index = EFFORT_LADDER.indexOf(current)
  if (index <= 0) return null // 不在阶梯里，或已经是最低档
  return EFFORT_LADDER[index - 1]
}

// ---------------------------------------------------------------------------
// 守卫流
// ---------------------------------------------------------------------------

/**
 * `nextOrStall` 的「超时了」哨兵值。用 Symbol 而不是 `null` / `undefined`，
 * 免得跟上游真的吐出 `null` 撞车。
 */
const STALL = Symbol('dsh-loop-guard.stall')

/**
 * 让 `iterator.next()` 与一个定时器赛跑。
 *
 * **为什么需要它**：上游一个分片都不吐时（实测最坏用例 —— 3.48 小时卡死里有
 * 1.95 小时 + 1.5 小时的零分片空档），光 `await iterator.next()` 会永远挂着，
 * 永远走不到 `detectTrip`，守卫形同虚设。实测证明 v0.1 就是这样漏掉最坏用例的。
 *
 * 超时返回 `STALL`；上游抛错则把原错误原样抛出去（不吞）。
 * 挂着的那个 `next()` promise 已挂了 `catch`，不会变成 unhandled rejection；
 * 它的收尾由 `guardStream` 的 `finally` 调 `iterator.return()` 负责。
 *
 * @returns {Promise<IteratorResult<unknown>|typeof STALL>}
 */
function nextOrStall(iterator, stallTimeoutMs) {
  let timer
  const timeout = new Promise((settle) => {
    // **故意不 unref()**：这个定时器存在的唯一理由，就是在「宿主里其它什么都没在动」
    // 的时候还能醒过来。unref 掉的定时器在没有别的活干时不会阻止事件循环退出，
    // 正好会在我们要防的那个场景里失效（实测：单测里直接变成 unsettled top-level await）。
    // 定时器在每条路径上都会被 clearTimeout 清掉（拿到分片 / 超时 / 上游抛错），
    // 所以不存在「拖着宿主不退」的问题。
    timer = setTimeout(() => settle(STALL), stallTimeoutMs)
  })
  const settled = Promise.resolve()
    .then(() => iterator.next())
    .then(
      (step) => ({ ok: true, step }),
      (error) => ({ ok: false, error }),
    )
  return Promise.race([settled, timeout]).then(
    (winner) => {
      clearTimeout(timer)
      if (winner === STALL) return STALL
      if (winner.ok === false) throw winner.error
      return winner.step
    },
    (error) => {
      clearTimeout(timer)
      throw error
    },
  )
}

/**
 * 包住上游流。**触发前的每个块原样透传**（同一个对象引用，不改写、不丢弃、不重排）；
 * 触发时停止向上游取值，补一个终结块。
 *
 * `finally` 里一定调用上游 iterator 的 `return()` —— 提前 return（触发）时它负责关连接。
 * 注意实测结论：上游彻底卡住时 `return()` **未必**能打断那个挂着的 `next()`
 * （依赖适配器实现），所以它只保证「尽力收尾」，不保证「一定解开」；
 * 真正保证的是**下游不会再被吊住** —— 我们已经在超时时吐了终结块并结束了自己的 generator。
 *
 * @param {AsyncIterable<unknown>} upstream
 * @param {{reasoningChunkLimit:number, attemptBudgetMs:number, stallTimeoutMs:number, noOutputMs:number,
 *   repeatWindowChars:number, repeatMinLines:number, repeatCycles:number, repeatUniqueRatio:number}} config
 * @param {(trip:object)=>void} onTrip
 * @param {()=>number} now 取当前时间（单测可注入）
 * @returns {AsyncGenerator<unknown>}
 */
async function* guardStream(upstream, config, onTrip, now) {
  const started = now()
  const state = createAttemptState()
  const iterator = upstream[Symbol.asyncIterator]()
  /** 上一个分片到达的时刻；起始时等于 `started`（所以首块之前也受 stall 保护）。 */
  let lastChunkAt = started
  try {
    for (;;) {
      const step = await nextOrStall(iterator, config.stallTimeoutMs)

      if (step === STALL) {
        const elapsedMs = now() - started
        // 定时器已经证明「至少过了 stallTimeoutMs」，所以取两者较大值 ——
        // 注入的假时钟或粗粒度时钟不会把这条判定压低到阈值以下。
        const sinceLastChunkMs = Math.max(now() - lastChunkAt, config.stallTimeoutMs)
        const trip = detectTrip(state, elapsedMs, sinceLastChunkMs, config)
        const settled =
          trip === null
            ? { rule: RULE_STALL, message: `检测到流卡死：已连续 ${Math.round(sinceLastChunkMs / 1000)} 秒没有收到任何分片。已中止本次尝试。` }
            : trip
        onTrip({
          rule: settled.rule,
          message: settled.message,
          reasoningDeltas: state.reasoningDeltas,
          reasoningChars: state.reasoningChars,
          textDeltas: state.textDeltas,
          toolCallDeltas: state.toolCallDeltas,
          productiveDeltas: productiveDeltasOf(state),
          elapsedMs,
          sinceLastChunkMs,
        })
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { code: LOOP_GUARD_CODE, message: settled.message } },
        }
        return
      }

      if (step.done === true) {
        // 上游正常结束：**补算一次再判 repeat**。
        //
        // 为什么需要：节流让 `repeat` 指标最多滞后一个节流间隔（默认 256 字符），所以
        // 「窗口刚满」和「流尾那一小段」可能整次都没被求值过 —— 验证者 task-32 复验里
        // 8 条断言转红就是这件事（E 样本在窗口 5888 时 `segGramRatio = 0.1040` 不触发、
        // 在 6000 时 `0.0540` 触发，而流恰好在 6000 前结束就整次漏判）。
        //
        // 为什么安全：`stall` / `noOutput` / `absolute` **不依赖 `recomputeRepeat`** 的任何字段
        // （它们只看 `productiveDeltas`、`elapsedMs`、`sinceLastChunkMs`），而且它们在每个分片
        // 之后的 `detectTrip` 里**已经判过**。所以这里只接受 `repeat` 规则的结果 ——
        // 不重复判那三条，避免在「恰好结束于 noOutputMs 边界」这类正常流上凭空多出误判。
        recomputeRepeat(state, config)
        const endTrip = detectTrip(state, now() - started, now() - lastChunkAt, config)
        if (endTrip !== null && endTrip.rule === RULE_REPEAT) {
          onTrip({
            rule: endTrip.rule,
            message: endTrip.message,
            reasoningDeltas: state.reasoningDeltas,
            reasoningChars: state.reasoningChars,
            textDeltas: state.textDeltas,
            toolCallDeltas: state.toolCallDeltas,
            productiveDeltas: productiveDeltasOf(state),
            elapsedMs: now() - started,
          })
          yield {
            type: 'finish',
            reason: { kind: 'error', failure: { code: LOOP_GUARD_CODE, message: endTrip.message } },
          }
        }
        return
      }
      const chunk = step.value

      lastChunkAt = now()
      countChunk(state, chunk, config)
      // 先透传，再判定：这样「触发前已到达的块」对下游是完全可见的。
      yield chunk

      // 上游自己终结了 —— 不能再补第二个 finish 块。
      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'finish') return

      const elapsedMs = now() - started
      const trip = detectTrip(state, elapsedMs, now() - lastChunkAt, config)
      if (trip !== null) {
        onTrip({
          rule: trip.rule,
          message: trip.message,
          reasoningDeltas: state.reasoningDeltas,
          reasoningChars: state.reasoningChars,
          textDeltas: state.textDeltas,
          toolCallDeltas: state.toolCallDeltas,
          productiveDeltas: productiveDeltasOf(state),
          elapsedMs,
        })
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { code: LOOP_GUARD_CODE, message: trip.message } },
        }
        return
      }
    }
  } finally {
    // 提前 return（触发）或正常结束都要走到这里。上游可能没有 return()。
    if (iterator !== null && typeof iterator.return === 'function') {
      try {
        await iterator.return()
      } catch {
        /* 关连接失败不影响已经吐给下游的内容 */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

/** 新建统计容器。 */
function createStats(maxRecent) {
  return {
    maxRecent,
    attempts: 0,
    guarded: 0,
    retriesAllowed: 0,
    terminalStops: 0,
    /** 「省下的时间」：每次触发时，按「这次尝试本来还会跑到 attemptBudgetMs」估算的差值之和。 */
    savedMs: 0,
    recent: [],
    byRule: { [RULE_CHUNK]: 0, [RULE_STALL]: 0, [RULE_NO_OUTPUT]: 0, [RULE_REPEAT]: 0, [RULE_ABSOLUTE]: 0 },
  }
}

/**
 * 记一次触发。
 *
 * `budgetMs` / `elapsedMs` 缺失或不是有限数字时按 0 计 —— 不传它们时
 * `NaN - NaN = NaN` 会让 `savedMs` 变成 NaN，序列化成 JSON 就是 `null`。
 * 线上调用点总是补了 `budgetMs`，但 `internals` 是公开给单测/排障直调的。
 */
function recordTrip(stats, trip) {
  stats.guarded += 1
  if (Object.hasOwn(stats.byRule, trip.rule)) stats.byRule[trip.rule] += 1
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  // 估算省下的时间：这次尝试如果不掐断，最少还会跑到 attemptBudgetMs。
  // 绝对上限那条规则已经跑满甚至超过预算了，按 0 计（不虚报）。
  const remaining = trip.rule === RULE_ABSOLUTE ? 0 : Math.max(0, num(trip.budgetMs) - num(trip.elapsedMs))
  stats.savedMs += remaining
  stats.recent.unshift(trip)
  if (stats.recent.length > stats.maxRecent) stats.recent.length = stats.maxRecent
}

/** 统计快照（去掉内部字段）。 */
function statsSnapshot(stats) {
  return {
    attempts: stats.attempts,
    guarded: stats.guarded,
    retriesAllowed: stats.retriesAllowed,
    terminalStops: stats.terminalStops,
    savedMs: stats.savedMs,
    byRule: { ...stats.byRule },
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** 发 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 读请求体，带大小上限。超限时把余下 body 排空丢掉，保持连接可用。
 *
 * @returns {Promise<{ok:true, text:string}|{ok:false, code:string, message:string, status:number}>}
 */
function readBody(req) {
  return new Promise((settle) => {
    const chunks = []
    let size = 0
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > MAX_BODY) {
        done = true
        req.resume()
        settle({
          ok: false,
          code: 'body-too-large',
          message: `请求体超过 ${MAX_BODY} 字节上限`,
          status: 413,
        })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      settle({ ok: true, text: Buffer.concat(chunks).toString('utf8') })
    })
    req.on('error', (error) => {
      if (done) return
      done = true
      settle({ ok: false, code: 'body-read-failed', message: String(error && error.message), status: 400 })
    })
  })
}

/** 解析 Origin 的 host；非法 / 空 → null。 */
function originHostOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = new URL(value)
    return parsed.host === '' ? null : parsed.host.toLowerCase()
  } catch {
    return null
  }
}

/** 服务端自己的 host：优先 `webServer.getOrigin()`，退化到本次请求的 `Host` 头。 */
function selfHostOf(services, req) {
  const webServer = services === null || services === undefined ? undefined : services.webServer
  if (webServer !== null && webServer !== undefined && typeof webServer.getOrigin === 'function') {
    try {
      const origin = webServer.getOrigin()
      const text =
        typeof origin === 'string' ? origin : origin === null || origin === undefined ? '' : origin.origin
      const host = originHostOf(text)
      if (host !== null) return host
    } catch {
      /* 软依赖：拿不到就退化到 Host 头 */
    }
  }
  const headers =
    req === null || req === undefined || req.headers === null || req.headers === undefined ? {} : req.headers
  const header = headers.host
  return typeof header === 'string' && header !== '' ? header.toLowerCase() : null
}

/** host 是否同源可比：完全相同，或都是 loopback 别名且端口相同。 */
function sameHost(a, b) {
  if (a === null || b === null) return false
  if (a === b) return true
  const split = (value) => {
    const index = value.lastIndexOf(':')
    return index < 0 ? { name: value, port: '' } : { name: value.slice(0, index), port: value.slice(index + 1) }
  }
  const left = split(a)
  const right = split(b)
  const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  return left.port === right.port && loopback.has(left.name) && loopback.has(right.name)
}

/**
 * 跨站防护：`/loop-guard` 前缀下**所有**路径统一过一遍。
 *
 * DSH 的 webServer 契约是 `{kind, path, handler}`，**没有全局 Origin/CSRF 防护**，
 * 插件路由也不在 GUI 的登录门后面（裸 curl 就能打）。任意网页都能用
 * `content-type: text/plain` 发跨站简单请求打到这里并让服务端真的执行。
 *
 * 三道闸（与 dsh-bug-reporter 同款）：
 * 1. `Sec-Fetch-Site: cross-site` → 403 `cross-site`
 * 2. `Origin` 存在时必须同源，否则 403 `bad-origin`；**Origin 缺失时放行**（curl 要能用）
 * 3. `POST` 必须 `content-type: application/json` → 否则 415 `unsupported-media-type`
 *
 * @returns {boolean} true = 已经回过响应，调用方直接 return。
 */
function rejectCrossSite(req, res, services, method) {
  const headers =
    req === null || req === undefined || req.headers === null || req.headers === undefined ? {} : req.headers

  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site.trim().toLowerCase() === 'cross-site') {
    sendJson(res, 403, {
      ok: false,
      error: { code: 'cross-site', message: '拒绝跨站请求（Sec-Fetch-Site: cross-site）' },
    })
    return true
  }

  const origin = headers.origin
  if (typeof origin === 'string' && origin.trim() !== '') {
    const got = originHostOf(origin)
    const want = selfHostOf(services, req)
    if (!sameHost(got, want)) {
      sendJson(res, 403, {
        ok: false,
        error: { code: 'bad-origin', message: `拒绝来源 ${origin}：与本机不同源` },
      })
      return true
    }
  }

  if (method === 'POST') {
    const raw = headers['content-type']
    const base = typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : ''
    if (base !== 'application/json') {
      sendJson(res, 415, {
        ok: false,
        error: { code: 'unsupported-media-type', message: 'POST 必须使用 content-type: application/json' },
      })
      return true
    }
  }

  return false
}

/**
 * 校验界面提交的配置补丁。只认 `PERSISTED_KEYS`，逐键查类型与范围。
 *
 * @returns {{ok:true, patch:object}|{ok:false, code:string, message:string}}
 */
function validatePatch(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'bad-body', message: 'body 必须是一个 JSON 对象' }
  }
  const patch = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!PERSISTED_KEYS.has(key)) {
      return {
        ok: false,
        code: 'unknown-key',
        message: `未知的配置键 "${key}"（可改：${[...PERSISTED_KEYS].join(', ')}）`,
      }
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') return { ok: false, code: 'bad-type', message: `${key} 必须是 boolean` }
      patch[key] = value
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, code: 'bad-type', message: `${key} 必须是有限数字` }
    }
    if (key === 'reasoningChunkLimit') {
      if (!Number.isInteger(value) || value < MIN_CHUNK_LIMIT) {
        return { ok: false, code: 'bad-range', message: `${key} 必须是 >= ${MIN_CHUNK_LIMIT} 的整数` }
      }
    }
    if (key === 'attemptBudgetMs') {
      if (!Number.isInteger(value) || value < MIN_ATTEMPT_BUDGET_MS) {
        return { ok: false, code: 'bad-range', message: `${key} 必须是 >= ${MIN_ATTEMPT_BUDGET_MS} 的整数` }
      }
    }
    if (key === 'stallTimeoutMs') {
      if (!Number.isInteger(value) || value < MIN_STALL_TIMEOUT_MS) {
        return { ok: false, code: 'bad-range', message: `${key} 必须是 >= ${MIN_STALL_TIMEOUT_MS} 的整数` }
      }
    }
    if (key === 'noOutputMs') {
      if (!Number.isInteger(value) || value < MIN_NO_OUTPUT_MS) {
        return { ok: false, code: 'bad-range', message: `${key} 必须是 >= ${MIN_NO_OUTPUT_MS} 的整数` }
      }
    }
    if (key === 'repeatWindowChars') {
      if (!Number.isInteger(value) || value < MIN_REPEAT_WINDOW_CHARS || value > MAX_REPEAT_WINDOW_CHARS) {
        return {
          ok: false,
          code: 'bad-range',
          message: `${key} 必须是 ${MIN_REPEAT_WINDOW_CHARS}..${MAX_REPEAT_WINDOW_CHARS} 的整数`,
        }
      }
    }
    if (key === 'repeatMinChars') {
      if (!Number.isInteger(value) || value < REPEAT_SEG_MIN_CHARS || value > MAX_REPEAT_WINDOW_CHARS) {
        return {
          ok: false,
          code: 'bad-range',
          message: `${key} 必须是 ${REPEAT_SEG_MIN_CHARS}..${MAX_REPEAT_WINDOW_CHARS} 的整数`,
        }
      }
    }
    if (key === 'repeatMinLines') {
      if (!Number.isInteger(value) || value < MIN_REPEAT_MIN_LINES || value > MAX_REPEAT_MIN_LINES) {
        return {
          ok: false,
          code: 'bad-range',
          message: `${key} 必须是 ${MIN_REPEAT_MIN_LINES}..${MAX_REPEAT_MIN_LINES} 的整数`,
        }
      }
    }
    if (key === 'repeatCycles') {
      if (!Number.isInteger(value) || value < MIN_REPEAT_CYCLES || value > MAX_REPEAT_CYCLES) {
        return {
          ok: false,
          code: 'bad-range',
          message: `${key} 必须是 ${MIN_REPEAT_CYCLES}..${MAX_REPEAT_CYCLES} 的整数`,
        }
      }
    }
    if (key === 'repeatUniqueRatio') {
      if (value < MIN_REPEAT_UNIQUE_RATIO || value > MAX_REPEAT_UNIQUE_RATIO) {
        return {
          ok: false,
          code: 'bad-range',
          message: `${key} 必须是 ${MIN_REPEAT_UNIQUE_RATIO}..${MAX_REPEAT_UNIQUE_RATIO} 的数字`,
        }
      }
    }
    if (key === 'repeatGramRatio') {
      if (value < MIN_REPEAT_GRAM_RATIO || value > MAX_REPEAT_GRAM_RATIO) {
        return {
          ok: false,
          code: 'bad-range',
          message: `${key} 必须是 ${MIN_REPEAT_GRAM_RATIO}..${MAX_REPEAT_GRAM_RATIO} 的数字`,
        }
      }
    }
    if (key === 'maxGuardedRetries') {
      if (!Number.isInteger(value) || value < 0 || value > MAX_GUARDED_RETRIES) {
        return { ok: false, code: 'bad-range', message: `${key} 必须是 0..${MAX_GUARDED_RETRIES} 的整数` }
      }
    }
    patch[key] = value
  }
  return { ok: true, patch }
}

/** 造 HTTP handler。`settings` 是活的配置对象，就地改。`ctx` 只用来记日志。 */
function createHttpHandler(ctx, settings, stats, services) {
  return async function handle(req, res) {
    let pathname
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'bad-url', message: '无法解析请求 URL' } })
      return
    }

    const method = req.method === undefined ? 'GET' : req.method.toUpperCase()
    if (rejectCrossSite(req, res, services, method)) return

    if (method === 'GET' && pathname === `${ROUTE_PREFIX}/state`) {
      sendJson(res, 200, {
        ok: true,
        value: {
          enabled: settings.enabled,
          config: {
            reasoningChunkLimit: settings.reasoningChunkLimit,
            attemptBudgetMs: settings.attemptBudgetMs,
            stallTimeoutMs: settings.stallTimeoutMs,
            noOutputMs: settings.noOutputMs,
            repeatWindowChars: settings.repeatWindowChars,
            repeatMinChars: settings.repeatMinChars,
            repeatMinLines: settings.repeatMinLines,
            repeatCycles: settings.repeatCycles,
            repeatUniqueRatio: settings.repeatUniqueRatio,
            repeatGramRatio: settings.repeatGramRatio,
            maxGuardedRetries: settings.maxGuardedRetries,
            lowerEffortOnRetry: settings.lowerEffortOnRetry,
          },
          stats: statsSnapshot(stats),
          recent: stats.recent.map((entry) => ({ ...entry })),
        },
      })
      return
    }

    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/config`) {
      const body = await readBody(req)
      if (!body.ok) {
        sendJson(res, body.status, { ok: false, error: { code: body.code, message: body.message } })
        return
      }
      let parsed
      try {
        parsed = body.text.trim() === '' ? {} : JSON.parse(body.text)
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: { code: 'bad-json', message: `body 不是合法 JSON：${error.message}` },
        })
        return
      }
      const checked = validatePatch(parsed)
      if (!checked.ok) {
        sendJson(res, 400, { ok: false, error: { code: checked.code, message: checked.message } })
        return
      }
      // 跨字段不变量：门槛不能超过窗口。单键校验看不到另一键的现值，
      // 所以必须拿**合并后**的值再查一次（例如只提交 repeatMinChars=5000 而窗口仍是 4000）。
      const mergedMinChars = Object.hasOwn(checked.patch, 'repeatMinChars')
        ? checked.patch.repeatMinChars
        : settings.repeatMinChars
      const mergedWindowChars = Object.hasOwn(checked.patch, 'repeatWindowChars')
        ? checked.patch.repeatWindowChars
        : settings.repeatWindowChars
      if (mergedMinChars > mergedWindowChars) {
        sendJson(res, 400, {
          ok: false,
          error: {
            code: 'bad-range',
            message: `repeatMinChars (${mergedMinChars}) 不能大于 repeatWindowChars (${mergedWindowChars})`,
          },
        })
        return
      }
      Object.assign(settings, checked.patch)
      saveSettings(ctx, settings)
      sendJson(res, 200, {
        ok: true,
        value: {
          config: {
            reasoningChunkLimit: settings.reasoningChunkLimit,
            attemptBudgetMs: settings.attemptBudgetMs,
            stallTimeoutMs: settings.stallTimeoutMs,
            noOutputMs: settings.noOutputMs,
            repeatWindowChars: settings.repeatWindowChars,
            repeatMinChars: settings.repeatMinChars,
            repeatMinLines: settings.repeatMinLines,
            repeatCycles: settings.repeatCycles,
            repeatUniqueRatio: settings.repeatUniqueRatio,
            repeatGramRatio: settings.repeatGramRatio,
            maxGuardedRetries: settings.maxGuardedRetries,
            lowerEffortOnRetry: settings.lowerEffortOnRetry,
          },
        },
      })
      return
    }

    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/reset`) {
      const body = await readBody(req)
      if (!body.ok) {
        sendJson(res, body.status, { ok: false, error: { code: body.code, message: body.message } })
        return
      }
      stats.attempts = 0
      stats.guarded = 0
      stats.retriesAllowed = 0
      stats.terminalStops = 0
      stats.savedMs = 0
      stats.byRule = { [RULE_CHUNK]: 0, [RULE_STALL]: 0, [RULE_NO_OUTPUT]: 0, [RULE_REPEAT]: 0, [RULE_ABSOLUTE]: 0 }
      stats.recent.length = 0
      sendJson(res, 200, { ok: true, value: { stats: statsSnapshot(stats) } })
      return
    }

    // 路径存在但方法不对 → 405（不是 404），并按 HTTP 要求给出 Allow。
    if (pathname === `${ROUTE_PREFIX}/state`) {
      res.setHeader('allow', 'GET')
      sendJson(res, 405, {
        ok: false,
        error: { code: 'method-not-allowed', message: `${pathname} 只支持 GET，收到 ${method}` },
      })
      return
    }
    if (pathname === `${ROUTE_PREFIX}/config` || pathname === `${ROUTE_PREFIX}/reset`) {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, {
        ok: false,
        error: { code: 'method-not-allowed', message: `${pathname} 只支持 POST，收到 ${method}` },
      })
      return
    }

    sendJson(res, 404, {
      ok: false,
      error: { code: 'not-found', message: `没有这个端点：${method} ${pathname}` },
    })
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * 挂载插件。
 *
 * @param {object} ctx cordis 上下文
 * @param {unknown} rawConfig 插件配置（见 DEFAULTS）
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  // yml 的值作底，持久化文件覆盖 —— 这就是「界面上改的能被记住」的全部含义。
  const persisted = loadPersistedSettings(ctx, config)
  const settings = { ...config, ...persisted }
  // 持久化文件只该覆盖「界面能改的键」；这里再校验一遍，坏值退回 yml。
  //
  // 两条容易踩的坑：
  // 1) 这里**必须吞掉异常**：`resolveConfig` 对越界值、非整数会抛错，漏出去就是整个插件
  //    挂载失败 —— 而挂载失败的后果是**设置页也打不开**，用户没有任何界面手段自救
  //    （只能手改/删掉设置文件）。设置文件是外部输入（用户手改、跨版本降级都会碰到），
  //    所以「坏值退回 yml + 告警」才是对的语义。同一道理见下面跨字段那一处。
  // 2) 逐键校验时基准里的 `repeatWindowChars` 必须放到**上限**，否则 `resolveConfig` 末尾那条
  //    跨字段检查会拿**默认窗口 6000** 去卡门槛：yml 把窗口调大（例如 30000）、用户再从设置页
  //    把门槛设成 20000（界面按**生效**配置校验 → 接受并落盘），重启后就会被判非法、
  //    悄悄退回 yml 的 1000 —— 界面刚接受的值自己消失了。跨字段不变量属于「合并后」的检查，
  //    下面那段夹紧才是它的归宿（也只该在那里判一次）。
  for (const key of PERSISTED_KEYS) {
    if (!Object.hasOwn(persisted, key)) continue
    try {
      const single = resolveConfig({
        ...defaultsCopy(),
        repeatWindowChars: MAX_REPEAT_WINDOW_CHARS,
        [key]: persisted[key],
      })
      settings[key] = single[key]
    } catch (error) {
      // 注意：上面 `{ ...config, ...persisted }` 已经把**坏值**写进 settings 了，
      // 所以这里**必须显式回写** yml 的值 —— 只告警不还原 = 坏值照样生效（作者单测 14.1 抓过这个）。
      settings[key] = config[key]
      const detail = (error instanceof Error ? error.message : String(error)).replace(
        /^dsh-loop-guard:\s*/,
        '',
      )
      warn(ctx, new Error(`设置文件里的 ${key} 不合法，已退回 yml 的值：${detail}`))
    }
  }
  // 跨字段不变量：门槛不能超过窗口。持久化文件是**逐键**校验的，合起来仍可能越界
  // （例如窗口存成 500、门槛存成 1000），所以合并后再夹一次。
  // 这里**夹紧并告警**而不是抛错：抛错会让整个插件加载失败，用户连设置页都打不开。
  if (settings.repeatMinChars > settings.repeatWindowChars) {
    warn(
      ctx,
      new Error(
        `repeatMinChars (${settings.repeatMinChars}) 大于 repeatWindowChars (${settings.repeatWindowChars})，已夹紧到窗口大小`,
      ),
    )
    settings.repeatMinChars = settings.repeatWindowChars
  }

  const stats = createStats(settings.maxRecent)
  const services = { webServer: undefined }

  /** 每个 agent 最近一次循环触发的时间 —— 用来决定下一次请求是否降档。 */
  const lastTripAt = new WeakMap()
  /** 每个 agent 每个 turn/step 已经触发过几次 —— 用来决定还允不允许重试。 */
  const tripCounts = new WeakMap()

  if (!settings.enabled) {
    // 总开关关着：一个监听都不装。设置页仍然可用（否则没法再打开）。
    installHttp(ctx, settings, stats, services)
    internals.active = { settings, stats, services, lastTripAt, tripCounts, enabled: false }
    return
  }

  /**
   * 1) 守卫流。
   *
   * `llm/stream` 是 waterfall，签名 `(this: LlmRuntime, options, next)`。
   * `next()` 返回上游 AsyncIterable；我们返回自己的 generator 把它包住。
   * 官方注释明说：call next() to reach the resolved adapter's stream,
   * **or yield your own chunks to short-circuit** —— 这正是这里在做的事。
   */
  ctx.on('llm/stream', (options, next) => {
    if (!settings.enabled) return next()
    const upstream = next()
    if (upstream === null || upstream === undefined || typeof upstream[Symbol.asyncIterator] !== 'function') {
      return upstream
    }
    stats.attempts += 1
    const sessionId =
      options !== null && typeof options === 'object' && typeof options.sessionId === 'string'
        ? options.sessionId
        : ''
    return guardStream(
      upstream,
      {
        reasoningChunkLimit: settings.reasoningChunkLimit,
        attemptBudgetMs: settings.attemptBudgetMs,
        stallTimeoutMs: settings.stallTimeoutMs,
        noOutputMs: settings.noOutputMs,
        repeatWindowChars: settings.repeatWindowChars,
        repeatMinChars: settings.repeatMinChars,
        repeatMinLines: settings.repeatMinLines,
        repeatCycles: settings.repeatCycles,
        repeatUniqueRatio: settings.repeatUniqueRatio,
        repeatGramRatio: settings.repeatGramRatio,
      },
      (trip) => {
        recordTrip(stats, { ...trip, budgetMs: settings.attemptBudgetMs, at: Date.now(), sessionId, turn: 0, step: 0 })
        if (settings.debug) warn(ctx, new Error(`拦截推理循环（${trip.rule}）：${trip.message}`))
      },
      () => Date.now(),
    )
  })

  /**
   * 2) 止住重试风暴。
   *
   * 只认自己产的 `LOOP_GUARD`：其它任何失败码一律 `next()` 委托给默认策略，
   * 绝不干预真实网络故障的重试。
   *
   * 返回 `{kind:'retry'}` 且不调 next() = 自己接管恢复；返回 `undefined` = 该失败终结。
   */
  ctx.on('agent/request-error', async (payload, next) => {
    if (!settings.enabled) return next()
    const failure = payload === null || payload === undefined ? undefined : payload.failure
    const code = failure === null || failure === undefined ? undefined : failure.code
    if (code !== LOOP_GUARD_CODE) return next()

    const agent = payload.agent
    const key = `${payload.turn}:${payload.step}`
    let perAgent = tripCounts.get(agent)
    if (perAgent === undefined) {
      perAgent = new Map()
      tripCounts.set(agent, perAgent)
    }
    const seen = (perAgent.get(key) ?? 0) + 1
    perAgent.set(key, seen)
    lastTripAt.set(agent, Date.now())

    if (seen <= settings.maxGuardedRetries) {
      stats.retriesAllowed += 1
      return { kind: 'retry' }
    }
    stats.terminalStops += 1
    return undefined
  })

  /**
   * 3) 纠正重试时降一档推理档位。
   *
   * 注意：`agent/request` 的说明是「On step admission, this runs after assembly and
   * step/start」—— 即它在**步入时**跑，未必为同一步内的每次重试再跑一次。
   * 所以这里按「这个 agent 最近 120 秒内循环过」来判，覆盖「重试」和「下一步」两种情况。
   * 档位不在 `EFFORT_LADDER` 里时是空操作（例如 `pi/tier-std` 不广告任何档位）。
   */
  ctx.on('agent/request', async (payload, next) => {
    const current = await next()
    if (!settings.enabled || !settings.lowerEffortOnRetry) return current
    const agent = payload === null || payload === undefined ? undefined : payload.agent
    const at = lastTripAt.get(agent)
    if (at === undefined || Date.now() - at > EFFORT_WINDOW_MS) return current
    if (current === null || typeof current !== 'object') return current
    const lowered = lowerEffort(current.reasoningEffort)
    if (lowered === null) return current
    if (settings.debug) {
      warn(ctx, new Error(`纠正重试：reasoningEffort ${String(current.reasoningEffort)} → ${lowered}`))
    }
    return { ...current, reasoningEffort: lowered }
  })

  installHttp(ctx, settings, stats, services)
  internals.active = { settings, stats, services, lastTripAt, tripCounts, enabled: true }
}

/** 装 HTTP 路由。`webServer` 是软依赖，缺了只是没有设置页。 */
function installHttp(ctx, settings, stats, services) {
  ctx.inject(['webServer'], (scoped) => {
    services.webServer = scoped.webServer
    const handler = createHttpHandler(ctx, settings, stats, services)
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'dsh-loop-guard: /loop-guard 路由',
    )
  })
}

/**
 * 内部句柄。宿主 Loader 只用 `apply`；这里是给单测与排障用的。
 */
export const internals = {
  resolveConfig,
  DEFAULTS,
  ROUTE_PREFIX,
  LOOP_GUARD_CODE,
  EFFORT_LADDER,
  RULE_CHUNK,
  RULE_STALL,
  RULE_NO_OUTPUT,
  RULE_REPEAT,
  RULE_ABSOLUTE,
  STALL,
  nextOrStall,
  MIN_CHUNK_LIMIT,
  MIN_ATTEMPT_BUDGET_MS,
  MIN_STALL_TIMEOUT_MS,
  MIN_NO_OUTPUT_MS,
  MAX_GUARDED_RETRIES,
  MIN_REPEAT_WINDOW_CHARS,
  MAX_REPEAT_WINDOW_CHARS,
  MIN_REPEAT_MIN_LINES,
  MAX_REPEAT_MIN_LINES,
  MIN_REPEAT_CYCLES,
  MAX_REPEAT_CYCLES,
  MIN_REPEAT_UNIQUE_RATIO,
  MAX_REPEAT_UNIQUE_RATIO,
  REPEAT_GRAM_CHARS,
  MIN_REPEAT_GRAM_RATIO,
  MAX_REPEAT_GRAM_RATIO,
  REPEAT_SEG_MIN_CHARS,
  PERSISTED_KEYS,
  createAttemptState,
  countChunk,
  productiveDeltasOf,
  detectTrip,
  repeatMinCharsOf,
  segWindows,
  gramRatioOf,
  recomputeRepeat,
  lowerEffort,
  guardStream,
  createStats,
  recordTrip,
  statsSnapshot,
  validatePatch,
  createHttpHandler,
  resolveSettingsPath,
  loadPersistedSettings,
  persistedShape,
  /** 最近一次 apply 的内部状态；没有 apply 过就是 null。 */
  active: null,
}
