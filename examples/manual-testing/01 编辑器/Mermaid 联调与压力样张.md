# Mermaid 联调与压力样张

这四张图覆盖发布、代码结构、数据流和项目推广。可以连续修改两张图，在编辑与预览间切换，再滚到文末回到第一张图，检查预览与保存结果。

## 有回滚的发布计划

把「小流量灰度」从一天改为三天，观察后续任务是否顺延。再给「批准上线」增加一项依赖，例如 `after verify reconcile`。

```mermaid
gantt
  title 支付版本发布计划
  dateFormat YYYY-MM-DD
  axisFormat %m/%d
  excludes weekends
  section 准备
  冻结需求          :milestone, freeze, 2026-11-23, 0d
  数据迁移演练      :done, migrate, after freeze, 2d
  汇总兼容性清单    :done, audit, after freeze, 2d
  section 验证
  集成测试         :crit, verify, after migrate audit, 3d
  对账与补偿演练   :reconcile, after migrate, 2d
  批准上线         :milestone, approve, after verify, 0d
  section 发布
  小流量灰度       :active, canary, after approve, 1d
  逐步放量         :crit, rollout, after canary, 2d
  稳定性观察       :monitor, after rollout, 2d
  section 回滚准备
  保留旧版消费者    :retain, after canary, 4d
  验证降级开关      :fallback, after approve, 2d
```

## 文档保存与并发冲突

为 `SaveQueue` 增加一个 `cancel` 方法，再为 `LocalStore` 增加一个云端实现，观察结构和多种关系线的排布。

```mermaid
classDiagram
  direction LR
  class DocumentSession {
    +String path
    +int revision
    +applyChange(change)
    +flush()
  }
  class SaveQueue {
    -int pendingCount
    +enqueue(snapshot)
    +retry()
  }
  class Snapshot {
    +int revision
    +String contentHash
  }
  class Storage {
    <<interface>>
    +read(path)
    +write(snapshot)
  }
  class LocalStore {
    +read(path)
    +write(snapshot)
  }
  class ConflictResolver {
    +merge(base, local, remote)
  }
  class HistoryLog {
    +append(snapshot)
    +recent()
  }
  DocumentSession *-- SaveQueue : 管理
  DocumentSession --> ConflictResolver : 处理冲突
  SaveQueue o-- "0..*" Snapshot : 等待保存
  SaveQueue --> Storage : 写入
  LocalStore ..|> Storage : 实现
  ConflictResolver ..> Snapshot : 比较
  HistoryLog o-- "0..*" Snapshot : 保留历史
  DocumentSession --> HistoryLog : 记录
```

## 注册到付费的流量分布

把 `Organic Search` 到 `Activated` 的数量从 420 改为 460，并将对应的 `Not Activated` 人数减少 40。再调整这两个节点的下游数量，使流入和流出相等。

```mermaid
sankey-beta
Organic Search,Activated,420
Organic Search,Not Activated,180
Content Recommendations,Activated,300
Content Recommendations,Not Activated,80
Invitations,Activated,190
Invitations,Not Activated,25
Activated,Trial,350
Activated,Direct Purchase,210
Activated,Free Tier,350
Not Activated,Reengagement,120
Not Activated,Churn,165
Trial,Team Plan,140
Trial,Personal Plan,115
Trial,Free Tier,95
Direct Purchase,Team Plan,130
Direct Purchase,Personal Plan,80
Reengagement,Returned,55
Reengagement,Churn,65
```

## 双版本维护与补丁回迁

把「保存冲突提示」改成 `type: HIGHLIGHT`，再给维护分支加第二次回迁。可以将这段连同外层 Markdown 围栏一起复制，粘贴替换另一张 Mermaid 图的全部源码。

```mermaid
gitGraph
  commit id: "初始化"
  commit id: "保存队列"
  branch release
  checkout release
  commit id: "发布 1.2" tag: "v1.2.0"
  checkout main
  branch editor
  checkout editor
  commit id: "拆分编辑与预览"
  commit id: "保存冲突提示"
  checkout main
  merge editor id: "合并编辑改动"
  branch hotfix
  checkout hotfix
  commit id: "修复旧版本加载" type: HIGHLIGHT
  checkout main
  merge hotfix id: "主线应用修复"
  checkout release
  cherry-pick id: "修复旧版本加载"
  commit id: "发布 1.2.1" tag: "v1.2.1"
  checkout main
  commit id: "发布 1.3" tag: "v1.3.0"
```
