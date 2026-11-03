# RVC 推理驱动（流萤模型 liuying.pth）：把一段人声换成她的音色。
# 用法： python cover.py <输入音频> <输出wav> [pitch] [f0_method]
import os
import shutil
import sys
import traceback

SING = os.path.dirname(os.path.abspath(__file__))
os.chdir(SING)                 # rvc_cli 用 cwd 解析模型路径
sys.path.insert(0, os.path.join(SING, "rvc_cli"))

# rmvpe 期望在 <cwd>/rvc_cli/rvc/models/predictors/rmvpe.pt
rmvpe_target = os.path.join(SING, "rvc_cli", "rvc", "models", "predictors", "rmvpe.pt")
rmvpe_src = os.path.join(SING, "model", "rmvpe.pt")
os.makedirs(os.path.dirname(rmvpe_target), exist_ok=True)
if not os.path.exists(rmvpe_target) and os.path.exists(rmvpe_src):
    shutil.copyfile(rmvpe_src, rmvpe_target)

from rvc_cli.rvc.infer.infer import VoiceConverter  # noqa: E402

def main():
    src = os.path.abspath(sys.argv[1])
    dst = os.path.abspath(sys.argv[2])
    pitch = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    f0_method = sys.argv[4] if len(sys.argv) > 4 else "rmvpe"
    model = os.path.join(SING, "model", "liuying.pth")

    # faiss 的 C++ 层读不了非 ASCII 路径。索引若在中文目录下，先复制到临时 ASCII 路径再用。
    def _ascii_index_path(index_path):
        if not os.path.exists(index_path):
            return ""
        if all(ord(ch) < 128 for ch in os.path.abspath(index_path)):
            return os.path.abspath(index_path)
        import hashlib
        import tempfile
        tag = hashlib.md5(os.path.abspath(index_path).encode("utf-8")).hexdigest()[:8]
        cache = os.path.join(tempfile.gettempdir(), "rvc-index")
        os.makedirs(cache, exist_ok=True)
        dst_index = os.path.join(cache, "voice-%s.index" % tag)
        if not os.path.exists(dst_index) or os.path.getmtime(dst_index) < os.path.getmtime(index_path):
            shutil.copyfile(index_path, dst_index)
        return dst_index

    index_path = _ascii_index_path(os.path.join(SING, "model", "liuying.index"))

    conv = VoiceConverter()
    print("[1/2] loading hubert ...", flush=True)
    conv.load_hubert("contentvec")
    print("[2/2] converting ...", flush=True)
    conv.convert_audio(
        audio_input_path=src,
        audio_output_path=dst,
        model_path=model,
        index_path=index_path,
        pitch=pitch,
        f0_method=f0_method,
        index_rate=0.75 if index_path else 0.0,
        volume_envelope=1,
        protect=0.5,
        hop_length=64,
        split_audio=False,
        f0_autotune=False,
        embedder_model="contentvec",
        clean_audio=False,
        export_format="WAV",
        sid=0,
    )
    print("OK ->", dst, os.path.getsize(dst), "bytes", flush=True)

try:
    main()
except Exception:
    traceback.print_exc()
    sys.exit(1)
