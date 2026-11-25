# Mermaid 多场景编辑

点每张图右上角的「编辑」，左侧改源码，右侧看结果。每节列了两处可以改的地方。改完可撤销，或者关闭并重新打开文件核对保存结果。

## 跨团队订单履约

把 `LR` 改成 `TB`，观察方向和子图区的变化。再给「风险复核」加一条指向「取消订单」的拒绝分支。

```mermaid
flowchart LR
  subgraph customer[客户与客服]
    submit[提交订单] --> verify{收货信息完整？}
    verify -->|否| revise[补齐资料]
    revise -.-> submit
    verify -->|是| lock[锁定订单]
  end
  subgraph warehouse[仓储与客服协同]
    stock{库存充足？} -->|是| pick[生成拣货单]
    stock -->|否| split{客户接受拆单？}
    split -->|是| backorder[部分交付并登记缺货]
    split -->|否| cancel[取消订单]
    backorder --> pick
  end
  subgraph settlement[支付与物流]
    pay{授权通过？} -->|是| ship[生成运单]
    pay -->|否| review[风险复核]
    review -.-> pay
    ship --> delivered[回传签收状态]
    cancel --> refund[释放支付预授权]
  end
  lock --> stock
  pick --> pay
  delivered -.->|通知| submit
```

## 异步支付与库存校验

在并发段增加一条优惠券校验。再暂时删掉与 `loop` 配对的 `end`，看错误行号和上次预览，补回后确认图恢复。

```mermaid
sequenceDiagram
  autonumber
  actor C as 顾客
  participant G as API 网关
  participant O as 订单服务
  participant I as 库存服务
  participant P as 支付服务
  participant Q as 消息队列
  C->>G: 提交订单与幂等键
  G->>O: 创建草稿订单
  activate O
  par 锁定库存
    O->>I: 按仓拆分并预占
    I-->>O: 返回预占编号
  and 检查支付
    O->>P: 检查通道与币种
    P-->>O: 返回可用方式
  end
  alt 两项校验通过
    loop 最多重试三次
      O->>P: 发起扣款
      P-->>O: 返回扣款状态
    end
    O->>Q: 发布订单支付事件
    Q-->>O: 确认事件入队
    O-->>G: 返回订单号
  else 任一校验失败
    O->>I: 释放已有预占
    O-->>G: 返回失败原因
  end
  deactivate O
  G-->>C: 展示结果
  Note over O,Q: 重试必须复用原幂等键
```

## 内容审核与发布状态

在「人工审核」后加入「法务审核」。再给「已发布」加一个返回草稿的回滚路径。

```mermaid
stateDiagram-v2
  state "草稿" as Draft
  state "已发布" as Published
  state "已归档" as Archived
  state "审核中" as Review {
    state "自动检查" as Check
    state "人工审核" as Manual
    state "等待补充" as Waiting
    state verdict <<choice>>
    [*] --> Check
    Check --> verdict : 规则检查完成
    verdict --> Manual : 命中风险规则
    verdict --> [*] : 无风险
    Manual --> Waiting : 需要说明
    Waiting --> Manual : 已补充
    Manual --> [*] : 审核通过
  }
  [*] --> Draft
  Draft --> Review : 提交
  Review --> Draft : 撤回或驳回
  Review --> Published : 审核通过并发布
  Published --> Archived : 下架归档
  Archived --> Draft : 从历史版本恢复
  Archived --> [*] : 到期清理
```

## 工单、评论与协作者

给评论增加一个指向父评论的关系。再给协作者表增加一个带 `UK` 的成员键，核对实体字段和连线随修改更新。

```mermaid
erDiagram
  direction LR
  WORKSPACE ||--o{ PROJECT : 管理
  PROJECT ||--o{ TICKET : 包含
  TICKET ||--o{ COMMENT : 记录
  TICKET ||--o{ TICKET_LABEL : 标记
  LABEL ||--o{ TICKET_LABEL : 用于
  USER ||--o{ COMMENT : 撰写
  USER ||--o{ MEMBER : 加入
  PROJECT ||--o{ MEMBER : 授权
  TICKET ||--o{ EVENT : 生成
  USER o|--o{ EVENT : 触发
  TICKET {
    uuid id PK
    uuid project_id FK
    string title
    string status
    datetime updated_at
  }
  COMMENT {
    uuid id PK
    uuid ticket_id FK
    uuid author_id FK
    string body
  }
  MEMBER {
    uuid project_id PK, FK
    uuid user_id PK, FK
    string role
  }
  TICKET_LABEL {
    uuid ticket_id PK, FK
    uuid label_id PK, FK
  }
  EVENT {
    uuid id PK
    uuid ticket_id FK
    uuid actor_id FK
    string action
    datetime occurred_at
  }
```
