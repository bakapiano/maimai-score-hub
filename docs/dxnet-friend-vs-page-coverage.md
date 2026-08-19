# DX NET Friend VS 页面覆盖实测

最后更新：2026-08-18（Asia/Shanghai）

本文记录 DX NET Friend VS 按难度（`diff`）、类别（`genre`）和等级
（`level`）切页时能够覆盖的乐曲/谱面数量，以及已完成的 HTTP 响应体大小
实测。数据用于评估大页面失败后的 fallback 切页策略。

## 测量口径

- 等级页 HTTP 目标账号：`634142510810999`（用户确认属于本人）。
- 类别页 HTTP 大小样本：同一生产曲库下的受控 Friend VS 账号样本；覆盖行数
  由生产曲库和多次页面抓取共同确认。账号展示信息只会造成小幅字节波动。
- HTTP `scoreType`：`2`（达成率）。
- HTTP `side`：`all`。
- 页面行数：Worker 的 `parseFriendVsSongs()` 实际解析结果长度。
- 页面大小：`Buffer.byteLength(html)`，单位为字节。
- 等级页：2026-08-17 通过生产 Bot 执行 `add_rival` 后逐页实测。
- Parser fixture：2026-08-18 使用 101 Worker 当前 Cookie 获取真实 `level=1`
  页面，脱敏后固定为 12 行测试样本。
- 类别页：2026-08-16/17 生产 Friend VS 页面实测；大小表采用 MASTER
  (`diff=3`) 的完整成功样本。
- `diff × genre`：2026-08-17 生产 MongoDB `musics` 集合聚合，使用实际
  chart 数量；MASTER 的六个类别均由 HTTP 实测交叉验证。

“页面行数”和“去重曲名”是两个不同口径：同名的 Standard/DX 乐曲会产生
不同页面行，但去重曲名只计一次。

## 结论摘要

| 切页方式 | 页数 | 覆盖行数 | 响应体合计 | 最大单页 |
|---|---:|---:|---:|---:|
| 单个普通 `diff` 按 6 个 `genre` | 6 | 1,319 | 2,426,605 B（MASTER 实测） | 692,767 B（genre 105） |
| 全部普通谱面按 23 个 `level` | 23 | 5,405（HTTP 实测） | 9,931,177 B | 852,893 B（等级 13） |
| UTAGE (`diff=10`) | 1 | 60 | 本轮未记录 | 60 行 |

生产曲库包含 5,408 个普通 chart。等级页 HTTP 实测返回 5,405 行；等级
`5`、`8`、`14+` 分别比曲库 chart 数少 1 行。类别×难度矩阵覆盖全部
5,408 个普通 chart。UTAGE 的 60 行通过 `diff=10` 独立覆盖。

## diff 覆盖

| diff | 难度 | 版本化页面行 | 去重曲名 | 说明 |
|---:|---|---:|---:|---|
| 0 | BASIC | 1,319 | 1,262 | 六个 genre 之和 |
| 1 | ADVANCED | 1,319 | 1,262 | 六个 genre 之和 |
| 2 | EXPERT | 1,319 | 1,262 | 六个 genre 之和 |
| 3 | MASTER | 1,319 | 1,262 | 六个 genre 之和；页面大小已完整实测 |
| 4 | Re:MASTER | 132 | 132 | 六个 genre 之和 |
| 10 | U・TA・GE | 60 | 60 | `genre=99` 独立页；level 页不包含该组 |

普通难度 0–3 每首版本化乐曲均有对应 chart，因此每个 diff 的类别分布
相同。Re:MASTER 只有实际配置 Re:MASTER chart 的 132 个条目。

## genre 覆盖与页面大小

以下响应体大小来自 `scoreType=2`、`diff=3` 的生产 HTTP 成功响应。

| genre | 类别 | 页面行 | 去重曲名 | 响应体字节 | KiB |
|---:|---|---:|---:|---:|---:|
| 101 | 流行&动漫 | 88 | 88 | 172,354 | 168.3 |
| 102 | niconico＆VOCALOID™ | 319 | 302 | 579,154 | 565.6 |
| 103 | 东方Project | 153 | 138 | 287,749 | 281.0 |
| 104 | 其他游戏 | 241 | 234 | 441,336 | 431.0 |
| 105 | 舞萌 | 384 | 367 | 692,767 | 676.5 |
| 106 | 音击/中二节奏 | 134 | 133 | 253,245 | 247.3 |
| **合计** |  | **1,319** | **1,262** | **2,426,605** | **2,369.7** |

类别页大小与页面行数近似线性；单行 HTML 通常约 1.8 KB。用户成绩数字、
Bot/用户展示信息会让同一页面的字节数产生小幅波动。

## diff × genre 覆盖矩阵

表内数字为版本化乐曲 chart 行数。

| genre | 类别 | BASIC | ADVANCED | EXPERT | MASTER | Re:MASTER | 普通 chart 合计 |
|---:|---|---:|---:|---:|---:|---:|---:|
| 101 | 流行&动漫 | 88 | 88 | 88 | 88 | 15 | 367 |
| 102 | niconico＆VOCALOID™ | 319 | 319 | 319 | 319 | 31 | 1,307 |
| 103 | 东方Project | 153 | 153 | 153 | 153 | 14 | 626 |
| 104 | 其他游戏 | 241 | 241 | 241 | 241 | 16 | 980 |
| 105 | 舞萌 | 384 | 384 | 384 | 384 | 53 | 1,589 |
| 106 | 音击/中二节奏 | 134 | 134 | 134 | 134 | 3 | 539 |
| **合计** |  | **1,319** | **1,319** | **1,319** | **1,319** | **132** | **5,408** |

当某个普通难度的 `genre=99` 全量页失败时，请求 101–106 六页可以完整覆盖
该难度。UTAGE 使用独立的 `diff=10` 页面。

## level 覆盖与页面大小

等级参数共有 23 个值。`曲库去重曲名`来自同一时点生产曲库；HTTP 行数和
响应体字节来自目标账号的实际 Friend Level VS 页面。

| level 参数 | 显示等级 | HTTP 行数 | 曲库去重曲名 | 响应体字节 | KiB |
|---:|---|---:|---:|---:|---:|
| 1 | 1 | 12 | 12 | 38,525 | 37.6 |
| 2 | 2 | 114 | 114 | 217,296 | 212.2 |
| 3 | 3 | 280 | 278 | 508,875 | 496.9 |
| 4 | 4 | 336 | 333 | 607,801 | 593.6 |
| 5 | 5 | 339 | 340 | 613,309 | 598.9 |
| 6 | 6 | 434 | 428 | 782,031 | 763.7 |
| 7 | 7 | 338 | 334 | 615,593 | 601.2 |
| 8 | 7+ | 312 | 309 | 569,661 | 556.3 |
| 9 | 8 | 275 | 274 | 503,794 | 492.0 |
| 10 | 8+ | 155 | 154 | 291,277 | 284.5 |
| 11 | 9 | 151 | 151 | 283,855 | 277.2 |
| 12 | 9+ | 171 | 171 | 319,045 | 311.6 |
| 13 | 10 | 190 | 190 | 352,274 | 344.0 |
| 14 | 10+ | 228 | 227 | 419,819 | 410.0 |
| 15 | 11 | 199 | 198 | 367,605 | 359.0 |
| 16 | 11+ | 187 | 186 | 347,274 | 339.1 |
| 17 | 12 | 219 | 217 | 402,735 | 393.3 |
| 18 | 12+ | 360 | 352 | 652,550 | 637.3 |
| 19 | 13 | 473 | 453 | 852,893 | 832.9 |
| 20 | 13+ | 357 | 347 | 647,890 | 632.7 |
| 21 | 14 | 198 | 193 | 366,542 | 357.9 |
| 22 | 14+ | 75 | 72 | 149,466 | 146.0 |
| 23 | 15 | 2 | 2 | 21,067 | 20.6 |
| **合计** |  | **5,405** |  | **9,931,177** | **9,698.4** |

等级页最大的是等级 13：473 行、852,893 B。等级 6、12+、13+ 也超过
600 KiB。按等级抓取的总响应体约 9.47 MiB，并需要 23 次 HTTP 请求。

## 对 fallback 设计的含义

1. 单个 `diff` 失败时，`genre=101..106` 是较小且完整的六页切分。
2. `level=1..23` 能一次覆盖普通难度的绝大多数 chart，但页数和总流量更大，
   最大单页也大于 genre 105。
3. 等级页的 HTTP 实测比生产曲库少 3 行，因此将等级路径作为唯一事实来源时
   需要处理缺口；类别×难度路径覆盖生产曲库全部 5,408 个普通 chart。
4. UTAGE 不属于数值等级页覆盖范围，继续使用 `diff=10` 独立抓取。
5. 页面内容按账号成绩变化，字节数适合作为容量基线，行数用于覆盖正确性。

### 高峰期大页面拆分（2026-08-19）

- 普通 `diff` 的 `genre=99` 整页只尝试一次，总超时为 150 秒；101 实测
  2,344,863 B / 1,319 行页面在 125,465ms 完整返回。首次出现
  `terminated/timeout` 等传输错误时立即进入 genre fallback。UTAGE (`diff=10`)
  继续使用独立的普通重试策略。
- 整 diff 页面因 `terminated/timeout` 进入 genre fallback 后，genre 102
  （319 行、579,154 B）和 genre 105（384 行、692,767 B）从第一轮起就拆成
  `winOnly`、`loseOnly`、`winOnly+loseOnly` 三页；最后一种参数组合已由 101
  实测确认恰好返回平局集合。其他 genre 第一轮请求 all 页，传输失败后的第
  2、3 轮改用三页拆分。
- level 18/19/20（显示等级 12+/13/13+）从第一轮起使用三页拆分；其他 level
  第一轮使用 all 页，第 2、3 轮使用三页拆分。
- 每个逻辑页面最多三轮（含初始轮）。三分片分别保存成功结果，后续轮次只重试
  失败分片，三页完整后合并为一个逻辑 genre/level 页面缓存和消费。
- 触发原因是高峰期响应体更容易在传输中途出现 `TypeError: terminated`、
  `ECONNRESET` 或 timeout；生产上也出现过 153 行的 genre 103 页面和已经拆小的
  genre 102 lose 分片连续两次 `read ECONNRESET`，因此小页面同样使用三轮预算。
- 101 故障注入验收主动 abort 首个 all 请求：level 19 立即拆分为
  `1 + 217 + 255 = 473` 行；diff 4 进入 genre fallback 后，genre 102 拆分为
  `0 + 21 + 10 = 31` 行、genre 105 拆分为 `0 + 30 + 23 = 53` 行，均与基准完整覆盖一致。

### 2026-08-18 增量验证

新曲 `FLΛME/FRΦST` 在 `genre=105` 的 BASIC/ADVANCED 页面存在，在
EXPERT/MASTER 页面缺失；对应页面实测分别为 384、384、383、383 行。
同一谱面的 EXPERT 与 MASTER 分别存在于 `level=18`（360 行）和
`level=22`（76 行）页面。planner 权重据此更新。页面覆盖会因 Bot 解锁状态
产生差异；执行器只请求 planner 选中的页面。自动 `fcfsOnly` 提交其余已覆盖
谱面并记录告警，缺失谱面由后续活动信号或每日全量更新再次覆盖。普通
targeted 更新保持严格完整性检查。

## 参数映射

```text
Friend Genre VS:
  /friend/friendGenreVs/battleStart/
  ?scoreType={1|2}&genre={99|101..106}&diff={0|1|2|3|4|10}&idx={friendCode}

Friend Level VS:
  /friend/friendLevelVs/battleStart/
  ?scoreType={1|2}&level={1..23}&idx={friendCode}
```

## 定向抓取规划器

`update_score.musicIds` 使用谱面级 `charts[].cid`（例如 `100_3`）。Backend
把每个 CID 解析为 `{ title, type, category, diff, genre, level }`，Worker
把目标谱面建模成二分图：

- 左侧顶点：具体 `diff + genre` 页面，权重为上表对应 chart 行数；
- 右侧顶点：具体 `level` 页面，权重为上表 HTTP 行数；
- 每个目标谱面是一条边，连接能覆盖它的 genre 页和 level 页。

规划器通过最小割求精确的最小权二分图顶点覆盖，主目标是最少扫描行数，
相同行数下选择更少页面。普通谱面的 genre 候选固定为 101–106；UTAGE
只有 `diff=10/genre=99` 候选。Level HTTP 页的三行实测缺口由执行期覆盖检查
处理：目标 CID 在 level 结果中缺失时，补抓对应的具体 `diff + genre` 页。

`diffsToScrape` 与 `musicIds` 是两种互斥的更新目标。前者按难度抓取，后者按
特定谱面规划 genre/level 页面；同时传入会在 API 契约和 JobService 两层被拒绝。
两者均省略时默认抓取 `[2,3,4,10]`，明确全量的调用方传入
`[0,1,2,3,4,10]`。

`fcfsOnly=true` 独立于上述目标选择：它把 scoreType 请求集合从 `{1,2}` 收敛为
`{2}`，Worker 只返回 FC/FS 字段；目标规划方式保持一致。主要组合均有固定测试：

| diffsToScrape | musicIds | fcfsOnly | 行为 |
|---|---|---|---|
| 省略 | 省略 | false | 默认四个难度、两个 scoreType |
| 有值 | 省略 | true | 指定难度、单个 scoreType、只合并 FC/FS |
| 省略 | 有值 | false | 最优 genre/level 页面、两个 scoreType、只返回目标 CID |
| 省略 | 有值 | true | 最优 genre/level 页面、单个 scoreType、只返回目标 CID 的 FC/FS |

## 真实 E2E 验收（2026-08-18）

本地隔离 Mongo/Redis + dev Backend + real sdgb-worker + DXNet Worker 启动后，
通过 SSH 转发到 101 容器的直连代理，并使用 101 当前 Cookie 完成：

```text
background claim update_score
  -> sdgb add_rival returnCode=2/2
  -> cabinetFriendship pending -> ready
  -> target musicIds=[11113_0], fcfsOnly=true
  -> planner chooses level=1
  -> completed in 2608ms
```

最终 Worker result 为：

```json
{
  "targetedScores": [
    { "musicId": "11113_0", "fc": null, "fs": null }
  ]
}
```

结果包含目标 CID 和 FC/FS 字段，achievement/DX Score 字段保持缺省；Backend
commit-first finalization 正常完成。隔离数据库、Redis Job key、临时 Cookie、SSH
转发与本地进程均在验收后清理，101 Bot 最终恢复 `available=true` 和 6 条 consumer。

生产 rollout 使用 `AUTO_UPDATE_TARGETED_FCFS_ENABLED=false` 作为兼容桥：先发布
Backend schema/legacy-job retirement，再发布支持新字段的 DXNet Worker，最后设置为
`true` 激活半小时 producer，避免旧 Worker 把 targeted Job 当成全量抓取。
