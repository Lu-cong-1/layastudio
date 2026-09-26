"""测试全局约束：强制 mock 后端，保证测试离线、确定、快速。

laya 安装后 backend=auto 会构造真实 Router（拉 torch、可能碰网络），
所有测试默认走 mock；个别测试如需真实后端应显式覆盖该环境变量。
"""

import os

os.environ["LAYASTUDIO_BACKEND"] = "mock"
