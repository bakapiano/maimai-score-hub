- [] B50 / level / 版本 图片生成 展示个人信息 + summary（多少 sss / sss+ ）
- [] 分数更新速度（dx net）检测，网卡的时候不推荐更新分数
- [] 代理导入支持 / 代理模式下的 ravail / 收藏更新
- [] 自定义分数模板 / 分享 / 生成图片（如 AP 50）
- [] 铺面详细 / 游玩人数 / 铺面评论 / rank
- [] 中二支持
- [] 离线模式 - 仅使用前端 cache 在服务器挂了的时候
- [] 后台直接 upsert TODO list
- [] fix lynx 数据源（线上 version 没法正确map， why？）(落雪的 dx 谱 id 和水鱼的有出入)
- [] add "https://dxrating.net/search" as source
- [] Support for international ver?
- [] https://userjot.com/ - track user feedback
- [] 加一个 dev 环境用的 bot
- [] proxy 登陆用前端独立出来（proxy 项目独立出来）(不确定是否有必要？)
- [] worker log 后台监控 / 后台管理 worker / 手动移除 worker
- [] job cancel
- [] 成绩更新完成后自动导入到 水鱼 or 落雪
- [] job 最长 timeout(一小时？)
- [] https://github.com/Lxns-Network/maimai-prober-frontend/blob/bbaa066ba0f2d06ced0a9f5306ac55a52195b1c2/src/pages/public/Chart.tsx#L390 铺面预览?
- [] 所有铺面 search by name
- [] 更新完成自动导出水鱼
- [] 白 link 无法导入
- [] 登陆后保持一段时间好友
- [] 可选更新难度
- [] 支持不登陆状态下，直接公众号发送好友请求给 bot 来更新
- [] 容量瓶颈再来一次：把 auto-update score 完全切成 sdgb get_rival_music
  路径（成绩从 cabinet 拿，零 friend-VS 请求）；fc/fs 信息单独跑
  低频 background 任务（每天 1 次 / 用户）通过 friend-VS 补一次。
  适用条件：当前优化（cabinet 砍一半 + diff skip）已经把单 job 砍到
  3 req 平均，理论容量 ~2700 user。如果未来 user 涨到 ~2000+ 开始撞
  天花板（567 频繁 / sweep 撑不完），再做这个。预期收益：score
  scrape 几乎 0 friend-VS → 容量再上一个数量级。
  风险：fc/fs 滞后一天；要新加 cron 调度逻辑 + bot 仍然要被加好友
  才能跑 friend-VS。

06/21

[] 完全删除 二维码登录？get user rival list 不需要 auth -> dx net add rival -> get user rival list 反查 user id
[] dx net 添加好友时自动更新（有点鸡肋 都有自动更新了）
[] oauth 三方站接入

[] b50 直出功能 - 从没账号到直接生成 b50 图片
[] 前端添加 eslint check

07/04
[]现在的 bot pick 逻辑会导致 job 倾泻到 负载最低的那个 bot 上
[]考虑 平均分配

[] 前端 fc > fc+ > ap > ap+ 统计数量的时候计数有问题

07/11
[] OCR 封面 / 曲名
[] 二维码更新成绩
[] 别名搜索
[] recovry 信号触发 or 监测是否留在网页
[] 二维码可以直接创建账号 不再要求绑死 freidn code / 后续可通过额外触发 job 再次绑定 freidn code

07/17
[] 主键稳定到 user id，而不是 friend code（fuck 为啥以前用这个当主键）
[] 避免不合法 friend code 创建更多 user item
[] auto update -> full update, 考虑找到更新的铺面（rival change 、 fc change，然后只更新对应难度）减少 dx net api call

07/18
[] 用户画像 - 比如用户是 绿 / 黄 铺面玩家，自动更新触发 绿黄，红紫白类似

07/20
[] clean up docker 镜像 定期
[] TODO 重构 铺面详细
