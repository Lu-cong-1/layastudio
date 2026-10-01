"""LayaStudio 启动入口。

用法：python main.py [--host 127.0.0.1] [--port 9527] [--data-dir 数据目录]
打包为 exe 后运行时，数据目录默认落在 exe 同级的 data\\ 文件夹。
"""

import os
import sys

if getattr(sys, "frozen", False):
    # 单文件 exe 解压在临时目录：把数据目录固定到 exe 同级，重开不丢历史
    os.environ.setdefault(
        "LAYASTUDIO_DATA_DIR",
        os.path.join(os.path.dirname(sys.executable), "data"),
    )

from layastudio.server import main

if __name__ == "__main__":
    main()
