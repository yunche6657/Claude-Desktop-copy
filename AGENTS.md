# Windows 测试

运行 Node 测试统一使用 `npm test`，指定文件使用 `npm test -- test/example.test.mjs`。
该入口限制文件并发为 2，并通过测试专用 preload 隐藏工作进程和辅助命令的控制台。
不要绕过入口批量执行裸 `node --test`；这曾导致大量控制台连续弹出、抢占焦点。
测试专用的隐藏窗口设置不应写入系统级或用户级 `NODE_OPTIONS`。


## 测量检查清单

在把任何量化结论写进 evidence/ 之前，先读 evidence/MEASUREMENT-CHECKLIST.md。那八条规则各对应 R621–R632 里的一次实测失败，主题是：仪器是对的，读数是错的。
