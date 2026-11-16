r"""Dola Toolkit — RVC 推理桥

由插件的 Node 主进程调用（不落盘到用户的 RVC 目录，用 -c 引导加载本文件）：

    runtime\python.exe -c "<bootstrap>"   # 内部调用 run_job(job_path, root)

调试时也可以直接命令行跑：

    runtime\python.exe rvc_bridge.py --job job.json --root <RVC 根目录>

为什么是独立脚本而不是长驻服务：
  · RVC 的模型加载很重（hubert + rmvpe + 声码器），但一次调用通常就跑完；
  · 长驻服务要自己管生命周期、端口、崩溃重启，对一个本地工具是过度设计；
  · 冷启动多花的是几秒，换来的是「跑完就退出、不留后台进程」。

job.json 的输入/输出都是 JSON，stdout 只输出一行 `RESULT {…}`，其余日志走 stderr，
这样 Node 侧解析不会和第三方库的打印混在一起。
"""

import argparse
import json
import os
import sys
import traceback


def emit(payload, code=0):
    """把结果写回给 Node，然后退出。"""
    sys.stdout.write("RESULT " + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def tmp_dir_for_cache(root):
    """numba 缓存目录的根：优先用环境变量指定的（插件数据目录），其次 RVC 的 TEMP。"""
    explicit = os.environ.get("DOLA_CACHE_DIR")
    if explicit:
        return explicit
    return os.path.join(root, "TEMP")


def setup_env(root):
    """配好 RVC 运行期需要的环境变量。

    这些原本由 `webui.py` 在启动时 `setdefault`，我们绕开 WebUI 直接调推理，
    就必须自己补齐 —— 否则 pipeline 里 `os.environ["rmvpe_root"]` 会直接 KeyError。
    全部用 setdefault，让调用方仍可覆盖。

    最要紧的是 `NUMBA_CACHE_DIR`：numba 默认把 JIT 缓存放在**源文件旁边**
    （site-packages），而 Electron 派生的子进程对那里只有读权限。后果有两种，
    都很隐蔽：

      · `ensure_cache_path()` 里的 `TemporaryFile()` 探测**永久挂起**，不报错；
      · 或者 locator 判定不可用，numba 抛 "cannot cache function ... no locator available"。

    两者都表现为"RVC 推理没反应"，而同一份代码从命令行跑只要 10 秒。
    设了 NUMBA_CACHE_DIR 之后，numba 改用 UserProvidedCacheLocator 把缓存写到
    可写目录，问题消失。必须在 numba 被导入之前设置。
    """
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    os.environ.setdefault("no_proxy", "localhost, 127.0.0.1, ::1")
    os.environ.setdefault("weight_root", os.path.join(root, "assets", "weights"))
    os.environ.setdefault("weight_pymss_root", os.path.join(root, "assets", "pymss_weights"))
    os.environ.setdefault("index_root", os.path.join(root, "logs"))
    os.environ.setdefault("outside_index_root", os.path.join(root, "assets", "indices"))
    os.environ.setdefault("rmvpe_root", os.path.join(root, "assets", "rmvpe"))
    # 离线工具默认不开 CUDA Graph，和 WebUI 保持一致
    os.environ.setdefault("RVC_CUDA_GRAPH", "0")

    cache_dir = os.path.normpath(os.path.join(tmp_dir_for_cache(root), "numba-cache"))
    try:
        os.makedirs(cache_dir, exist_ok=True)
        probe = os.path.join(cache_dir, "probe.tmp")
        with open(probe, "wb") as f:
            f.write(b"ok")
        os.unlink(probe)
        os.environ["NUMBA_CACHE_DIR"] = cache_dir
    except Exception:
        os.environ.pop("NUMBA_CACHE_DIR", None)

    tmp = pick_writable_temp(os.path.join(root, "TEMP"))
    os.environ["TEMP"] = tmp
    os.environ["TMP"] = tmp



def pick_writable_temp(preferred):
    """挑一个能写的临时目录，**不调用 tempfile.mkstemp**。

    注意：这里刻意用 `open()` 试探可写性。`tempfile.mkstemp()` 在 Electron 派生的
    子进程里会永久挂起（实测 45 秒不返回，且不抛错），而它正是 numba 缓存初始化时
    调用的函数 —— 所以任何"用 mkstemp 探路"的代码本身就会卡死。
    """
    candidates = [
        preferred,
        os.path.join(os.environ.get("LOCALAPPDATA") or "", "Temp"),
        os.environ.get("TEMP") or "",
        os.environ.get("TMP") or "",
        "C:\\Windows\\Temp",
    ]
    for path in candidates:
        if not path:
            continue
        try:
            os.makedirs(path, exist_ok=True)
            probe = os.path.join(path, "dola-write-probe.tmp")
            with open(probe, "wb") as f:
                f.write(b"ok")
            os.unlink(probe)
            return path
        except Exception:
            continue
    return os.environ.get("TEMP") or os.getcwd()


def run_selftest(job, root):
    """逐步自检：在"当前这个进程环境"里测每一段耗时。

    用来定位"命令行很快、从 Electron 里很慢"这类差异 —— 不猜，直接量。
    """
    import time

    out = []
    vc_obj = {}
    def mark(label, fn):
        t = time.time()
        try:
            value = fn()
            out.append({"step": label, "ms": int((time.time() - t) * 1000), "ok": True, "value": value})
            return value
        except Exception as e:
            out.append({"step": label, "ms": int((time.time() - t) * 1000), "ok": False, "error": f"{type(e).__name__}: {e}"})
            raise

    os.chdir(root)
    _stamp("selftest: begin")

    # 与 run_convert 保持一致：先关掉 cuDNN autotune
    try:
        import torch

        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
        _stamp("selftest: cudnn benchmark=off")
    except Exception as e:
        _stamp(f"selftest: cudnn setup skipped: {e}")

    # 1) 纯 torch 的 GPU 运算，排除 RVC 代码
    def torch_matmul():
        import torch
        if not torch.cuda.is_available():
            return "no cuda"
        a = torch.randn(2048, 2048, device="cuda")
        for _ in range(10):
            a = a @ a
        torch.cuda.synchronize()
        return f"10x matmul on {torch.cuda.get_device_name(0)}"

    mark("torch::import", lambda: __import__("torch").__version__)
    mark("torch::cuda_is_available", lambda: bool(__import__("torch").cuda.is_available()))
    mark("torch::device_count", lambda: int(__import__("torch").cuda.device_count()))
    mark("torch::matmul", torch_matmul)

    # STFT / FFT：RMVPE 的 mel 提取器第一步就是 torch.stft。cuFFT 计划初始化在
    # 某些进程环境里会阻塞，这正好对应"卡在 rmvpe start"。
    def torch_stft():
        import torch

        x = torch.randn(16000, device="cuda" if torch.cuda.is_available() else "cpu")
        w = torch.hann_window(1024, device=x.device)
        out = torch.stft(x, 1024, 160, window=w, return_complex=True)
        if x.is_cuda:
            torch.cuda.synchronize()
        return f"stft {tuple(out.shape)}"

    mark("torch::stft", torch_stft)

    # librosa（RMVPE 的 mel 提取器依赖它）首次导入会初始化 numba JIT，可能在受限进程里
    # 长时间阻塞。单独计时，好和 RVC 自己的代码分开。
    def import_librosa():
        import librosa

        f = librosa.filters.mel(sr=16000, n_fft=1024, n_mels=128)
        return f"mel basis {f.shape}"

    mark("librosa::import+melbasis", import_librosa)
    # configs.config 在**导入时**就查询 CUDA 并做 cuda-graph 探测，单独计时
    mark("config::import", lambda: (__import__("configs.config", fromlist=["x"]) and "ok"))

    # 模型文件读取：确认不是 IO 层的问题
    def read_model_file():
        import time as _t

        p = os.path.join(root, "assets", "hubert_base", "pytorch_model.bin")
        t = _t.time()
        with open(p, "rb") as f:
            data = f.read()
        return f"{len(data) // 1048576} MB in {int((_t.time() - t) * 1000)} ms"

    mark("io::read_hubert", read_model_file)

    # Config() 构造：module 已经导入过，这里只测对象创建
    def build_config():
        from configs.config import Config

        c = Config()
        return f"device={c.device} half={c.is_half}"

    mark("config::Config()", build_config)

    # 2) ffmpeg 管道读取（RVC 的 load_audio 第一步）
    def ffmpeg_read():
        import subprocess
        src = job.get("inputPath")
        if not src or not os.path.exists(src):
            return "skipped (no input)"
        ff = os.path.join(root, "ffmpeg.exe")
        p = subprocess.Popen(
            [ff, "-v", "error", "-i", src, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        data, err = p.communicate(timeout=60)
        return f"{len(data)} bytes, err={len(err)}"

    mark("ffmpeg::pipe", ffmpeg_read)

    # 3) RVC 自己的 load_audio
    def rvc_load():
        from infer.audio import load_audio
        a = load_audio(job["inputPath"], 16000)
        return f"numpy {getattr(a, 'shape', None)} dtype {getattr(a, 'dtype', None)}"

    mark("rvc::load_audio", rvc_load)

    # 4) 只跑音高提取（vc_single 内部的第一步重活）
    def f0_only():
        import numpy as np

        _stamp("get_f0: load_audio start")
        from infer.audio import load_audio

        audio = load_audio(job["inputPath"], 16000)
        _stamp("get_f0: load_audio done")
        audio = np.asarray(audio, dtype=np.float32)
        p_len = audio.shape[0] // 160
        audio_pad = np.pad(audio, (160, 160), mode="reflect")

        # 手工复现 get_f0 的 rmvpe 分支，好把"构造 RMVPE"和"推理"分开计时 ——
        # 两者都慢就没意义，必须知道是哪一步。
        _stamp("rmvpe: construct start")
        from infer.rmvpe import RMVPE

        pipe = vc_obj["vc"].pipeline
        pipe.model_rmvpe = RMVPE(
            os.path.join(os.environ["rmvpe_root"], "rmvpe.pt"),
            is_half=pipe.is_half,
            device=pipe.device,
        )
        _stamp("rmvpe: construct done")
        f0 = pipe.model_rmvpe.infer_from_audio(audio, thred=0.03)
        _stamp("rmvpe: infer done")
        return f"f0 {getattr(f0, 'shape', None)}"

    # 先拿到 vc 实例（run_convert 内部会建，这里单独建一次用于分步测量）
    saved_argv = sys.argv
    sys.argv = [saved_argv[0]]
    try:
        _stamp("selftest: import VC")
        from configs.config import Config
        from infer.vc.modules import VC

        _stamp("selftest: Config()")
        cfg = Config()
        _stamp("selftest: VC(cfg)")
        vc = VC(cfg)
        os.environ["weight_root"] = os.path.dirname(job["modelPath"])
        _stamp("selftest: get_vc start")
        vc.get_vc(os.path.basename(job["modelPath"]))
        _stamp("selftest: get_vc done")
        vc_obj["vc"] = vc
    finally:
        sys.argv = saved_argv

    mark("rvc::get_f0", f0_only)

    # 5) 一次完整推理
    def full_convert():
        r = run_convert(job, root)
        return r.get("ok")

    mark("rvc::convert", full_convert)

    _stamp("selftest: done")
    return {"ok": True, "steps": out}


def run_job(job_path, root=None):
    """按 job 文件执行，并把结果用 emit() 写回。

    这是被 Node 侧引导代码调用的入口（脚本本身不落盘到用户的 RVC 目录，
    所以不走 argparse 那条命令行路径）。
    """
    with open(job_path, "r", encoding="utf-8") as f:
        job = json.load(f)

    root = root or os.getcwd()
    if root not in sys.path:
        sys.path.insert(0, root)
    os.chdir(root)
    setup_env(root)

    mode = job.get("mode", "convert")
    try:
        if mode == "convert":
            emit(run_convert(job, root))
        elif mode == "separate":
            emit(run_separate(job, root))
        elif mode == "selftest":
            emit(run_selftest(job, root))
        elif mode == "probe":
            emit(run_probe(job, root))
        else:
            emit({"ok": False, "error": f"未知模式：{mode}"}, 2)
    except SystemExit:
        raise
    except Exception as e:
        log_traceback()
        emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


def main():
    r"""命令行入口（调试用）。

    参数既可以用 `--job xxx --root yyy`，也可以用环境变量
    `DOLA_JOB` / `DOLA_RVC_ROOT`。后者更重要：`configs/config.py` 在**导入时**
    会用自己的 argparse 解析 `sys.argv`，任何我们不认识的参数都会让它报错退出。
    用环境变量传参就不会和它抢 argv。
    """
    job_env = os.environ.get("DOLA_JOB")
    root_env = os.environ.get("DOLA_RVC_ROOT")
    if job_env:
        run_job(job_env, root_env)
        return

    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--root", default=None, help="RVC 整合包根目录（默认取当前工作目录）")
    args = ap.parse_args()
    run_job(args.job, args.root)


def log_traceback():
    sys.stderr.write(traceback.format_exc())
    sys.stderr.flush()


# ---------------------------------------------------------------------------
# probe：检查这个运行时能不能用（torch、cuda、必需模型）
# ---------------------------------------------------------------------------


def run_probe(job, root=None):
    """检查这个运行时能不能用（torch、cuda、必需模型）。

    `root` 必须是**RVC 包根**，不能拿 `__file__` 推：脚本现在放在插件的 bridge 目录，
    而那绝不等于 RVC 的安装目录 —— 用错会把「模型齐全」误报成「全部缺失」。
    """
    root = root or job.get("root") or os.getcwd()
    info = {"ok": True, "python": sys.version.split()[0], "root": root}
    try:
        import torch

        info["torch"] = torch.__version__
        info["cuda"] = bool(torch.cuda.is_available())
        if info["cuda"]:
            info["device"] = torch.cuda.get_device_name(0)
    except Exception as e:
        info["torch"] = None
        info["error"] = f"torch 不可用：{e}"

    for name, rel in (
        ("hubert", os.path.join("assets", "hubert_base", "pytorch_model.bin")),
        ("rmvpe", os.path.join("assets", "rmvpe", "rmvpe.pt")),
        ("rmvpe_onnx", os.path.join("assets", "rmvpe", "rmvpe.onnx")),
        ("base40k", os.path.join("assets", "pretrained_v2", "f0G40k.pth")),
    ):
        info[name] = os.path.exists(os.path.join(root, rel))
    return info


# ---------------------------------------------------------------------------
# convert：RVC 音色转换
# ---------------------------------------------------------------------------


def _stamp(label):
    """把阶段和时间写进 stderr，方便定位"卡在哪一步"。

    stdout 留给 RESULT 协议，诊断信息一律走 stderr。
    """
    import time

    sys.stderr.write("[dola][%s] %s\n" % (time.strftime("%H:%M:%S"), label))
    sys.stderr.flush()


def run_convert(job, root):
    import numpy as np
    import soundfile as sf

    _stamp("convert: begin")

    # 推理如果卡住，把当时所有线程的调用栈打到 stderr —— 这是唯一能确定"卡在哪一行"的手段。
    # 45 秒还没跑完就 dump 一次，之后每 60 秒再 dump 一次。
    try:
        import faulthandler

        faulthandler.dump_traceback_later(
            int(os.environ.get("DOLA_STACK_DUMP_SEC", "45")), repeat=True
        )
        _stamp("convert: faulthandler armed")
    except Exception as e:
        _stamp(f"convert: faulthandler unavailable: {e}")
    # i18n 等模块用 "./i18n/locale" 这类**相对 cwd** 的路径，所以必须在导入前站到包根
    os.chdir(root)

    model_path = job["modelPath"]
    if not os.path.exists(model_path):
        return {"ok": False, "error": f"找不到音色模型：{model_path}"}
    input_path = job["inputPath"]
    if not os.path.exists(input_path):
        return {"ok": False, "error": f"找不到输入音频：{input_path}"}
    output_path = job["outputPath"]

    # configs/config.py 的 Config() 在构造函数里就调 argparse 解析**进程参数**，
    # 而我们的 argv 里有 --job；不换掉它会直接以 "unrecognized arguments" 退出。
    # cuDNN 的 autotune 会为每个卷积形状现场搜索最优算法。从 Electron 派生的进程里，
    # 这个搜索可能陷入极长的等待（实测 RMVPE 前向卡住数分钟，同样的输入命令行只要几十毫秒）。
    # 必须在加载模型之前设置，否则来不及影响第一次前向。
    try:
        import torch

        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
        _stamp("cudnn: benchmark=off deterministic=on")
    except Exception as e:
        _stamp(f"cudnn setup skipped: {e}")

    saved_argv = sys.argv
    sys.argv = [saved_argv[0]]
    try:
        _stamp("import configs/infer")
        from configs.config import Config
        from infer.vc.modules import VC

        _stamp("Config()")
        cfg = Config()
        _stamp("VC(cfg)")
        vc = VC(cfg)
        _stamp("get_vc (load ckpt + hubert + rmvpe)")
        # get_vc 自己拼 `weight_root/{sid}`，所以 sid 必须是文件名、weight_root 必须是目录。
        # 传入绝对路径会被拼成 "None/D:\..."，那是这里最容易踩的坑。
        os.environ["weight_root"] = os.path.dirname(model_path)
        vc.get_vc(os.path.basename(model_path))
        _stamp("get_vc done")
    finally:
        sys.argv = saved_argv

    _stamp("vc_single (inference)")
    index_path = job.get("indexPath") or ""

    # cuDNN 的 autotune 会为每个卷积形状现场搜索最优算法。从 Electron 派生的进程里，
    # 这个搜索可能陷入极长的等待（实测 RMVPE 前向卡住数分钟，同样的输入命令行只要几十毫秒）。
    # 关掉 benchmark 并用确定性算法，代价是首次卷积略慢一点，换来可预测的耗时。
    try:
        import torch

        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
        _stamp("cudnn: benchmark=off deterministic=on")
    except Exception as e:
        _stamp(f"cudnn setup skipped: {e}")

    # FAISS 默认开满线程（这台机器 12 个）。在 Electron 派生的子进程里，OpenMP 线程池
    # 与父进程的调度器抢核，检索会退化成龟速。这里显式限流；对单次推理来说，
    # 2 个线程和 12 个线程的实际差别可以忽略，但避免了线程池初始化卡住。
    try:
        import faiss

        faiss.omp_set_num_threads(int(os.environ.get("DOLA_FAISS_THREADS", "2")))
        _stamp(f"faiss threads = {faiss.omp_get_max_threads()}")
    except Exception as e:
        _stamp(f"faiss thread setup skipped: {e}")
    result, audio = vc.vc_single(
        0,
        input_path,
        int(job.get("pitch", 0)),
        job.get("f0Method", "rmvpe"),
        index_path,
        float(job.get("indexRate", 0.75)),
        int(job.get("resampleSr", 0)),
        float(job.get("rmsMixRate", 1.0)),
        float(job.get("protect", 0.33)),
    )

    if audio is None or (isinstance(audio, tuple) and audio[0] is None):
        # vc_single 的失败会放在第一个返回值里（一段人读的状态文本）
        return {"ok": False, "error": str(result)[:4000]}

    """
    返回值是 `(tgt_sr, audio_opt)`，但那个 tgt_sr 在这个分支里是 None ——
    真正可用的采样率在 `vc.tgt_sr`（模型自带的目标采样率）。直接用解出来的值会
    得到一个 None 采样率，写在前面就是 TypeError。
    """
    data = np.asarray(audio[1] if isinstance(audio, tuple) else audio, dtype=np.float32)
    sr = int(getattr(vc, "tgt_sr", 0) or 0)
    if sr <= 0:
        return {"ok": False, "error": f"模型没有报告采样率（tgt_sr={getattr(vc, 'tgt_sr', None)}）"}
    # 单声道是 [T]，立体声是 [C, T] —— soundfile 要的是 [T, C]
    if data.ndim > 1:
        data = data.T
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    sf.write(output_path, data, sr)
    return {
        "ok": True,
        "outputPath": output_path,
        "sampleRate": sr,
        "seconds": round(len(data) / float(sr), 2),
    }


# ---------------------------------------------------------------------------
# separate：用 pymss 分离人声 / 伴奏 / 去混响
# ---------------------------------------------------------------------------


def run_separate(job, root):
    """用 pymss 分离人声/伴奏，或去掉混响。

    pymss 的公开入口是 `MSSeparator.from_model_name()`：它能自己去模型目录找权重，
    缺失时还能按 `download` 下载（这里由插件先下好，传 download=False 以免联网）。
    `store_dirs` 决定哪些 stem 写到哪个目录 —— 只写需要的那一路，省 IO。
    """
    os.chdir(root)

    model = job["model"]
    input_path = job["inputPath"]
    output_dir = job["outputDir"]
    model_dir = job.get("modelDir") or os.path.join(root, "assets", "uvr5_weights")
    os.makedirs(output_dir, exist_ok=True)

    from tools.pymss.separator import MSSeparator  # noqa: WPS433

    def progress(payload):
        """把进度原样转给 Node（一行一个 JSON，前缀 P 便于和日志区分）。"""
        sys.stdout.write("PROGRESS " + json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    store_dirs = job.get("storeDirs") or {"vocals": output_dir}
    separator = MSSeparator.from_model_name(
        model,
        model_dir=model_dir,
        download=False,
        store_dirs=store_dirs,
        save_as_folder=bool(job.get("saveAsFolder", False)),
    )

    before = collect_audio(output_dir)
    separator.process_folder(input_path)
    after = collect_audio(output_dir)
    new_files = sorted(set(after) - set(before))
    if not new_files:
        # 有些模型会把结果写进同名子目录，回退成列出该目录下全部音频
        new_files = sorted(after)
    return {"ok": True, "outputs": new_files, "outputDir": output_dir}


def collect_audio(folder):
    """列出目录（含一层子目录）里的音频文件，用于判断本次产生了哪些结果。"""
    found = []
    if not os.path.isdir(folder):
        return found
    for name in os.listdir(folder):
        full = os.path.join(folder, name)
        if os.path.isfile(full) and name.lower().endswith((".wav", ".flac", ".mp3", ".ogg")):
            found.append(full)
        elif os.path.isdir(full):
            for sub in os.listdir(full):
                if sub.lower().endswith((".wav", ".flac", ".mp3", ".ogg")):
                    found.append(os.path.join(full, sub))
    return found


if __name__ == "__main__":
    main()
