# 安装、升级与卸载

对象：`dsh-loop-guard` **v0.5.1**（DSH 插件，宿主半区 + 浏览器设置页）。本文对应的源码快照：`index.js` **`d3041377d613d1c8`** / **1987 行 / 89,041 B**（完整 sha256 `d3041377d613d1c88e674b199457b131422ac4b7eb2aca61ab4d56907339536f`）。

> **发布状态**：本包**未发布到 npm**（`package.json` 里 `private: true`，且 `files` 清单不含 `docs/`）。请**从 git 仓库克隆后按本地目录安装**（§2.1），或用 §2.2 的 git 地址安装。

本文所有「实测」都标注了采集时间；命令里的 `<宿主端口>` 请替换成你的实际端口（本机 GUI 是 `http://127.0.0.1:64204`）。

---

## 1. 前置要求

| 项 | 要求 | 说明 |
|---|---|---|
| DSH 宿主 | 能正常启动、且环境里有 `plugin_manager` 工具 | 安装走的就是它 |
| Node | 宿主自带的运行时即可 | 插件**无第三方依赖**，只用 Node 内置模块 |
| 可选服务 | `webServer` | 只在你想用设置页时需要。**缺了守卫照常工作**，只是没有界面 |
| 权限 | 能写 profile 目录 | 安装会往 profile 的 `cordis.yml` / `cordis.patch.yml` 里落一行 |

插件包内含：`index.js`（宿主半区）、`client.js`（设置页）、`cordis.patch.yml`（bundle 补丁）、`locale/zh.json`、`locale/en.json`、`icon.svg`、`README.md`、`docs/`。

---

## 2. 安装

### 2.1 从本地目录安装（开发/自用）

```
plugin_manager action=install_bundle target="D:\ai aegit\deepseek\dsh-loop-guard"
```

### 2.2 从仓库安装（拿到公开仓库之后）

本包**未发布到 npm**，所以只有 git 一条路：克隆到本地，再用上面的绝对路径安装。

```
git clone <仓库地址> dsh-loop-guard
plugin_manager action=install_bundle target="<克隆下来的绝对路径>"
```

> 本文档**没有实测过**从远端仓库克隆安装的链路（见 README §11 未验证项）；**本地目录安装已实测**（§4）。`package.json` 里 `private: true`，只挡 `npm publish`，不影响 GitHub 可见性。

### 2.3 这一步实际做了什么

bundle 补丁只插入**一行**：

```yaml
- insert:
    - id: loop-guard
      name: 'dsh-loop-guard'
      config: {}
```

`config: {}` 表示**全部使用默认值**（16 个键的默认值见 [CONFIG.md](CONFIG.md)）。安装后 profile 的 `cordis.yml` 里会出现这一行（本机实测，profile 快照中 `id: loop-guard` / `name: dsh-loop-guard` / `config: {}`）。

---

## 3. 重启宿主

**装完必须重启一次 DSH 宿主。**

原因（不是迷信）：宿主对 `dsh.client`（浏览器半区）的扫描是**增量**的，否定结论会缓存到进程重启。不重启的话，宿主半区可能已经生效，但**设置页进不了浏览器的 boot graph**（表现为：左侧导航里没有「循环守卫」）。

| 你想要的效果 | 需要重启吗 |
|---|---|
| 守卫开始工作（宿主半区） | 通常不需要；但**重启最保险** |
| 设置页出现 | **必须重启一次** |
| 之后改 `cordis.patch.yml` 里的 config | 需要让该行重载（见 §8） |
| 之后改设置页里的值 | **不需要**（立即生效并写盘） |

---

## 4. 验证：怎么确认真的装上了、真的在跑

### 4.1 看设置页（最直观）

`设置` → 左侧导航应出现 **「循环守卫」**。页面每 5 秒刷新一次，能看到：总开关、11 个阈值输入框、降档开关、统计、按规则分布、最近触发。

### 4.2 问宿主（可脚本化）

```bash
curl -s http://127.0.0.1:<宿主端口>/loop-guard/state
```

**本机实测输出**（2026-10-19 19:36 与 19:40 两次采集，端口 64204）：

| 字段 | 实测值 |
|---|---|
| `ok` | `true` |
| `value.enabled` | `true` |
| `value.config` | **12 个键**，值与默认值完全一致（`reasoningChunkLimit: 20000`、`attemptBudgetMs: 1800000`、`stallTimeoutMs: 180000`、`noOutputMs: 600000`、`repeatWindowChars: 6000`、`repeatMinChars: 1000`、`repeatMinLines: 30`、`repeatCycles: 6`、`repeatUniqueRatio: 0.2`、`repeatGramRatio: 0.1`、`maxGuardedRetries: 1`、`lowerEffortOnRetry: true`） |
| `value.stats.attempts` | **69 → 81**（相隔约 4 分钟，随对话增长） |
| `value.stats.guarded` | `0` |
| `value.stats.retriesAllowed` / `terminalStops` / `savedMs` | `0` |
| `value.stats.byRule` | 五条规则全为 `0` |
| `value.recent` | `[]` |

**判读方法**：

- `attempts` **会随你每一次模型调用增长** → 说明 `llm/stream` 监听真的挂上了。
- `guarded` 长期为 `0` 是**正常**的：只有真的出现那四种坏形态（分片洪水 / 卡住不动 / 慢速渗流 / 输出退化重复）才会加一。
- `ok:false` 或 404 → 插件没装上，或者宿主没重启。
- 连接被拒 → 端口不对，或者宿主没在跑。

### 4.3 端到端自检（会真的掐断一次）

想确认「判定 + 掐断 + 止住重试」整条链路，可以临时把阈值调到**很容易命中**的值，然后随便发一轮对话：

```bash
# 1) 把「零分片沉默上限」调到 10 秒（下限），并允许 0 次纠正重试
curl -s -X POST http://127.0.0.1:<宿主端口>/loop-guard/config \
  -H 'content-type: application/json' \
  -d '{"stallTimeoutMs":10000,"maxGuardedRetries":0}'

# 2) 发一轮对话，观察
curl -s http://127.0.0.1:<宿主端口>/loop-guard/state

# 3) 恢复默认值（记得做）
curl -s -X POST http://127.0.0.1:<宿主端口>/loop-guard/config \
  -H 'content-type: application/json' \
  -d '{"stallTimeoutMs":180000,"maxGuardedRetries":1}'
```

> 注意：这一步会让**正常的慢响应也被掐断**。做完请务必恢复。
> 请求必须是 `content-type: application/json`（否则 415），且 `Origin` 头要么不写（curl 默认不写，放行）、要么与宿主同源（否则 403）。

---

## 5. 升级

1. 用新版本覆盖 `dsh-loop-guard/` 目录（或改 `package.json` 的 `version` 后重新安装）。
2. **重启宿主**（宿主半区与浏览器半区都要重载）。
3. 检查设置文件里是否有**新版本已不认识的键**（见下）。

**升级时的配置兼容**（下表全部是**实测**结果 —— 用真的 `apply()` + 桩上下文 + **临时**设置文件跑出来的，不是照抄注释；源码快照 `index.js` `d3041377d613d1c8` / v0.5.1）：

| 设置文件里的情况 | 实际行为 | 插件会挂载失败吗 |
|---|---|---|
| 文件不存在 | 静默，用 `cordis.patch.yml` 的值 | 不会 |
| 不是合法 JSON | **告警** + 忽略整个文件（退回 yml 的值） | 不会 |
| 内容不是对象（例如数组） | **告警** + 忽略整个文件 | 不会 |
| 有当前版本**不认识**的键 | **静默丢弃该键**（不告警） | 不会 |
| 键合法但**类型不对**（例如数字写成字符串） | **静默丢弃该键**（不告警） | 不会 |
| 键合法但**数值越界**（例如 `reasoningChunkLimit: 50`、`maxGuardedRetries: 99`、`repeatUniqueRatio: 5`） | **忽略该值 → 退回 `cordis.patch.yml` 的值 + 一条告警** | **不会** |
| 键合法但**不是整数**（例如 `repeatCycles: 6.5`） | **忽略该值 → 退回 `cordis.patch.yml` 的值 + 一条告警** | **不会** |
| `repeatMinChars > repeatWindowChars`（跨字段，**合并后**判定） | **夹紧到窗口大小 + 告警**（唯一一个「夹紧」的键关系；单键越界与「单键各自合法但合起来越界」**两条路径都走这里**） | 不会 |
| 门槛比**出厂默认窗口 6000** 大、但**没超过生效窗口**（例如 yml 窗口 30000 + 门槛 20000） | **正常生效，无告警**（判越界看的是**生效窗口**，不是默认 6000） | 不会 |
| `cordis.patch.yml` 里写了不存在的键 | **直接抛错**（不静默兜底） | **会**（这一行加载失败） |

> 两条要点：
> 1. **设置文件是「宽进」的** —— 里面写什么都不会让插件挂载失败，设置页一定打得开；坏值只会被「**退回 yml 的值**」（单键越界）或「**夹紧到生效窗口**」（合并后越界）并留一条告警（一个坏键一条）。这样你永远有界面手段自救。
> 2. **`cordis.patch.yml` 是「严进」的** —— 它是你手写的配置，未知键/类型错/越界都会抛错并让这一行加载失败。这是故意的：静默忽略你写的配置比报错更糟。

想「升级后回到默认值」：删掉设置文件 + 重启（见 §7）。

---

## 6. 卸载

```
plugin_manager action=remove_bundle target="dsh-loop-guard"
```

然后**重启宿主**。

**卸载后的残留**（照实列）：

| 残留 | 位置 | 要不要清 |
|---|---|---|
| 设置文件 | `$DSH_HOME/loop-guard-settings.json`（`DSH_HOME` 未设时是 `~/.dsh/loop-guard-settings.json`；本机实测在 `C:\Users\momol\.dsh\loop-guard-settings.json`，345 字节、13 个键） | 想彻底干净就删掉它 |
| profile 里的那一行 | profile 的 `cordis.yml` | `remove_bundle` 会处理；若手工改过 yml，请自行确认 |
| 统计 | 无 | **统计只在内存里，不落盘**，重启即消失 |

---

## 7. 设置文件

| 项 | 值 |
|---|---|
| 路径 | `$DSH_HOME/loop-guard-settings.json`；`DSH_HOME` 未设置时退化为 `~/.dsh/loop-guard-settings.json` |
| 可用 `settingsPath` 覆盖 | 是（只能写在 `cordis.patch.yml` 里） |
| 内容 | **13 个键**：`enabled` + 11 个阈值 + `lowerEffortOnRetry` |
| 写入方式 | 原子写（临时文件 + 重命名），保存失败只**告警**、不抛错（不会因为写不了盘就把宿主弄崩） |
| 读取时机 | **只在插件挂载时读一次** |

**本机实测的文件内容**（2026-10-19 19:34:18，345 字节）：

```json
{
  "enabled": true,
  "reasoningChunkLimit": 20000,
  "attemptBudgetMs": 1800000,
  "stallTimeoutMs": 180000,
  "noOutputMs": 600000,
  "repeatWindowChars": 6000,
  "repeatMinChars": 500,
  "repeatMinLines": 30,
  "repeatCycles": 6,
  "repeatUniqueRatio": 0.2,
  "repeatGramRatio": 0.1,
  "maxGuardedRetries": 1,
  "lowerEffortOnRetry": true
}
```

> **一条实测到的注意事项**：采集这个文件时它是 `repeatMinChars: 500`，而**同一时刻运行中的实例**通过 `/loop-guard/state` 报的是 `1000`。原因不是 bug，是机制：**文件只在挂载时读一次**，所以运行中的实例用的是它启动时读到的内存值，之后写盘只是「把自己的内存值存下来」。如果你看到文件和 `/state` 不一致，**重启宿主**让两边对齐（重启后以文件为准）。
>
> 另外：这个文件的路径**与 profile 无关**（只按 `$DSH_HOME` 定位），所以**多开宿主 / 多 profile 会共用同一份设置文件**，各自写盘时会互相覆盖。

**备份 / 迁移**：直接复制这个 JSON 文件即可。**恢复出厂**：删掉它 + 重启（之后就完全按 `cordis.patch.yml` 里的值走）。

---

## 8. 改了源码之后怎么让它生效

`cordis.yml` 的 hmr 配置是 `root: []` —— **没有任何监听目录**，所以：

| 改了什么 | 怎么生效 |
|---|---|
| `index.js`（宿主半区） | 重载那一行，或直接重启宿主 |
| `client.js` / `locale/*.json`（浏览器半区） | 重启宿主 + **刷新浏览器页面** |
| `cordis.patch.yml` 里的 `config` | 重载那一行。注意重载 = **重新挂载** → 会**重新读设置文件**，而设置文件优先于 yml。所以：**如果那个键在设置文件里也有值，改 yml 是没用的** —— 先把该键从设置文件里删掉（或删掉整个文件），再重载 |

重载那一行的办法（关掉再打开）：

```
plugin_manager action=set_plugin target="include:loop-guard" enabled=false
plugin_manager action=set_plugin target="include:loop-guard" enabled=true
```

> `set_plugin` 的 entry id 格式是 `include:<补丁里的 id>`，也就是 `include:loop-guard`。写裸 `loop-guard` 会报 `unknown-plugin`。

---

## 9. 故障排查

| 现象 | 最可能的原因 | 怎么办 |
|---|---|---|
| 设置页左侧没有「循环守卫」 | 装完没重启宿主；浏览器半区没进 boot graph | 重启宿主，然后刷新页面。仍没有就检查 profile 里那一行是否存在 |
| `/loop-guard/state` 返回 404 | 插件没装 / 那一行没启用 / `webServer` 服务缺失 | 先确认那一行存在且启用；没有 `webServer` 时**不会有任何路由**，守卫仍工作但没有界面 |
| `/loop-guard/state` 连接被拒 | 端口写错，或宿主没在跑 | 用 GUI 的地址栏确认端口 |
| `attempts` 一直是 0 | 宿主没重载到新代码，或 `enabled: false` | 看 `value.enabled`；是 `true` 就重载那一行 / 重启 |
| `attempts` 在涨但 `guarded` 一直是 0 | **正常** —— 你的会话没出现那四种坏形态 | 不用管。想确认判定可用 §4.3 的方法自检一次 |
| 界面改了值，重启后没记住 | 写盘失败（只告警不抛错）；或 `settingsPath` 指到了不可写的路径 | 看宿主日志里的告警；把 `settingsPath` 留空用默认路径 |
| 界面改了值，但感觉没生效 | 改的是 `settingsPath` / `maxRecent` / `debug`（**这三个界面里改不了**） | 这三个只能写在 `cordis.patch.yml` 里 |
| 手工改了设置文件但没生效 | **文件只在挂载时读一次** | 用设置页改，或重启宿主 |
| 手工改的设置值「没生效」 | 那个值是**坏的**（越界/非整数）→ 已被**退回 yml 的值** | 看宿主日志里那一条告警；把该键改回合法范围，或用设置页改 |
| 启动时报「未知的 config 键」 | `cordis.patch.yml` 里写了不存在的键 | 按报错里点名的可用键改；未知键**故意**抛错，不静默忽略 |
| 启动时报范围错 | `cordis.patch.yml` 里某个值越界（**设置文件里的越界值不会抛错**，只会告警 + 退回） | 按报错里的范围改（完整范围见 [CONFIG.md](CONFIG.md) §2） |
| `POST /loop-guard/config` 返回 415 | 没带 `content-type: application/json` | 加上这个头 |
| `POST /loop-guard/config` 返回 403 `bad-origin` | 请求带了与本机不同源的 `Origin` | 用同源页面，或干脆不带 `Origin`（curl 默认不带） |
| `POST /loop-guard/config` 返回 413 | 请求体超过 64 KiB | 只提交你要改的键，不要整份配置 |
| 改了 `index.js` 没反应 | hmr 没有监听目录 | 见 §8 |

---

## 10. 一页速查

```bash
# 安装
plugin_manager action=install_bundle target="D:\ai aegit\deepseek\dsh-loop-guard"

# 重启宿主（必须做一次）

# 验证：开关 + 12 个配置项 + 统计 + 最近触发
curl -s http://127.0.0.1:<宿主端口>/loop-guard/state

# 改配置（只提交要改的键；必须带 content-type）
curl -s -X POST http://127.0.0.1:<宿主端口>/loop-guard/config \
  -H 'content-type: application/json' -d '{"noOutputMs":900000}'

# 统计清零
curl -s -X POST http://127.0.0.1:<宿主端口>/loop-guard/reset \
  -H 'content-type: application/json' -d '{}'

# 重载插件那一行
plugin_manager action=set_plugin target="include:loop-guard" enabled=false
plugin_manager action=set_plugin target="include:loop-guard" enabled=true

# 卸载
plugin_manager action=remove_bundle target="dsh-loop-guard"
```
