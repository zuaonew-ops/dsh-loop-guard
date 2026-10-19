/**
 * dsh-loop-guard — 浏览器半区（设置页）。
 *
 * 在「设置」左侧导航里注册一页（slot `settings.section`），用来开关推理循环守卫、
 * 调整十个阈值、看实时统计与最近触发记录。数据全部由宿主半区通过 `/loop-guard/*`
 * 提供，本文件只做读写与渲染。
 *
 * 形态说明：手写浏览器模块，走 `window.__ModuleLoader__.load` 的惰性工厂协议，
 * `react` 从浏览器模块表里 `require`。没有构建步骤，因此不用 JSX，全部用
 * `React.createElement`（别名 `h`）。主题色只用已核实的 `--dsw-alias-*` token。
 *
 * @module dsh-loop-guard/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-loop-guard',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 宿主半区冻结的三个端点；统一 `{ok:true, value}` / `{ok:false, error:{code, message}}`。 */
    const ROUTE = {
      state: '/loop-guard/state',
      config: '/loop-guard/config',
      reset: '/loop-guard/reset',
    }

    /** 轮询间隔（任务要求 ≥ 5s）。 */
    const POLL_MS = 5000

    /** 十个数值阈值的本地边界，与宿主半区的拒绝边界一致。 */
    const LIMIT_MIN = 100
    const BUDGET_MS_MIN = 10000
    const STALL_SEC_MIN = 10
    const NO_OUTPUT_SEC_MIN = 10
    const RETRIES_MAX = 5
    const REPEAT_WINDOW_MIN = 1000
    const REPEAT_WINDOW_MAX = 200000
    /** 最低字符门槛的下限（契约 §3.1 `REPEAT_SEG_MIN_CHARS`）；上限运行时取 `repeatWindowChars`，不是常数。 */
    const REPEAT_SEG_MIN_CHARS = 500
    const REPEAT_MIN_LINES_MIN = 5
    const REPEAT_MIN_LINES_MAX = 5000
    const REPEAT_CYCLES_MIN = 2
    const REPEAT_CYCLES_MAX = 100
    const REPEAT_RATIO_MIN = 0.01
    const REPEAT_RATIO_MAX = 0.9
    const REPEAT_GRAM_RATIO_MIN = 0.01
    const REPEAT_GRAM_RATIO_MAX = 0.9

    /** `stats.byRule` 的五个键，顺序与宿主半区一致（chunk > stall > noOutput > repeat > absolute）。 */
    const RULE_ORDER = ['chunk', 'stall', 'noOutput', 'repeat', 'absolute']

    /** 规则键 → DICT 里的规则名键。 */
    const RULE_LABEL_KEY = {
      chunk: 'ui.loopGuard.ruleChunk',
      stall: 'ui.loopGuard.ruleStall',
      noOutput: 'ui.loopGuard.ruleNoOutput',
      repeat: 'ui.loopGuard.ruleRepeat',
      absolute: 'ui.loopGuard.ruleAbsolute',
    }

    /**
     * 文案。键名与 `locale/zh.json` / `locale/en.json` 里的 `ui.loopGuard.*` 一一对应
     * （与 dsh-bug-reporter 一致：客户端不读 JSON，自带一份同键名的 DICT）。
     * 带函数的值按参数调用。
     */
    const DICT = {
      zh: {
        'ui.loopGuard.nav': '循环守卫',
        'ui.loopGuard.title': '循环守卫',
        'ui.loopGuard.intro':
          '模型陷入推理循环时，宿主会把同一次确定性失败反复重试（每次 1–5 分钟）。守卫检测到循环后提前掐断这一次尝试，并终止后续重试。',
        'ui.loopGuard.enable': '开启守卫',
        'ui.loopGuard.enableHint': '关掉后完全不干预：一次尝试也不会被掐断。',
        'ui.loopGuard.stateOn': '已开启',
        'ui.loopGuard.stateOff': '已关闭',
        'ui.loopGuard.thresholds': '阈值',
        'ui.loopGuard.thresholdsHint': '改完点「保存」才生效；非法值只在本页提示，不会发请求。',
        'ui.loopGuard.limit': '推理分片上限',
        'ui.loopGuard.limitHint': '一次尝试里连续推理分片超过这个数就判为循环（整数 ≥ 100）。',
        'ui.loopGuard.budget': '单次尝试时间上限',
        'ui.loopGuard.budgetHint': '按秒填写（≥ 10 秒）；宿主内部按毫秒记。',
        'ui.loopGuard.budgetUnit': '秒',
        'ui.loopGuard.stall': '零分片沉默上限',
        'ui.loopGuard.stallHint': '连续这么久没有收到任何分片就判定卡死（首块之前也算）。默认 180 秒',
        'ui.loopGuard.noOutput': '零产出渗流上限',
        'ui.loopGuard.noOutputHint': '分片在慢慢来、但一直不出文本或工具调用，累计到这么久就判定循环。默认 600 秒。这是五条规则里最可能误杀的一条，正常的超长思考也会「产出为 0」',
        'ui.loopGuard.repeatWindow': '重复检测窗口',
        'ui.loopGuard.repeatWindowHint': '只在最近这么多字符里找重复（整数 1000–200000）。默认 6000',
        'ui.loopGuard.repeatMinChars': '最低字符门槛',
        'ui.loopGuard.repeatMinCharsHint': '判据的最低字符门槛，取代原来「窗口必须满」的前置；低于这个字符数不做重复判定。整数 500–窗口大小。默认 1000',
        'ui.loopGuard.repeatMinLines': '窗口内最少行数',
        'ui.loopGuard.repeatMinLinesHint': '窗口里非空行少于这个数就不判（整数 5–5000）。默认 30',
        'ui.loopGuard.repeatCycles': '最少重复轮数',
        'ui.loopGuard.repeatCyclesHint': '窗口里出现最多的那一行至少重复这个次数才判（整数 2–100）。默认 6',
        'ui.loopGuard.repeatUniqueRatio': '唯一行占比上限',
        'ui.loopGuard.repeatUniqueRatioHint': '窗口内唯一行占比 ≤ 这个值才判（0.01–0.9）。默认 0.2',
        'ui.loopGuard.repeatGramRatio': '片段唯一率上限（k-gram 兜底）',
        'ui.loopGuard.repeatGramRatioHint': '单行/少行（不足 30 行）的长输出里，把窗口按 8 个字符切成不重叠片段，唯一片段占比 ≤ 这个值就判重复（0.01–0.9）。默认 0.10。单行块的「唯一行占比」恒为 1.0，只能靠它兜底。⚠ 调高更容易误杀长单行自然语言：实测中文自然散文单行约 0.36、英文约 0.45，而真退化单行只有 0.007–0.009。',
        'ui.loopGuard.repeatNote': '这条规则抓的是「流里在重复同一小段文本」（思考里尤其常见）：一段窗口里行数远多于唯一行数时提前掐断，不等模型自己停下来；单行/少行的长输出改由片段唯一率（k-gram）兜底。',
        'ui.loopGuard.retries': '允许的纠正重试次数',
        'ui.loopGuard.retriesHint': '掐断后允许宿主再重试几次（整数 0–5）。',
        'ui.loopGuard.lowerEffort': '重试时降低推理档位',
        'ui.loopGuard.lowerEffortHint': '纠正重试时把推理档位调低，避免再次陷入循环。',
        'ui.loopGuard.save': '保存',
        'ui.loopGuard.saving': '保存中…',
        'ui.loopGuard.saved': '已保存',
        'ui.loopGuard.invalidLimit': '推理分片上限必须是不小于 100 的整数',
        'ui.loopGuard.invalidBudget': '单次尝试时间上限必须不小于 10 秒',
        'ui.loopGuard.invalidStall': '沉默上限必须是不小于 10 的整数秒',
        'ui.loopGuard.invalidNoOutput': '零产出上限必须是不小于 10 的整数秒',
        'ui.loopGuard.invalidRepeatWindow': '重复检测窗口必须是 1000–200000 的整数',
        'ui.loopGuard.invalidRepeatMinChars': '最低字符门槛必须是 500 到重复检测窗口之间的整数',
        'ui.loopGuard.invalidRepeatMinLines': '窗口内最少行数必须是 5–5000 的整数',
        'ui.loopGuard.invalidRepeatCycles': '最少重复轮数必须是 2–100 的整数',
        'ui.loopGuard.invalidRepeatUniqueRatio': '唯一行占比上限必须是 0.01–0.9 的数',
        'ui.loopGuard.invalidRepeatGramRatio': '片段唯一率上限必须是 0.01–0.9 的数',
        'ui.loopGuard.invalidRetries': '纠正重试次数必须是 0–5 的整数',
        'ui.loopGuard.stats': '统计',
        'ui.loopGuard.statAttempts': '尝试次数',
        'ui.loopGuard.statGuarded': '拦下的循环',
        'ui.loopGuard.statRetries': '放行的重试',
        'ui.loopGuard.statStops': '终止的重试',
        'ui.loopGuard.statSaved': '省下的时间',
        'ui.loopGuard.byRule': '按规则分布',
        'ui.loopGuard.ruleChunk': '分片洪水',
        'ui.loopGuard.ruleStall': '卡住不动',
        'ui.loopGuard.ruleNoOutput': '慢速渗流',
        'ui.loopGuard.ruleRepeat': '输出退化重复',
        'ui.loopGuard.ruleAbsolute': '绝对上限',
        'ui.loopGuard.reset': '清零',
        'ui.loopGuard.resetting': '清零中…',
        'ui.loopGuard.resetDone': '统计已清零',
        'ui.loopGuard.recent': '最近触发',
        'ui.loopGuard.recentEmpty': '还没拦到过',
        'ui.loopGuard.colAt': '时间',
        'ui.loopGuard.colTurnStep': 'turn/step',
        'ui.loopGuard.colDeltas': '推理分片',
        'ui.loopGuard.colElapsed': '已耗时',
        'ui.loopGuard.colProductive': '产出分片',
        'ui.loopGuard.close': '关闭',
        'ui.loopGuard.loading': '加载中…',
        'ui.loopGuard.error': '操作失败',
        'ui.loopGuard.retry': '重试',
        'ui.loopGuard.netFail': '网络请求失败',
        'ui.loopGuard.badJson': '响应不是合法 JSON，',
        'ui.loopGuard.durMs': (n) => `${n} 毫秒`,
        'ui.loopGuard.durSec': (n) => `${n} 秒`,
        'ui.loopGuard.durMin': (n) => `${n} 分钟`,
        'ui.loopGuard.durHour': (n) => `${n} 小时`,
      },
      en: {
        'ui.loopGuard.nav': 'Loop guard',
        'ui.loopGuard.title': 'Loop guard',
        'ui.loopGuard.intro':
          'When the model falls into a reasoning loop, the host retries the same deterministic failure over and over (1-5 minutes each). The guard cuts that attempt short once a loop is detected and stops further retries.',
        'ui.loopGuard.enable': 'Enable guard',
        'ui.loopGuard.enableHint': 'When off, nothing is interfered with: no attempt is cut short.',
        'ui.loopGuard.stateOn': 'enabled',
        'ui.loopGuard.stateOff': 'disabled',
        'ui.loopGuard.thresholds': 'Thresholds',
        'ui.loopGuard.thresholdsHint': 'Click Save to apply; invalid values are reported here and no request is sent.',
        'ui.loopGuard.limit': 'Reasoning chunk limit',
        'ui.loopGuard.limitHint': 'Consecutive reasoning chunks above this in one attempt count as a loop (integer >= 100).',
        'ui.loopGuard.budget': 'Attempt time budget',
        'ui.loopGuard.budgetHint': 'Entered in seconds (>= 10); stored in milliseconds.',
        'ui.loopGuard.budgetUnit': 's',
        'ui.loopGuard.stall': 'Stall timeout',
        'ui.loopGuard.stallHint': 'Abort when no chunk arrives for this long (counted before the first chunk too). Default 180s.',
        'ui.loopGuard.noOutput': 'No-output timeout',
        'ui.loopGuard.noOutputHint': 'Abort when the stream keeps trickling reasoning but never produces text or tool calls. Default 600s. This is the rule most likely to misfire — a legitimately long think also has no output.',
        'ui.loopGuard.repeatWindow': 'Repetition window',
        'ui.loopGuard.repeatWindowHint': 'Only look for repetition within this many recent characters (integer 1000-200000). Default 6000',
        'ui.loopGuard.repeatMinChars': 'Minimum character gate',
        'ui.loopGuard.repeatMinCharsHint': 'Minimum character gate for the criteria, replacing the old "window must be full" precondition; no repetition is judged below this many characters. Integer 500 to the window size. Default 1000',
        'ui.loopGuard.repeatMinLines': 'Minimum lines in window',
        'ui.loopGuard.repeatMinLinesHint': 'Do not judge below this many non-empty lines (integer 5-5000). Default 30',
        'ui.loopGuard.repeatCycles': 'Minimum repetition cycles',
        'ui.loopGuard.repeatCyclesHint': 'Judge only when the most frequent line appears at least this many times (integer 2-100). Default 6',
        'ui.loopGuard.repeatUniqueRatio': 'Max unique-line ratio',
        'ui.loopGuard.repeatUniqueRatioHint': 'Judge only when the unique-line ratio is <= this value (0.01-0.9). Default 0.2',
        'ui.loopGuard.repeatGramRatio': 'Fragment uniqueness cap (k-gram fallback)',
        'ui.loopGuard.repeatGramRatioHint': 'For long single-line / few-line output (under 30 lines) the window is split into non-overlapping 8-character fragments; judge when the unique-fragment ratio is <= this value (0.01-0.9). Default 0.10. A single-line block always has a unique-line ratio of 1.0, so this is its only fallback. Warning: raising it misfires more easily on long single-line natural language — measured Chinese prose single line ~0.36, English ~0.45, while genuinely degenerate single lines are only 0.007-0.009.',
        'ui.loopGuard.repeatNote': 'This rule catches a stream repeating the same short piece of text (especially common inside reasoning): when a window holds far more lines than unique lines it cuts the attempt short instead of waiting for the model to stop by itself; long single-line / few-line output is caught by the fragment uniqueness (k-gram) fallback instead.',
        'ui.loopGuard.retries': 'Allowed corrective retries',
        'ui.loopGuard.retriesHint': 'How many retries the host may still do after a cut (integer 0-5).',
        'ui.loopGuard.lowerEffort': 'Lower reasoning effort on retry',
        'ui.loopGuard.lowerEffortHint': 'Drop the reasoning effort for corrective retries so the loop does not repeat.',
        'ui.loopGuard.save': 'Save',
        'ui.loopGuard.saving': 'Saving...',
        'ui.loopGuard.saved': 'Saved',
        'ui.loopGuard.invalidLimit': 'Reasoning chunk limit must be an integer >= 100',
        'ui.loopGuard.invalidBudget': 'Attempt time budget must be at least 10 seconds',
        'ui.loopGuard.invalidStall': 'Stall timeout must be an integer ≥ 10 seconds',
        'ui.loopGuard.invalidNoOutput': 'No-output timeout must be an integer ≥ 10 seconds',
        'ui.loopGuard.invalidRepeatWindow': 'Repetition window must be an integer between 1000 and 200000',
        'ui.loopGuard.invalidRepeatMinChars': 'Minimum character gate must be an integer between 500 and the repetition window',
        'ui.loopGuard.invalidRepeatMinLines': 'Minimum lines in window must be an integer between 5 and 5000',
        'ui.loopGuard.invalidRepeatCycles': 'Minimum repetition cycles must be an integer between 2 and 100',
        'ui.loopGuard.invalidRepeatUniqueRatio': 'Max unique-line ratio must be a number between 0.01 and 0.9',
        'ui.loopGuard.invalidRepeatGramRatio': 'Fragment uniqueness cap must be a number between 0.01 and 0.9',
        'ui.loopGuard.invalidRetries': 'Corrective retries must be an integer between 0 and 5',
        'ui.loopGuard.stats': 'Stats',
        'ui.loopGuard.statAttempts': 'Attempts',
        'ui.loopGuard.statGuarded': 'Loops caught',
        'ui.loopGuard.statRetries': 'Retries allowed',
        'ui.loopGuard.statStops': 'Retries stopped',
        'ui.loopGuard.statSaved': 'Time saved',
        'ui.loopGuard.byRule': 'By rule',
        'ui.loopGuard.ruleChunk': 'Chunk flood',
        'ui.loopGuard.ruleStall': 'Stall',
        'ui.loopGuard.ruleNoOutput': 'Slow trickle',
        'ui.loopGuard.ruleRepeat': 'Degenerate repetition',
        'ui.loopGuard.ruleAbsolute': 'Absolute budget',
        'ui.loopGuard.reset': 'Reset',
        'ui.loopGuard.resetting': 'Resetting...',
        'ui.loopGuard.resetDone': 'Stats cleared',
        'ui.loopGuard.recent': 'Recent triggers',
        'ui.loopGuard.recentEmpty': 'Nothing caught yet',
        'ui.loopGuard.colAt': 'Time',
        'ui.loopGuard.colTurnStep': 'turn/step',
        'ui.loopGuard.colDeltas': 'Reasoning chunks',
        'ui.loopGuard.colElapsed': 'Elapsed',
        'ui.loopGuard.colProductive': 'Productive chunks',
        'ui.loopGuard.close': 'Close',
        'ui.loopGuard.loading': 'Loading...',
        'ui.loopGuard.error': 'Action failed',
        'ui.loopGuard.retry': 'Retry',
        'ui.loopGuard.netFail': 'Network request failed',
        'ui.loopGuard.badJson': 'Response was not valid JSON, ',
        'ui.loopGuard.durMs': (n) => `${n} ms`,
        'ui.loopGuard.durSec': (n) => `${n} s`,
        'ui.loopGuard.durMin': (n) => `${n} min`,
        'ui.loopGuard.durHour': (n) => `${n} h`,
      },
    }

    const LANG = (
      (typeof navigator !== 'undefined' && navigator.language) ||
      'zh'
    ).toLowerCase().startsWith('zh')
      ? 'zh'
      : 'en'

    /** 取一条文案；带函数的值按参数调用。 */
    function t(key, ...args) {
      const value = DICT[LANG][key] ?? DICT.zh[key]
      return typeof value === 'function' ? value(...args) : value
    }

    /** 已核实的主题 token，不发明新名字。 */
    const TOKEN = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      nested: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const INPUT_STYLE = {
      width: '100%',
      boxSizing: 'border-box',
      font: 'inherit',
      fontSize: 13,
      padding: '5px 8px',
      marginTop: 4,
      color: TOKEN.text,
      background: TOKEN.nested,
      border: `1px solid ${TOKEN.border}`,
      borderRadius: 6,
    }

    /** 数字输入窄一点，右边跟单位。 */
    const NUMBER_STYLE = { ...INPUT_STYLE, width: 120 }

    const CARD_STYLE = {
      background: TOKEN.surface,
      border: `1px solid ${TOKEN.border}`,
      borderRadius: 8,
      padding: '12px 14px',
      marginBottom: 12,
    }

    const HINT_STYLE = { margin: '2px 0 0', fontSize: 11, lineHeight: 1.5, color: TOKEN.dim }

    const LABEL_STYLE = { fontSize: 13, fontWeight: 600, color: TOKEN.text }

    /** POST 的 fetch 选项。 */
    function post(body) {
      return {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    }

    /** 任意值 → 可读错误文本。 */
    function errText(error) {
      return String((error && error.message) || error)
    }

    /**
     * 统一请求：解包 `{ok, value}` 信封，失败抛 Error（message 优先用宿主给的）。
     * 网络层与 JSON 解析各自 try/catch，任何失败都变成可展示的 Error。
     */
    async function request(path, options) {
      let response
      try {
        response = await fetch(path, options)
      } catch (error) {
        throw new Error(`${t('ui.loopGuard.netFail')}: ${errText(error)}`)
      }
      let envelope
      try {
        envelope = await response.json()
      } catch (error) {
        throw new Error(`${t('ui.loopGuard.badJson')}HTTP ${response.status}`)
      }
      if (!envelope || envelope.ok !== true) {
        const detail = envelope && envelope.error && (envelope.error.message || envelope.error.code)
        throw new Error(detail ? String(detail) : `HTTP ${response.status}`)
      }
      return envelope.value
    }

    /** epoch 毫秒 / ISO 字符串 → 本地时间文本；非法值原样返回。 */
    function formatAt(value) {
      if (value === null || value === undefined || value === '') return '—'
      const date = new Date(typeof value === 'number' ? value : String(value))
      if (Number.isNaN(date.getTime())) return String(value)
      try {
        return date.toLocaleString()
      } catch (error) {
        return date.toISOString()
      }
    }

    /** 毫秒 → 人话（`3.4 分钟` / `1.2 小时`）。 */
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
      if (ms < 1000) return t('ui.loopGuard.durMs', String(Math.round(ms)))
      if (ms < 60000) return t('ui.loopGuard.durSec', (ms / 1000).toFixed(1))
      if (ms < 3600000) return t('ui.loopGuard.durMin', (ms / 60000).toFixed(1))
      return t('ui.loopGuard.durHour', (ms / 3600000).toFixed(1))
    }

    /** 统计计数：非数字一律显示 0，不显示 NaN。 */
    function count(value) {
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : '0'
    }

    /** 九个数值输入的本地校验：非法就返回 {error}，合法返回 {value}。 */
    function parseLimit(text) {
      const value = Number(String(text).trim())
      if (String(text).trim() === '' || !Number.isInteger(value) || value < LIMIT_MIN) {
        return { error: t('ui.loopGuard.invalidLimit') }
      }
      return { value }
    }

    function parseBudgetSec(text) {
      const raw = String(text).trim()
      const seconds = Number(raw)
      if (raw === '' || !Number.isFinite(seconds)) return { error: t('ui.loopGuard.invalidBudget') }
      const ms = Math.round(seconds * 1000)
      if (ms < BUDGET_MS_MIN) return { error: t('ui.loopGuard.invalidBudget') }
      return { value: ms }
    }

    /** 沉默上限：界面上按**整数秒**填，发请求时 ×1000 转毫秒（与宿主 MIN_STALL_TIMEOUT_MS=10000 对齐）。 */
    function parseStallSec(text) {
      const raw = String(text).trim()
      const seconds = Number(raw)
      if (raw === '' || !Number.isInteger(seconds) || seconds < STALL_SEC_MIN) {
        return { error: t('ui.loopGuard.invalidStall') }
      }
      return { value: seconds * 1000 }
    }

    /** 零产出上限：界面上按**整数秒**填，发请求时 ×1000 转毫秒（与宿主 MIN_NO_OUTPUT_MS=10000 对齐）。 */
    function parseNoOutputSec(text) {
      const raw = String(text).trim()
      const seconds = Number(raw)
      if (raw === '' || !Number.isInteger(seconds) || seconds < NO_OUTPUT_SEC_MIN) {
        return { error: t('ui.loopGuard.invalidNoOutput') }
      }
      return { value: seconds * 1000 }
    }

    function parseRetries(text) {
      const value = Number(String(text).trim())
      if (String(text).trim() === '' || !Number.isInteger(value) || value < 0 || value > RETRIES_MAX) {
        return { error: t('ui.loopGuard.invalidRetries') }
      }
      return { value }
    }

    /** 重复检测窗口：整数 1000–200000 字符。 */
    function parseRepeatWindow(text) {
      const value = Number(String(text).trim())
      if (String(text).trim() === '' || !Number.isInteger(value) ||
        value < REPEAT_WINDOW_MIN || value > REPEAT_WINDOW_MAX) {
        return { error: t('ui.loopGuard.invalidRepeatWindow') }
      }
      return { value }
    }

    /**
     * 最低字符门槛：整数 [REPEAT_SEG_MIN_CHARS, 当前 repeatWindowChars]。
     * 上限是**另一个输入框的当前值**（契约 §1.1），不是常数 —— 所以调用方要先校验窗口、
     * 再把窗口的解析值传进来；窗口改小时这里就会拒绝。
     */
    function parseRepeatMinChars(text, windowChars) {
      const value = Number(String(text).trim())
      if (String(text).trim() === '' || !Number.isInteger(value) || value < REPEAT_SEG_MIN_CHARS) {
        return { error: t('ui.loopGuard.invalidRepeatMinChars') }
      }
      if (Number.isInteger(windowChars) && value > windowChars) {
        return { error: t('ui.loopGuard.invalidRepeatMinChars') }
      }
      return { value }
    }

    /** 窗口内最少非空行数：整数 5–5000。 */
    function parseRepeatMinLines(text) {
      const value = Number(String(text).trim())
      if (String(text).trim() === '' || !Number.isInteger(value) ||
        value < REPEAT_MIN_LINES_MIN || value > REPEAT_MIN_LINES_MAX) {
        return { error: t('ui.loopGuard.invalidRepeatMinLines') }
      }
      return { value }
    }

    /** 最少重复轮数：整数 2–100。 */
    function parseRepeatCycles(text) {
      const value = Number(String(text).trim())
      if (String(text).trim() === '' || !Number.isInteger(value) ||
        value < REPEAT_CYCLES_MIN || value > REPEAT_CYCLES_MAX) {
        return { error: t('ui.loopGuard.invalidRepeatCycles') }
      }
      return { value }
    }

    /** 唯一行占比上限：0.01–0.9 的数（**不是**整数）。 */
    function parseRepeatRatio(text) {
      const raw = String(text).trim()
      const value = Number(raw)
      if (raw === '' || !Number.isFinite(value) || value < REPEAT_RATIO_MIN || value > REPEAT_RATIO_MAX) {
        return { error: t('ui.loopGuard.invalidRepeatUniqueRatio') }
      }
      return { value }
    }

    /** 片段唯一率上限（k-gram 兜底）：0.01–0.9 的数（**不是**整数）。 */
    function parseRepeatGramRatio(text) {
      const raw = String(text).trim()
      const value = Number(raw)
      if (raw === '' || !Number.isFinite(value) ||
        value < REPEAT_GRAM_RATIO_MIN || value > REPEAT_GRAM_RATIO_MAX) {
        return { error: t('ui.loopGuard.invalidRepeatGramRatio') }
      }
      return { value }
    }

    /** 一个文字按钮。 */
    function Button(props) {
      return h('button', {
        type: 'button',
        title: props.title,
        disabled: props.disabled,
        onClick: props.onClick,
        style: {
          flex: '0 0 auto',
          padding: '4px 10px',
          fontSize: 12,
          font: 'inherit',
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.4 : 1,
          color: props.primary ? '#fff' : props.danger ? TOKEN.error : TOKEN.text,
          background: props.primary ? TOKEN.brand : 'transparent',
          border: `1px solid ${props.primary ? TOKEN.brand : TOKEN.border}`,
          borderRadius: 6,
        },
      }, props.children)
    }

    /** 卡片：标题行（可带右侧控件）+ 内容。 */
    function Card(props) {
      return h('section', { style: CARD_STYLE },
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: props.children ? 8 : 0 },
        },
          h('span', { style: { ...LABEL_STYLE, fontSize: 14 } }, props.title),
          h('span', { style: { flex: '1 1 auto' } }),
          props.extra === undefined ? null : props.extra,
        ),
        props.hint === undefined ? null : h('p', { style: HINT_STYLE }, props.hint),
        props.children,
      )
    }

    /** 开关：checkbox + 文字（与 dsh-work-habits / dsh-bug-reporter 同形）。 */
    function Toggle(props) {
      return h('label', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          margin: '4px 0 0',
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.6 : 1,
        },
      },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled,
          onChange: () => props.onChange(props.checked !== true),
        }),
        h('span', { style: { fontSize: 13, color: TOKEN.text } }, props.label),
      )
    }

    /** 一个统计格。 */
    function Stat(props) {
      return h('div', {
        style: {
          flex: '1 1 0',
          minWidth: 92,
          padding: '8px 10px',
          background: TOKEN.nested,
          border: `1px solid ${TOKEN.border}`,
          borderRadius: 6,
        },
      },
        h('div', { style: { fontSize: 11, color: TOKEN.dim } }, props.label),
        h('div', { style: { fontSize: 16, fontWeight: 600, color: props.color || TOKEN.text, marginTop: 2 } }, props.value),
      )
    }

    /** 数字输入行：标题 + 说明 + 输入框（+ 单位）。 */
    function NumberField(props) {
      return h('div', { style: { margin: '0 0 12px' } },
        h('div', { style: LABEL_STYLE }, props.label),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('input', {
            type: 'text',
            inputMode: 'numeric',
            value: props.value,
            disabled: props.disabled,
            onChange: (event) => props.onChange(event.target.value),
            style: NUMBER_STYLE,
          }),
          props.unit === undefined ? null : h('span', { style: { fontSize: 12, color: TOKEN.dim, marginTop: 4 } }, props.unit),
        ),
        h('p', { style: HINT_STYLE }, props.hint),
        props.error === undefined ? null : h('p', {
          style: { ...HINT_STYLE, color: TOKEN.error },
        }, props.error),
      )
    }

    /** 设置页主体。 */
    function LoopGuardSection(props) {
      const [data, setData] = React.useState(null)
      const [status, setStatus] = React.useState('loading')
      const [message, setMessage] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')

      // 十一个数值输入是受控的本地文本；宿主返回的配置只在用户没改过时回填，
      // 否则轮询会把用户正在输入的内容冲掉。
      const [limitText, setLimitText] = React.useState('')
      const [budgetText, setBudgetText] = React.useState('')
      const [stallText, setStallText] = React.useState('')
      const [noOutputText, setNoOutputText] = React.useState('')
      const [retriesText, setRetriesText] = React.useState('')
      const [repeatWindowText, setRepeatWindowText] = React.useState('')
      const [repeatMinCharsText, setRepeatMinCharsText] = React.useState('')
      const [repeatMinLinesText, setRepeatMinLinesText] = React.useState('')
      const [repeatCyclesText, setRepeatCyclesText] = React.useState('')
      const [repeatRatioText, setRepeatRatioText] = React.useState('')
      const [repeatGramRatioText, setRepeatGramRatioText] = React.useState('')
      const [fieldError, setFieldError] = React.useState({ field: '', text: '' })

      const alive = React.useRef(true)
      const timer = React.useRef(null)
      const dirty = React.useRef(false)
      const inflight = React.useRef(null)

      /** 停掉轮询定时器（卸载、关闭、出错重试时都用它）。 */
      const stopPolling = React.useCallback(() => {
        if (timer.current !== null) {
          clearTimeout(timer.current)
          timer.current = null
        }
      }, [])

      /** 用宿主返回的配置回填十一个输入框（用户改过就不动）。 */
      const fillForm = React.useCallback((config) => {
        if (dirty.current || config === null || typeof config !== 'object') return
        if (typeof config.reasoningChunkLimit === 'number') setLimitText(String(config.reasoningChunkLimit))
        if (typeof config.attemptBudgetMs === 'number') setBudgetText(String(config.attemptBudgetMs / 1000))
        if (typeof config.stallTimeoutMs === 'number') setStallText(String(config.stallTimeoutMs / 1000))
        if (typeof config.noOutputMs === 'number') setNoOutputText(String(config.noOutputMs / 1000))
        if (typeof config.maxGuardedRetries === 'number') setRetriesText(String(config.maxGuardedRetries))
        if (typeof config.repeatWindowChars === 'number') setRepeatWindowText(String(config.repeatWindowChars))
        if (typeof config.repeatMinChars === 'number') setRepeatMinCharsText(String(config.repeatMinChars))
        if (typeof config.repeatMinLines === 'number') setRepeatMinLinesText(String(config.repeatMinLines))
        if (typeof config.repeatCycles === 'number') setRepeatCyclesText(String(config.repeatCycles))
        if (typeof config.repeatUniqueRatio === 'number') setRepeatRatioText(String(config.repeatUniqueRatio))
        if (typeof config.repeatGramRatio === 'number') setRepeatGramRatioText(String(config.repeatGramRatio))
      }, [])

      /** 拉一次状态。silent = 轮询触发（不显示 loading、不清成功提示）。 */
      const load = React.useCallback((silent) => {
        if (!silent) {
          setStatus('loading')
          setMessage('')
        }
        if (inflight.current) {
          try {
            inflight.current.abort()
          } catch (error) {
            // 老实现不支持 abort 也无所谓，下面还有 alive 守卫。
          }
        }
        let controller = null
        if (typeof AbortController === 'function') controller = new AbortController()
        inflight.current = controller
        return request(ROUTE.state, controller ? { signal: controller.signal } : undefined)
          .then((value) => {
            if (!alive.current) return
            setData(value)
            setStatus('ready')
            setMessage('')
            fillForm(value && value.config)
          })
          .catch((error) => {
            if (!alive.current) return
            setStatus('error')
            setMessage(errText(error))
          })
      }, [fillForm])

      /** 排下一次轮询（永远只有一根定时器）。 */
      const schedule = React.useCallback(() => {
        stopPolling()
        timer.current = setTimeout(() => {
          timer.current = null
          load(true).then(() => {
            if (alive.current) schedule()
          })
        }, POLL_MS)
      }, [load, stopPolling])

      React.useEffect(() => {
        alive.current = true
        dirty.current = false
        load(false).then(() => {
          if (alive.current) schedule()
        })
        return () => {
          alive.current = false
          stopPolling()
          if (inflight.current) {
            try {
              inflight.current.abort()
            } catch (error) {
              // 卸载时的 abort 失败无需处理。
            }
          }
        }
      }, [load, schedule, stopPolling])

      /** 关掉设置页：先停轮询，再调外壳给的 close（有才调）。 */
      const close = React.useCallback(() => {
        stopPolling()
        if (typeof props.close === 'function') props.close()
      }, [props.close, stopPolling])

      /** 提交一个配置子集；成功后把返回的配置并进本地状态。 */
      const sendConfig = React.useCallback((patch, label) => {
        setBusy(label)
        setMessage('')
        setNotice('')
        return request(ROUTE.config, post(patch))
          .then((value) => {
            if (!alive.current) return
            setData((prev) => {
              const base = prev === null || typeof prev !== 'object' ? {} : prev
              return { ...base, config: (value && value.config) || base.config }
            })
            setStatus('ready')
            setNotice(t('ui.loopGuard.saved'))
          })
          .catch((error) => {
            if (!alive.current) return
            setStatus('error')
            setMessage(errText(error))
          })
          .then(() => {
            if (alive.current) setBusy('')
          })
      }, [])

      /** 保存十一个数值：先本地校验，非法就地提示且不发请求。 */
      const saveNumbers = React.useCallback(() => {
        const limit = parseLimit(limitText)
        if (limit.error !== undefined) {
          setFieldError({ field: 'limit', text: limit.error })
          return
        }
        const budget = parseBudgetSec(budgetText)
        if (budget.error !== undefined) {
          setFieldError({ field: 'budget', text: budget.error })
          return
        }
        const stall = parseStallSec(stallText)
        if (stall.error !== undefined) {
          setFieldError({ field: 'stall', text: stall.error })
          return
        }
        const noOutput = parseNoOutputSec(noOutputText)
        if (noOutput.error !== undefined) {
          setFieldError({ field: 'noOutput', text: noOutput.error })
          return
        }
        const retries = parseRetries(retriesText)
        if (retries.error !== undefined) {
          setFieldError({ field: 'retries', text: retries.error })
          return
        }
        const repeatWindow = parseRepeatWindow(repeatWindowText)
        if (repeatWindow.error !== undefined) {
          setFieldError({ field: 'repeatWindow', text: repeatWindow.error })
          return
        }
        // 上限是窗口的当前值，所以必须排在窗口校验之后（契约 §1.1）。
        const repeatMinChars = parseRepeatMinChars(repeatMinCharsText, repeatWindow.value)
        if (repeatMinChars.error !== undefined) {
          setFieldError({ field: 'repeatMinChars', text: repeatMinChars.error })
          return
        }
        const repeatMinLines = parseRepeatMinLines(repeatMinLinesText)
        if (repeatMinLines.error !== undefined) {
          setFieldError({ field: 'repeatMinLines', text: repeatMinLines.error })
          return
        }
        const repeatCycles = parseRepeatCycles(repeatCyclesText)
        if (repeatCycles.error !== undefined) {
          setFieldError({ field: 'repeatCycles', text: repeatCycles.error })
          return
        }
        const repeatRatio = parseRepeatRatio(repeatRatioText)
        if (repeatRatio.error !== undefined) {
          setFieldError({ field: 'repeatRatio', text: repeatRatio.error })
          return
        }
        const repeatGram = parseRepeatGramRatio(repeatGramRatioText)
        if (repeatGram.error !== undefined) {
          setFieldError({ field: 'repeatGramRatio', text: repeatGram.error })
          return
        }
        setFieldError({ field: '', text: '' })
        sendConfig(
          {
            reasoningChunkLimit: limit.value,
            attemptBudgetMs: budget.value,
            stallTimeoutMs: stall.value,
            noOutputMs: noOutput.value,
            maxGuardedRetries: retries.value,
            repeatWindowChars: repeatWindow.value,
            repeatMinChars: repeatMinChars.value,
            repeatMinLines: repeatMinLines.value,
            repeatCycles: repeatCycles.value,
            repeatUniqueRatio: repeatRatio.value,
            repeatGramRatio: repeatGram.value,
          },
          'save',
        ).then(() => {
          if (alive.current) dirty.current = false
        })
      }, [
        budgetText, limitText, noOutputText, repeatCyclesText, repeatGramRatioText, repeatMinCharsText,
        repeatMinLinesText, repeatRatioText, repeatWindowText, retriesText, sendConfig, stallText,
      ])

      /** 清零统计。 */
      const resetStats = React.useCallback(() => {
        setBusy('reset')
        setMessage('')
        setNotice('')
        return request(ROUTE.reset, post({}))
          .then((value) => {
            if (!alive.current) return
            setData((prev) => {
              const base = prev === null || typeof prev !== 'object' ? {} : prev
              return { ...base, stats: (value && value.stats) || base.stats }
            })
            setStatus('ready')
            setNotice(t('ui.loopGuard.resetDone'))
          })
          .catch((error) => {
            if (!alive.current) return
            setStatus('error')
            setMessage(errText(error))
          })
          .then(() => {
            if (alive.current) setBusy('')
          })
      }, [])

      const config = data && typeof data.config === 'object' && data.config !== null ? data.config : {}
      const stats = data && typeof data.stats === 'object' && data.stats !== null ? data.stats : {}
      const byRule = stats.byRule !== null && typeof stats.byRule === 'object' ? stats.byRule : {}
      const recent = data && Array.isArray(data.recent) ? data.recent : []
      const enabled = data !== null && data.enabled === true
      const lowerEffort = config.lowerEffortOnRetry === true
      const locked = busy !== ''

      if (status === 'loading' && data === null) {
        return h('div', { style: { padding: 16, fontSize: 13, color: TOKEN.dim } }, t('ui.loopGuard.loading'))
      }

      const head = h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
      },
        h('span', { style: { fontSize: 15, fontWeight: 600, color: TOKEN.text } }, t('ui.loopGuard.title')),
        h('span', { style: { flex: '1 1 auto' } }),
        busy === 'save' ? h('span', { style: { fontSize: 12, color: TOKEN.dim } }, t('ui.loopGuard.saving')) : null,
        busy === 'reset' ? h('span', { style: { fontSize: 12, color: TOKEN.dim } }, t('ui.loopGuard.resetting')) : null,
        notice === '' ? null : h('span', { style: { fontSize: 12, color: TOKEN.success } }, notice),
        typeof props.close === 'function'
          ? h(Button, { onClick: close, title: t('ui.loopGuard.close') }, t('ui.loopGuard.close'))
          : null,
      )

      // 错误横幅：失败必须有可见出口，不能静默空白。
      const errorBox = status === 'error'
        ? h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            marginBottom: 12,
            fontSize: 12,
            color: TOKEN.error,
            background: TOKEN.nested,
            border: `1px solid ${TOKEN.error}`,
            borderRadius: 6,
          },
        },
          h('span', null, `${t('ui.loopGuard.error')}: ${message}`),
          h('span', { style: { flex: '1 1 auto' } }),
          h(Button, { onClick: () => load(false) }, t('ui.loopGuard.retry')),
        )
        : null

      // 1) 总开关
      const enableCard = h(Card, {
        key: 'enable',
        title: t('ui.loopGuard.enable'),
        hint: t('ui.loopGuard.enableHint'),
        extra: h('span', {
          style: { fontSize: 12, color: enabled ? TOKEN.success : TOKEN.idle },
        }, enabled ? t('ui.loopGuard.stateOn') : t('ui.loopGuard.stateOff')),
      },
        h(Toggle, {
          checked: enabled,
          disabled: locked,
          label: enabled ? t('ui.loopGuard.stateOn') : t('ui.loopGuard.stateOff'),
          onChange: (next) => sendConfig({ enabled: next }, 'enable'),
        }),
      )

      // 2) 十一个数值 + 3) lowerEffortOnRetry
      const thresholdCard = h(Card, {
        key: 'thresholds',
        title: t('ui.loopGuard.thresholds'),
        hint: t('ui.loopGuard.thresholdsHint'),
        extra: h(Button, { primary: true, disabled: locked, onClick: saveNumbers }, t('ui.loopGuard.save')),
      },
        h(NumberField, {
          label: t('ui.loopGuard.limit'),
          hint: t('ui.loopGuard.limitHint'),
          value: limitText,
          disabled: locked,
          error: fieldError.field === 'limit' ? fieldError.text : undefined,
          onChange: (text) => {
            dirty.current = true
            setFieldError({ field: '', text: '' })
            setLimitText(text)
          },
        }),
        h(NumberField, {
          label: t('ui.loopGuard.budget'),
          hint: t('ui.loopGuard.budgetHint'),
          unit: t('ui.loopGuard.budgetUnit'),
          value: budgetText,
          disabled: locked,
          error: fieldError.field === 'budget' ? fieldError.text : undefined,
          onChange: (text) => {
            dirty.current = true
            setFieldError({ field: '', text: '' })
            setBudgetText(text)
          },
        }),
        h(NumberField, {
          label: t('ui.loopGuard.stall'),
          hint: t('ui.loopGuard.stallHint'),
          unit: t('ui.loopGuard.budgetUnit'),
          value: stallText,
          disabled: locked,
          error: fieldError.field === 'stall' ? fieldError.text : undefined,
          onChange: (text) => {
            dirty.current = true
            setFieldError({ field: '', text: '' })
            setStallText(text)
          },
        }),
        h(NumberField, {
          label: t('ui.loopGuard.noOutput'),
          hint: t('ui.loopGuard.noOutputHint'),
          unit: t('ui.loopGuard.budgetUnit'),
          value: noOutputText,
          disabled: locked,
          error: fieldError.field === 'noOutput' ? fieldError.text : undefined,
          onChange: (text) => {
            dirty.current = true
            setFieldError({ field: '', text: '' })
            setNoOutputText(text)
          },
        }),
        h(NumberField, {
          label: t('ui.loopGuard.retries'),
          hint: t('ui.loopGuard.retriesHint'),
          value: retriesText,
          disabled: locked,
          error: fieldError.field === 'retries' ? fieldError.text : undefined,
          onChange: (text) => {
            dirty.current = true
            setFieldError({ field: '', text: '' })
            setRetriesText(text)
          },
        }),
        h('p', { style: { ...HINT_STYLE, margin: '0 0 12px' } }, t('ui.loopGuard.repeatNote')),
        h(NumberField, {
          label: t('ui.loopGuard.repeatWindow'),
          hint: t('ui.loopGuard.repeatWindowHint'),
          value: repeatWindowText,
          disabled: locked,
          error: fieldError.field === 'repeatWindow' ? fieldError.text : undefined,
          onChange: (text) => {
            dirty.current = true
            setFieldError({ field: '', text: '' })
            setRepeatWindowText(text)
          },
        }),
        h(NumberField, {
          label: t('ui.loopGuard.repeatMinChars'),
          hint: t('ui.loopGuard.repeatMinCharsHint'),
          value: repeatMinCharsText,
          disabled: locked,
          error: fieldError.field === 'repeatMinChars' ? fieldError.text : undefined,
          onChange: (text) => {
            dirty.current = true
            setFieldError({ field: '', text: '' })
            setRepeatMinCharsText(text)
          },
        }),
        h(NumberField, {
          label: t('ui.loopGuard.repeatMinLines'),
          hint: t('ui.loopGuard.repeatMinLinesHint'),
          value: repeatMinLinesText,
          disabled: locked,
          error: fieldError.field === 'repeatMinLines' ? fieldError.text : undefined,
          onChange: (text) => {
            dirty.current = true
            setFieldError({ field: '', text: '' })
            setRepeatMinLinesText(text)
          },
        }),
        h(NumberField, {
          label: t('ui.loopGuard.repeatCycles'),
          hint: t('ui.loopGuard.repeatCyclesHint'),
          value: repeatCyclesText,
          disabled: locked,
          error: fieldError.field === 'repeatCycles' ? fieldError.text : undefined,
          onChange: (text) => {
            dirty.current = true
            setFieldError({ field: '', text: '' })
            setRepeatCyclesText(text)
          },
        }),
        h(NumberField, {
          label: t('ui.loopGuard.repeatUniqueRatio'),
          hint: t('ui.loopGuard.repeatUniqueRatioHint'),
          value: repeatRatioText,
          disabled: locked,
          error: fieldError.field === 'repeatRatio' ? fieldError.text : undefined,
          onChange: (text) => {
            dirty.current = true
            setFieldError({ field: '', text: '' })
            setRepeatRatioText(text)
          },
        }),
        h(NumberField, {
          label: t('ui.loopGuard.repeatGramRatio'),
          hint: t('ui.loopGuard.repeatGramRatioHint'),
          value: repeatGramRatioText,
          disabled: locked,
          error: fieldError.field === 'repeatGramRatio' ? fieldError.text : undefined,
          onChange: (text) => {
            dirty.current = true
            setFieldError({ field: '', text: '' })
            setRepeatGramRatioText(text)
          },
        }),
        h('div', { style: { borderTop: `1px solid ${TOKEN.border}`, paddingTop: 10 } },
          h(Toggle, {
            checked: lowerEffort,
            disabled: locked,
            label: t('ui.loopGuard.lowerEffort'),
            onChange: (next) => sendConfig({ lowerEffortOnRetry: next }, 'lowerEffort'),
          }),
          h('p', { style: HINT_STYLE }, t('ui.loopGuard.lowerEffortHint')),
        ),
      )

      // 4) 统计
      const statsCard = h(Card, {
        key: 'stats',
        title: t('ui.loopGuard.stats'),
        extra: h(Button, { disabled: locked, onClick: resetStats }, t('ui.loopGuard.reset')),
      },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          h(Stat, { label: t('ui.loopGuard.statAttempts'), value: count(stats.attempts) }),
          h(Stat, { label: t('ui.loopGuard.statGuarded'), value: count(stats.guarded), color: TOKEN.warn }),
          h(Stat, { label: t('ui.loopGuard.statRetries'), value: count(stats.retriesAllowed) }),
          h(Stat, { label: t('ui.loopGuard.statStops'), value: count(stats.terminalStops) }),
          h(Stat, { label: t('ui.loopGuard.statSaved'), value: formatDuration(stats.savedMs), color: TOKEN.success }),
        ),
        h('div', { style: { marginTop: 10 } },
          h('div', { style: { fontSize: 11, color: TOKEN.dim, marginBottom: 4 } }, t('ui.loopGuard.byRule')),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            ...RULE_ORDER.map((rule) => h(Stat, {
              key: rule,
              label: t(RULE_LABEL_KEY[rule]),
              value: count(byRule[rule]),
            })),
          ),
        ),
      )

      // 5) 最近触发
      const cell = { padding: '5px 8px', fontSize: 12, color: TOKEN.text, whiteSpace: 'nowrap' }
      const headCell = { ...cell, fontSize: 11, color: TOKEN.dim, fontWeight: 600 }
      const recentRows = recent.length === 0
        ? [h('tr', { key: 'empty' },
          h('td', { colSpan: 5, style: { ...cell, color: TOKEN.dim } }, t('ui.loopGuard.recentEmpty')),
        )]
        : recent.map((entry, index) => h('tr', {
          key: `${entry && entry.at}-${index}`,
          title: entry && entry.code ? String(entry.code) : undefined,
          style: { borderTop: `1px solid ${TOKEN.border}` },
        },
          h('td', { style: cell }, formatAt(entry && entry.at)),
          h('td', { style: cell }, `${(entry && entry.turn) ?? '—'}/${(entry && entry.step) ?? '—'}`),
          h('td', { style: cell }, count(entry && entry.reasoningDeltas)),
          h('td', { style: cell }, formatDuration(entry && entry.elapsedMs)),
          h('td', { style: cell }, count(entry && entry.productiveDeltas)),
        ))

      const recentCard = h(Card, { key: 'recent', title: t('ui.loopGuard.recent') },
        h('div', { style: { overflowX: 'auto' } },
          h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
            h('thead', null,
              h('tr', null,
                h('th', { style: { ...headCell, textAlign: 'left' } }, t('ui.loopGuard.colAt')),
                h('th', { style: { ...headCell, textAlign: 'left' } }, t('ui.loopGuard.colTurnStep')),
                h('th', { style: { ...headCell, textAlign: 'right' } }, t('ui.loopGuard.colDeltas')),
                h('th', { style: { ...headCell, textAlign: 'right' } }, t('ui.loopGuard.colElapsed')),
                h('th', { style: { ...headCell, textAlign: 'right' } }, t('ui.loopGuard.colProductive')),
              ),
            ),
            h('tbody', null, ...recentRows),
          ),
        ),
      )

      return h('div', { style: { padding: '4px 2px 16px' } },
        head,
        errorBox,
        h('p', { style: { ...HINT_STYLE, margin: '0 0 12px' } }, t('ui.loopGuard.intro')),
        enableCard,
        thresholdCard,
        statsCard,
        recentCard,
      )
    }

    return {
      inject: ['slots'],

      apply(ctx) {
        // slots.inject 会等 `settings.section` 的声明落到 ledger 上再执行回调，
        // 所以设置外壳还没挂载时也不会注册失败。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'loop-guard',
          order: 45,
          label: () => t('ui.loopGuard.nav'),
        }, LoopGuardSection))
      },
    }
  },
})
