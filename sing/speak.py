# 文字 → Edge-TTS 朗读 → RVC 换音色（流萤）→ 最终 wav
# 用法： python speak.py <文字> [输出wav] [voice] [pitch]
# ponytail: 说话专用参数写死在 DEFAULT_PARAMS 里，cover.py 默认参数不动；
#   直接 import VoiceConverter 绕开 subprocess，参数控制权完全在这一层。
import asyncio
import os
import sys
import tempfile
import traceback

SING = os.path.dirname(os.path.abspath(__file__))
os.chdir(SING)
sys.path.insert(0, os.path.join(SING, "rvc_cli"))

# rmvpe 期望在 <cwd>/rvc_cli/rvc/models/predictors/rmvpe.pt
import shutil
rmvpe_target = os.path.join(SING, "rvc_cli", "rvc", "models", "predictors", "rmvpe.pt")
rmvpe_src = os.path.join(SING, "model", "rmvpe.pt")
os.makedirs(os.path.dirname(rmvpe_target), exist_ok=True)
if not os.path.exists(rmvpe_target) and os.path.exists(rmvpe_src):
    shutil.copyfile(rmvpe_src, rmvpe_target)

# ── 说话专用 RVC 参数（区别于 cover.py 给唱歌的硬编码默认值） ──
DEFAULT_PARAMS = dict(
    pitch=0,            # 说话不转调
    f0_method="rmvpe",  # fcpe.pt 没装；rmvpe 唱歌说话都够用
    protect=0.7,        # 说话清辅音多，调高保护防止吃音（唱歌是 0.5）
    index_rate=0.5,     # 说话不用那么强的音色匹配（唱歌是 0.75）
    volume_envelope=1,
    hop_length=64,
    split_audio=False,
    f0_autotune=False,
    embedder_model="contentvec",
    clean_audio=True,   # 无害，Edge-TTS 本身干净；留个钩子以后换源时能用上
    export_format="WAV",
    sid=0,
)

# ── 工具函数 ──
def _ascii_index_path(index_path):
    """faiss 的 C++ 层读不了非 ASCII 路径。"""
    if not os.path.exists(index_path):
        return ""
    if all(ord(ch) < 128 for ch in os.path.abspath(index_path)):
        return os.path.abspath(index_path)
    import hashlib
    tag = hashlib.md5(os.path.abspath(index_path).encode("utf-8")).hexdigest()[:8]
    cache = os.path.join(tempfile.gettempdir(), "rvc-index")
    os.makedirs(cache, exist_ok=True)
    dst_index = os.path.join(cache, "voice-%s.index" % tag)
    if not os.path.exists(dst_index) or os.path.getmtime(dst_index) < os.path.getmtime(index_path):
        shutil.copyfile(index_path, dst_index)
    return dst_index

def default_output_path():
    """默认落到 audio/ 目录（和 qq_send_voice 的语音库同位置），文件名 speak-时间戳.wav"""
    root = os.path.dirname(SING)  # d:\qq-bridge
    import datetime
    name = "speak-%s.wav" % datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    # 先尝试 d:\qq-bridge\audio，不存在就退到 sing\work
    for d in (os.path.join(root, "audio"), os.path.join(SING, "work")):
        if os.path.isdir(d):
            return os.path.join(d, name)
    os.makedirs(os.path.join(SING, "work"), exist_ok=True)
    return os.path.join(SING, "work", name)

async def _tts(text, mp3_path, voice):
    import edge_tts
    await edge_tts.Communicate(text, voice).save(mp3_path)

# ── 主流程 ──
def main():
    if len(sys.argv) < 2:
        print("用法: python speak.py <文字> [输出wav] [voice] [pitch]")
        sys.exit(1)

    text = sys.argv[1]
    dst = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else default_output_path()
    voice = sys.argv[3] if len(sys.argv) > 3 else "zh-CN-XiaoxiaoNeural"
    pitch = int(sys.argv[4]) if len(sys.argv) > 4 else DEFAULT_PARAMS["pitch"]

    # 确保输出目录存在
    os.makedirs(os.path.dirname(dst), exist_ok=True)

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp_mp3 = tmp.name

    try:
        print("[1/2] edge-tts:", text[:40], "...", flush=True)
        asyncio.run(_tts(text, tmp_mp3, voice))
        if not os.path.exists(tmp_mp3) or os.path.getsize(tmp_mp3) < 100:
            raise RuntimeError("edge-tts 没出音频")

        print("[2/2] RVC convert (说话参数: protect=%.1f, index_rate=%.2f) ..." % (
            DEFAULT_PARAMS["protect"], DEFAULT_PARAMS["index_rate"]), flush=True)

        # 直接 import VoiceConverter，绕开 subprocess cover.py
        from rvc_cli.rvc.infer.infer import VoiceConverter

        index_path = _ascii_index_path(os.path.join(SING, "model", "liuying.index"))
        model = os.path.join(SING, "model", "liuying.pth")

        conv = VoiceConverter()
        conv.load_hubert("contentvec")
        conv.convert_audio(
            audio_input_path=tmp_mp3,
            audio_output_path=dst,
            model_path=model,
            index_path=index_path,
            index_rate=DEFAULT_PARAMS["index_rate"] if index_path else 0.0,
            pitch=pitch,
            f0_method=DEFAULT_PARAMS["f0_method"],
            protect=DEFAULT_PARAMS["protect"],
            volume_envelope=DEFAULT_PARAMS["volume_envelope"],
            hop_length=DEFAULT_PARAMS["hop_length"],
            split_audio=DEFAULT_PARAMS["split_audio"],
            f0_autotune=DEFAULT_PARAMS["f0_autotune"],
            embedder_model=DEFAULT_PARAMS["embedder_model"],
            clean_audio=DEFAULT_PARAMS["clean_audio"],
            export_format=DEFAULT_PARAMS["export_format"],
            sid=DEFAULT_PARAMS["sid"],
        )

        if not os.path.exists(dst) or os.path.getsize(dst) < 1000:
            raise RuntimeError("RVC 转换失败：输出文件为空")

        print("OK ->", dst, os.path.getsize(dst), "bytes", flush=True)
    finally:
        try:
            os.unlink(tmp_mp3)
        except OSError:
            pass

try:
    main()
except Exception:
    traceback.print_exc()
    sys.exit(1)
