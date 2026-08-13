# 设计基线索引

本目录记录 MVP 的已确认决策。修改基线时应同时检查产品范围、架构、Schema、API 和验收条件，避免只修改单个视图后产生矛盾。

| 文档                                                                                     | 说明                                     | 状态   |
| ---------------------------------------------------------------------------------------- | ---------------------------------------- | ------ |
| [产品范围](product/product-baseline.md)                                                  | 用户、目标、范围、核心流程和非目标       | 已确认 |
| [系统架构](architecture/system-architecture.md)                                          | 组件、部署、运行链路、安全与故障恢复     | 已确认 |
| [数据模型](architecture/data-model.md)                                                   | 核心实体、关系、状态和保留策略           | 已确认 |
| [用例模型](specs/test-case-schema.md)                                                    | 用例 DSL、变量、步骤、断言和清理语义     | 已确认 |
| [适配器协议](specs/adapter-protocol.md)                                                  | 通用平台与被测系统插件之间的契约         | 已确认 |
| [API 基线](api/openapi.yaml)                                                             | 第一版外部及控制台 API                   | 已确认 |
| [页面线框](ui/wireframes.md)                                                             | 八个 MVP 页面及主操作流                  | 已确认 |
| [MVP 里程碑](roadmap/mvp-plan.md)                                                        | 实施顺序、交付物和退出条件               | 已确认 |
| [验收清单](quality/acceptance.md)                                                        | 功能、可靠性、安全和首个适配器验收       | 已确认 |
| [星火 Agent 案例目录](quality/spark-x-agent-case-catalog.md)                             | 首批 32 个 P0/P1 回归场景                | 已确认 |
| [本地开发指南](development/getting-started.md)                                           | M1工具链、启动方式和目录职责             | M1     |
| [M1冒烟检查](operations/m1-smoke-check.md)                                               | 部署后依赖、迁移、队列和故障探针验证     | M1     |
| [M1 测试环境验证记录](operations/m1-test-environment-verification-2026-08-13.md)         | `192.168.110.136` 首次部署与故障恢复证据 | 已通过 |
| [M2 测试环境验证记录](operations/m2-test-asset-control-plane-verification-2026-08-13.md) | 测试资产控制面、API、页面与安全回归证据  | 已通过 |
