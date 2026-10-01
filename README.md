# LayaStudio

**Laya System-1 决策模型 · 本地可视化工作台**

LayaStudio 是一个跑在你自己电脑上的决策模型调试台。它把 Laya 模型的输入（业务文本 + 判断问题）做成可视化表单，点一下就能看到分类、打分与是非判断的结果，还能记录历史、批量评估和导出微调数据。

不需要写代码，不需要手拼 JSON，普通用户填表单即可；开发者可以用它暴露的 HTTP API 直接对接自己的 Agent。

---

## 能做什么

| 功能 | 说明 |
|---|---|
| **调试台** | 填表单 → 选任务类型（分类 / 打分 / 是非 / 批量）→ 一键推理，看置信度与概率分布 |
| **观测台** | 实时延迟曲线、路由分布、意图统计、请求量、事件流 |
| **模型管理** | 下载 / 加载 / 卸载 Laya checkpoint，查看显存占用与温度校准状态 |
| **推理历史** | 每次决策落库 SQLite，可搜索、回放、导出微调数据集 |
| **批量评估** | 带标注的数据集 → 逐条预测 → 准确率、混淆矩阵、错误归因 |
| **日志** | 服务运行日志，分级查看、一键导出 |
| **Jev 兼容 API** | `POST /v1/systemone` 可直接被 Agent 客户端调用 |

### 界面截图

> 截图位置（发布前替换为真实截图）：
>
> | 预览 | 文件建议路径 |
> |---|---|
> | 调试台（表单 + 结果） | `docs/screenshot-playground.png` |
> | 观测台（延迟 / 路由） | `docs/screenshot-monitor.png` |
> | 模型管理 | `docs/screenshot-models.png` |
> | 批量评估 | `docs/screenshot-eval.png` |
> | 首次使用引导 | `docs/screenshot-onboard.png` |

---

## 快速开始（本地运行）

### 环境要求

- **Python 3.10 或更高**（推荐 3.11）
- Windows / macOS / Linux 均可
- 不装显卡也能跑：默认使用 **Mock 后端**（关键词启发式，纯演示）；要跑真实模型见下文「本地 Laya 模型部署」

### 方式一：Windows 一键启动

双击或在命令行运行：

```bat
run.bat
```

首次运行会自动创建虚拟环境并安装依赖，然后启动服务。

### 方式二：手动安装（所有平台）

```bash
# 1. 创建虚拟环境
python -m venv .venv

# 2. 激活虚拟环境
# Windows:
.venv\Scripts\activate
# macOS / Linux:
source .venv/bin/activate

# 3. 安装依赖
pip install -r requirements.txt

# 4. 启动
python main.py
```

看到下面这行输出就成功了：

```
LayaStudio v0.1.0 → http://127.0.0.1:9527
```

浏览器打开 **http://127.0.0.1:9527** 即可使用。

### 常用启动参数

```bash
python main.py --port 8080            # 换端口
python main.py --host 0.0.0.0         # 允许局域网访问
python main.py --data-dir D:\ls-data  # 指定数据目录（历史/设置/导出）
python main.py --log-level debug      # 调低日志级别
```

也可以用 `python -m layastudio` 启动，效果完全一样。

---

## 用打包好的 exe 启动

如果你拿到了 `LayaStudio.exe`（单文件绿色版）：

1. 把 exe 放到任意目录（建议单独建一个文件夹）
2. **双击运行** 即可，无需安装 Python
3. 浏览器打开它打印的地址（默认 `http://127.0.0.1:9527`）
4. 运行产生的数据（历史、设置、导出）默认放在 exe 同目录的 `data\` 文件夹

> **注意**：exe 版默认也是 Mock 后端。要用真实模型，需要把 laya 与 torch 安装到 exe 同目录的 `python` 环境，或改用源码方式运行（见下节）。

### 自己打包 exe（可选）

```bash
pip install pyinstaller
pyinstaller --onefile --name LayaStudio main.py
```

打包产物在 `dist\LayaStudio.exe`。`build/`、`dist/`、`*.exe` 已在 `.gitignore` 中排除，不会上传到仓库。

---

## 本地 Laya 模型部署（真实推理）

默认的 Mock 后端只是演示用的关键词匹配，**不是真实模型**。要跑真正的 Laya 决策模型：

### 1. 安装 Laya 运行时

```bash
pip install laya
```

### 2. 启动后会自动识别

LayaStudio 启动时会检测 `laya` 是否可用：

- 检测到 → 后端显示 `laya`，可下载 / 加载真实 checkpoint
- 没检测到 → 自动回落 `mock`，界面顶部会显示黄色提示条

也可以在「设置」页手动切换后端：`auto` / `laya` / `mock`。

### 3. 下载模型权重

**重要：模型权重文件很大（每个约 650MB–850MB），不会放进本仓库，需要你自己下载。**

打开「模型」页，点击对应卡片的 **下载** 按钮即可。三个官方 checkpoint：

| Key | 仓库 | 大小 | 适用场景 |
|---|---|---|---|
| `english` | `convaiinnovations/laya` | 约 810 MB | 英文主力模型 |
| `multilingual` | `convaiinnovations/laya-multilingual` | 约 650 MB | 100+ 语言 |
| `typed-decisions` | `convaiinnovations/laya-typed-decisions` | 约 850 MB | 工作流微调版 |

下载默认走国内镜像 `https://hf-mirror.com`（可在「设置」改），存到 HuggingFace 本地缓存：

```
~/.cache/huggingface/hub/models--convaiinnovations--laya...
```

Windows 上通常是 `C:\Users\你的用户名\.cache\huggingface\hub\`。

### 4. 手动放置权重（可选）

如果你从别的机器拷贝了权重，放到上面的缓存目录结构即可；或者把整个下载好的文件夹放在任意位置，然后在「模型」页识别（安装标记文件写在 `data/models/` 下）。

**这些权重文件（`*.safetensors` / `*.bin` / `*.pt` 等）绝不要提交到 GitHub。**

### 5. 加载进显存

下载完成后点 **加载**，模型会进入显存；点 **卸载** 释放。观测台顶部能看到显存占用变化。

> 无 GPU 也能跑：在「设置」把 `device` 留空或填 `cpu`，速度慢一些但功能完整。

---

## 三种决策任务类型

| 类型 | 用途 | 例子 |
|---|---|---|
| **Choice 分类** | 多选一归类 | 这条工单归 billing / technical / sales / other？ |
| **Score 打分** | 等级评分 | 这件事有多紧急？（不紧急 → 紧急阻断） |
| **Noul 是非** | 真假 / 是否判断 | 用户是否威胁取消？（概率 0–1） |

一题只判断一件事。复杂场景请拆成多题，结果在你的代码里组合，这是官方推荐的「原子问题」用法。

---

## HTTP API（给开发者）

服务启动后，除了网页界面，还提供 REST 接口：

```bash
# 健康检查
curl http://127.0.0.1:9527/health

# 决策推理（Jev 兼容端点，Agent 可直接调用）
curl -X POST http://127.0.0.1:9527/v1/systemone \
  -H 'Content-Type: application/json' \
  -d '{
    "state": "用户来信：被重复扣款两次，请今天退款，否则不续费。",
    "questions": {
      "department": {
        "type": "choice",
        "instructions": "该工单由哪个部门处理？",
        "criteria": {
          "billing": "发票、支付、退款",
          "technical": "故障、宕机、报错",
          "other": "其他"
        }
      }
    }
  }'
```

返回里 `answers` 是每个问题的判断结果，`confidence` 是置信度（0–1，越高越确定），`probabilities` 是完整概率分布。

完整接口列表见启动后的 `http://127.0.0.1:9527/docs`（FastAPI 自带文档）。

---

## 运行测试

```bash
pip install pytest
python -m pytest tests/ -q
```

---

## 目录结构

```
layastudio/          Python 后端（FastAPI 服务、推理引擎、存储、评估）
  adapter.py         决策适配层：校验 + Mock/Laya 双后端 + Engine
  server.py          HTTP 路由与启动入口
  store.py           SQLite 持久层
  model_manager.py   模型下载 / 加载 / 温度校准
  evals.py           批量评估
  ...
js/app.js            前端交互逻辑
css/app.css          样式
index.html           单页界面
tests/               pytest 测试
datasets/            示例数据集
main.py              启动入口（python main.py）
run.bat              Windows 一键启动
```

---

## 开源协议

本项目采用 [MIT License](LICENSE)。

Laya 模型权重由 [convaiinnovations](https://huggingface.co/convaiinnovations) 发布，其使用请遵守 HuggingFace 仓库页标注的对应许可。

---

## 常见问题

**Q：启动后页面打不开？**
A：看命令行打印的地址，确认端口没被占用；换端口用 `python main.py --port 8080`。

**Q：模型下载很慢？**
A：「设置」里 `HF 镜像` 保持 `https://hf-mirror.com`（国内推荐）。下载是后台进行的，模型页能看到进度。

**Q：界面提示「Mock 后端」？**
A：说明没检测到 `laya`。`pip install laya` 后重启即可；或者本来就想用演示模式，忽略即可。

**Q：能把数据放到别的盘吗？**
A：`python main.py --data-dir D:\ls-data`，或设环境变量 `LAYASTUDIO_DATA_DIR`。

**Q：支持中文吗？**
A：支持，但 Laya 原生英文效果最好。中文场景请先在「评估」页用真实样本批量评估，达标后再正式使用。
